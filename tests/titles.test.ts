import { afterEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/main/services/chat';
import { TitleService, TitleError } from '../src/main/services/titles';
import { PricingService } from '../src/main/services/pricing';
import { MemorySecretStore } from '../src/main/services/secrets';
import { ProviderStreamError, type StreamFunction } from '../src/main/services/transport';
import type { ChatStreamEvent, TitleEvent, TitleGenerationResult } from '../src/shared/types';
import {
  DEEPSEEK_USAGE_RAW,
  OPENAI_USAGE_RAW,
  createStore,
  tempDir,
  waitFor,
  waitForEvent,
} from './helpers';

const OPENAI_TITLE_USAGE = {
  input_tokens: 180,
  input_tokens_details: {
    cached_tokens: 0,
    cache_write_tokens: 0,
    cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 },
  },
  output_tokens: 12,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 192,
};

const DEEPSEEK_TITLE_USAGE = {
  prompt_tokens: 200,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 200,
  completion_tokens: 12,
  completion_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 212,
};

interface HarnessOptions {
  titleText?: string;
  titleError?: boolean;
  titleGate?: Promise<void>;
  autoTitle?: boolean;
  useCurrentChat?: boolean;
  titleProvider?: 'openai' | 'deepseek';
  titleModel?: string;
  allowCrossProvider?: boolean;
  titleUsageRaw?: unknown | null;
}

function createHarness(options: HarnessOptions = {}) {
  const { dir, db, store } = createStore(tempDir('tokenledger-titles-'));
  const secrets = new MemorySecretStore();
  secrets.preload('openai', 'test-openai-key-not-real');
  secrets.preload('deepseek', 'test-deepseek-key-not-real');
  const pricing = new PricingService(store);
  const settings = store.getSettings();
  store.saveSettings({
    ...settings,
    autoTitle: {
      ...settings.autoTitle,
      enabled: options.autoTitle ?? true,
      useCurrentChat: options.useCurrentChat ?? true,
      provider: options.titleProvider ?? 'openai',
      model: options.titleModel ?? '',
      allowCrossProvider: options.allowCrossProvider ?? false,
    },
  });

  const chatEvents: ChatStreamEvent[] = [];
  const titleEvents: TitleEvent[] = [];
  const requests: Parameters<StreamFunction>[0][] = [];
  let titleAttempts = 0;

  const stream: StreamFunction = async (request) => {
    requests.push(request);
    if (request.purpose === 'title_generation') {
      titleAttempts += 1;
      if (options.titleGate) await options.titleGate;
      if (options.titleError) throw new ProviderStreamError('标题服务失败', 'title_failed');
      const usageRaw =
        options.titleUsageRaw === undefined
          ? request.provider === 'openai'
            ? OPENAI_TITLE_USAGE
            : DEEPSEEK_TITLE_USAGE
          : options.titleUsageRaw;
      request.onTextDelta(options.titleText ?? '操作系统的死锁解析');
      if (usageRaw !== null) request.onUsage(usageRaw);
      return {
        usageRaw,
        providerRequestId: `title-${titleAttempts}`,
        finishStatus: 'completed',
      };
    }
    const usageRaw =
      request.provider === 'deepseek' ? DEEPSEEK_USAGE_RAW : OPENAI_USAGE_RAW;
    request.onTextDelta('聊天回答');
    request.onUsage(usageRaw);
    return {
      usageRaw,
      providerRequestId: `chat-${requests.length}`,
      finishStatus: 'completed',
    };
  };

  const fixedNow = () => new Date('2026-11-02T02:00:00.000Z');
  const titleService = new TitleService({
    store,
    secrets,
    pricing,
    stream,
    now: fixedNow,
    emit: (event) => titleEvents.push(event),
  });
  const chat = new ChatService({
    store,
    secrets,
    pricing,
    stream,
    now: fixedNow,
    emit: (event) => chatEvents.push(event),
    onTurnCompleted: (conversationId) => {
      void titleService.handleAutoTitle(conversationId);
    },
  });

  return {
    dir,
    db,
    store,
    pricing,
    titleService,
    chat,
    chatEvents,
    titleEvents,
    requests,
    getTitleAttempts: () => titleAttempts,
  };
}

function waitForTitle<T extends TitleEvent['type']>(
  harness: ReturnType<typeof createHarness>,
  type: T,
  timeout = 5000,
): Promise<Extract<TitleEvent, { type: T }>> {
  return waitFor(
    () => harness.titleEvents.some((event) => event.type === type),
    timeout,
  ).then(
    () =>
      harness.titleEvents.filter(
        (event): event is Extract<TitleEvent, { type: T }> => event.type === type,
      ).at(-1)!,
  );
}

const openDbs: ReturnType<typeof createHarness>[] = [];

afterEach(() => {
  for (const harness of openDbs.splice(0)) {
    try {
      harness.db.close();
    } catch {
      // already closed
    }
  }
});

function harness(options: HarnessOptions = {}) {
  const h = createHarness(options);
  openDbs.push(h);
  return h;
}

async function firstChat(
  h: ReturnType<typeof createHarness>,
  content = '请解释操作系统的死锁',
) {
  const result = await h.chat.send({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    content,
  });
  await waitForEvent(h.chatEvents, 'completed');
  return result;
}

describe('AI 自动会话标题', () => {
  it('首轮成功后自动请求标题，保存标题并计入 Turn 与会话费用', async () => {
    const h = harness();
    const result = await firstChat(h);
    const titleEvent = await waitForTitle(h, 'completed');

    expect(h.getTitleAttempts()).toBe(1);
    expect(titleEvent.title).toBe('操作系统的死锁解析');
    expect(titleEvent.applied).toBe(true);
    const conversation = h.store.getConversation(result.conversationId)!;
    expect(conversation.title).toBe('操作系统的死锁解析');
    expect(conversation.titleSource).toBe('ai_auto');
    expect(conversation.autoTitleAttemptedAt).not.toBeNull();

    const detail = h.store.getConversationDetail(result.conversationId);
    const turn = detail.turns[0];
    expect(turn.requests).toHaveLength(2);
    expect(turn.requests.map((request) => request.requestPurpose).sort()).toEqual([
      'chat',
      'title_generation',
    ]);
    expect(turn.stats.totalTokens).toBe(5692);
    expect(turn.stats.costUsd).toBe('0.00533');
    const titleRequest = turn.requests.find((request) => request.requestPurpose === 'title_generation')!;
    expect(titleRequest.id).toBe(titleEvent.requestId);
    expect(titleRequest.pricingVersion).toContain('openai');
    expect(titleRequest.costAmount).toBe('0.00048');

    const titlePrompt = h.requests.find((request) => request.purpose === 'title_generation')!;
    expect(titlePrompt.messages).toHaveLength(1);
    expect(titlePrompt.messages[0].content).toContain('请解释操作系统的死锁');
    expect(titlePrompt.messages[0].content).toContain('聊天回答');
    expect(titlePrompt.messages[0].content.length).toBeLessThan(2500);

    const global = h.store.getGlobalStats(null, null);
    const chatPurpose = global.byPurpose.find((item) => item.purpose === 'chat')!;
    const titlePurpose = global.byPurpose.find((item) => item.purpose === 'title_generation')!;
    expect(chatPurpose.requestCount).toBe(1);
    expect(chatPurpose.totalTokens).toBe(5500);
    expect(chatPurpose.costUsd).toBe('0.00485');
    expect(titlePurpose.requestCount).toBe(1);
    expect(titlePurpose.totalTokens).toBe(192);
    expect(titlePurpose.costUsd).toBe('0.00048');
    expect(global.costUsd).toBe('0.00533');
    expect(h.store.getGlobalStats(null, null, null, null, 'title_generation').requestCount).toBe(1);
    expect(h.store.getGlobalStats(null, null, null, null, 'chat').requestCount).toBe(1);
  });

  it('标题 usage 的缓存读取与推理 Token 不重复计费', async () => {
    const h = harness({
      titleText: '缓存标题测试',
      titleUsageRaw: {
        input_tokens: 200,
        input_tokens_details: {
          cached_tokens: 100,
          cache_write_tokens: 0,
          cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 },
        },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 220,
      },
    });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    const titleRequest = h.store
      .getConversationDetail(result.conversationId)
      .turns[0].requests.find((request) => request.requestPurpose === 'title_generation')!;
    // 100 普通输入 * $2 + 100 缓存读取 * $0.10 + 20 输出 * $10 = $0.00041
    expect(titleRequest.costAmount).toBe('0.00041');
    expect(titleRequest.cacheReadTokens).toBe(100);
    expect(titleRequest.outputTokens).toBe(20);
  });

  it('可配置更便宜的独立标题模型，并按该模型价格计费', async () => {
    const h = harness({ useCurrentChat: true, titleModel: 'gpt-6-luna' });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    const titleRequest = h.store
      .getConversationDetail(result.conversationId)
      .turns[0].requests.find((request) => request.requestPurpose === 'title_generation')!;
    expect(titleRequest.model).toBe('gpt-6-luna');
    // 180*$0.10 + 12*$0.50 = $0.000024
    expect(titleRequest.costAmount).toBe('0.000024');
    expect(h.store.getConversationDetail(result.conversationId).stats.costUsd).toBe('0.004874');
  });

  it('标题模型没有价格时仍可命名，但费用标记为未知', async () => {
    const h = harness({ titleModel: 'unknown-title-model' });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    const titleRequest = h.store
      .getConversationDetail(result.conversationId)
      .turns[0].requests.find((request) => request.requestPurpose === 'title_generation')!;
    expect(titleRequest.model).toBe('unknown-title-model');
    expect(titleRequest.calculationStatus).toBe('unknown');
    expect(titleRequest.costAmount).toBeNull();
    expect(h.store.getConversation(result.conversationId)?.title).toBe('操作系统的死锁解析');
    expect(h.store.getConversationDetail(result.conversationId).stats.costUsd).toBe('0.00485');
  });

  it('标题生成期间快速发送第二轮，不会产生第二个自动标题请求', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ titleGate: gate });
    const first = await firstChat(h);
    await waitFor(() => h.titleEvents.some((event) => event.type === 'started'));
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: '标题生成期间的第二个问题',
    });
    await waitForEvent(h.chatEvents, 'completed');
    release();
    await waitForTitle(h, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.getTitleAttempts()).toBe(1);
    expect(h.store.getConversation(first.conversationId)?.title).toBe('操作系统的死锁解析');
  });

  it('第二轮普通聊天不再次自动命名', async () => {
    const h = harness();
    const first = await firstChat(h);
    await waitForTitle(h, 'completed');
    await h.chat.send({
      conversationId: first.conversationId,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: '请继续补充',
    });
    await waitForEvent(h.chatEvents, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(h.getTitleAttempts()).toBe(1);
    expect(h.store.getConversation(first.conversationId)?.title).toBe('操作系统的死锁解析');
    const detail = h.store.getConversationDetail(first.conversationId);
    expect(detail.stats.requestCount).toBe(3);
    expect(detail.stats.costUsd).toBe('0.01018');
  });

  it('自动命名关闭时不产生标题请求，并使用首条消息备用标题', async () => {
    const h = harness({ autoTitle: false });
    const result = await firstChat(h, '这是用于备用标题的第一条用户消息');
    await waitForTitle(h, 'fallback');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(h.getTitleAttempts()).toBe(0);
    const conversation = h.store.getConversation(result.conversationId)!;
    expect(conversation.title).toBe('这是用于备用标题的第一条用户消息');
    expect(conversation.titleSource).toBe('first_message');
    expect(h.requests).toHaveLength(1);
    expect(h.store.getConversationDetail(result.conversationId).stats.costUsd).toBe('0.00485');
  });

  it('标题生成失败时聊天仍成功，失败请求保留且费用未知', async () => {
    const h = harness({ titleError: true });
    const result = await firstChat(h);
    const failed = await waitForTitle(h, 'failed');
    expect(failed.message).toContain('标题');

    expect(h.store.getMessage(result.assistantMessageId)?.status).toBe('complete');
    const detail = h.store.getConversationDetail(result.conversationId);
    const titleRequest = detail.turns[0].requests.find(
      (request) => request.requestPurpose === 'title_generation',
    )!;
    expect(titleRequest.status).toBe('error');
    expect(titleRequest.calculationStatus).toBe('unknown');
    expect(titleRequest.costAmount).toBeNull();
    expect(h.store.getConversation(result.conversationId)?.title).toBe('请解释操作系统的死锁');
    expect(detail.stats.costUsd).toBe('0.00485');
  });

  it('历史升级会话不会因后续消息被批量自动命名', async () => {
    const h = harness();
    const conversation = h.store.createConversation({
      title: '旧版会话',
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    h.store.createTurn({
      turnId: 'turn_legacy',
      conversationId: conversation.id,
      userMessageId: 'msg_u_legacy',
      assistantMessageId: 'msg_a_legacy',
      content: '旧版用户消息',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      now: '2026-01-01T00:00:00.000Z',
    });
    h.store.updateAssistantMessage('msg_a_legacy', { content: '旧版回答', status: 'complete' });
    h.store.raw.db
      .prepare("UPDATE conversations SET auto_title_attempted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
      .run(conversation.id);

    await h.titleService.handleAutoTitle(conversation.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.getTitleAttempts()).toBe(0);
    expect(h.store.getConversation(conversation.id)?.title).toBe('旧版会话');
  });

  it('用户手动重命名后自动任务不覆盖', async () => {
    const h = harness({ titleText: '会被拒绝的自动标题' });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');

    h.store.renameConversation(result.conversationId, '用户手动标题');
    await h.titleService.handleAutoTitle(result.conversationId);
    expect(h.store.getConversation(result.conversationId)?.title).toBe('用户手动标题');
    expect(h.store.getConversation(result.conversationId)?.titleSource).toBe('manual');
    expect(h.getTitleAttempts()).toBe(1);
  });

  it('标题请求进行中用户手动改名，完成后不覆盖旧标题但保留费用', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ titleGate: gate, titleText: '迟到的自动标题' });
    const result = await firstChat(h);
    await waitFor(() => h.titleEvents.some((event) => event.type === 'started'));
    h.store.renameConversation(result.conversationId, '生成期间手动改名');
    release();
    const failed = await waitForTitle(h, 'failed');
    expect(failed.message).toContain('手动修改');
    expect(h.store.getConversation(result.conversationId)?.title).toBe('生成期间手动改名');
    expect(h.store.getConversation(result.conversationId)?.titleSource).toBe('manual');
    const titleRequest = h.store
      .getConversationDetail(result.conversationId)
      .turns[0].requests.find((request) => request.requestPurpose === 'title_generation')!;
    expect(titleRequest.costAmount).toBe('0.00048');
  });

  it('手动 AI 重新生成标题会独立记录请求并覆盖手动标题', async () => {
    const h = harness({ titleText: '新的 AI 标题' });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    h.store.renameConversation(result.conversationId, '先手动命名');
    const before = h.store.getConversationDetail(result.conversationId).stats;

    const regenerated: TitleGenerationResult = await h.titleService.regenerate(
      result.conversationId,
    );
    expect(regenerated.ok).toBe(true);
    expect(regenerated.title).toBe('新的 AI 标题');
    expect(regenerated.mode).toBe('manual');
    const conversation = h.store.getConversation(result.conversationId)!;
    expect(conversation.title).toBe('新的 AI 标题');
    expect(conversation.titleSource).toBe('ai_manual');

    const detail = h.store.getConversationDetail(result.conversationId);
    const manualTitleRequest = detail.stats.requestCount;
    expect(manualTitleRequest).toBe(before.requestCount + 1);
    const requests = h.store.loadStatRequests({ conversationId: result.conversationId });
    expect(
      requests.filter((request) => request.requestPurpose === 'title_generation'),
    ).toHaveLength(2);
    const manualTitleRequestRow = requests.at(-1)!;
    expect(manualTitleRequestRow.turnId).toBeNull();
    expect(manualTitleRequestRow.costAmount).toBe('0.00048');
    expect(detail.stats.costUsd).toBe('0.00581');
  });

  it('多次手动重新生成标题会新增独立请求并保留全部历史费用', async () => {
    const h = harness({ titleText: '重复生成标题' });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    await h.titleService.regenerate(result.conversationId);
    await h.titleService.regenerate(result.conversationId);

    const requests = h.store.loadStatRequests({ conversationId: result.conversationId });
    const titleRequests = requests.filter((request) => request.requestPurpose === 'title_generation');
    expect(titleRequests).toHaveLength(3);
    expect(titleRequests.every((request) => request.costAmount === '0.00048')).toBe(true);
    expect(h.store.getConversationDetail(result.conversationId).stats.costUsd).toBe('0.00629');
    expect(h.store.getConversationDetail(result.conversationId).stats.requestCount).toBe(4);
    expect(h.store.getConversation(result.conversationId)?.title).toBe('重复生成标题');
  });

  it('标题生成过程中切换到其他会话不会写错 conversation_id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ titleGate: gate, titleText: '会话 A 的标题' });
    const result = await firstChat(h, '会话 A 的问题');
    await waitFor(() => h.titleEvents.some((event) => event.type === 'started'));
    const other = h.store.createConversation({
      title: '会话 B',
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    release();
    const completed = await waitForTitle(h, 'completed');
    expect(completed.conversationId).toBe(result.conversationId);
    expect(h.store.getConversation(result.conversationId)?.title).toBe('会话 A 的标题');
    expect(h.store.getConversation(other.id)?.title).toBe('会话 B');
    const otherStats = h.store.getConversationStats(other.id);
    expect(otherStats.requestCount).toBe(0);
  });

  it('连续手动点击时第二次被拒绝，不会产生重复请求', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ titleGate: gate, titleText: '队列中的标题' });
    const result = await firstChat(h);
    await waitFor(() => h.titleEvents.some((event) => event.type === 'started'));
    await expect(h.titleService.regenerate(result.conversationId)).rejects.toBeInstanceOf(
      TitleError,
    );
    release();
    await waitForTitle(h, 'completed');
    expect(h.getTitleAttempts()).toBe(1);
  });

  it('标题生成过程中删除会话，请求费用仍保留在全局记录', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ titleGate: gate, titleText: '删除测试标题' });
    const result = await firstChat(h);
    await waitFor(() => h.titleEvents.some((event) => event.type === 'started'));
    h.store.softDeleteConversation(result.conversationId);
    release();
    await waitForTitle(h, 'failed');
    const global = h.store.getGlobalStats(null, null);
    expect(global.requestCount).toBe(2);
    expect(global.costUsd).toBe('0.00533');
    expect(h.store.getConversation(result.conversationId)?.deletedAt).not.toBeNull();
  });
});

describe('跨服务商标题', () => {
  it('未显式允许跨服务商时不发起标题请求，使用备用标题', async () => {
    const h = harness({
      useCurrentChat: false,
      titleProvider: 'deepseek',
      titleModel: 'deepseek-flash',
      allowCrossProvider: false,
    });
    const result = await firstChat(h);
    await waitForTitle(h, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.getTitleAttempts()).toBe(0);
    expect(h.store.getConversation(result.conversationId)?.title).toBe('请解释操作系统的死锁');
    expect(h.store.getConversationDetail(result.conversationId).stats.costUsd).toBe('0.00485');
  });

  it('显式允许后使用 DeepSeek 生成标题并记录 CNY 与美元折算', async () => {
    const h = harness({
      useCurrentChat: false,
      titleProvider: 'deepseek',
      titleModel: 'deepseek-flash',
      allowCrossProvider: true,
    });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    const requests = h.store.loadStatRequests({ conversationId: result.conversationId });
    const title = requests.find((request) => request.requestPurpose === 'title_generation')!;
    expect(title.provider).toBe('deepseek');
    expect(title.model).toBe('deepseek-flash');
    expect(title.costCurrency).toBe('CNY');
    expect(title.costAmount).toBe('0.000496');
    expect(title.costUsd).not.toBeNull();
    const detail = h.store.getConversationDetail(result.conversationId);
    expect(detail.stats.nativeCosts.map((item) => item.currency).sort()).toEqual(['CNY', 'USD']);
    expect(detail.stats.costUsd).toBe('0.004924553264');
  });
});

describe('标题并发与持久化', () => {
  it('标题生成在应用重启后仍保存，且不会重复自动命名', async () => {
    const h = harness({ titleText: '持久化标题' });
    const result = await firstChat(h);
    await waitForTitle(h, 'completed');
    expect(h.store.getConversation(result.conversationId)?.title).toBe('持久化标题');
    h.db.close();
    openDbs.length = 0;

    const reopened = createStore(h.dir);
    openDbs.push({ ...h, db: reopened.db, store: reopened.store });
    const conversation = reopened.store.getConversation(result.conversationId)!;
    expect(conversation.title).toBe('持久化标题');
    expect(conversation.autoTitleAttemptedAt).not.toBeNull();
    const detail = reopened.store.getConversationDetail(result.conversationId);
    expect(detail.stats.costUsd).toBe('0.00533');
    expect(detail.turns[0].requests).toHaveLength(2);
  });

  it('启动修复会为中断的自动标题补上备用标题', async () => {
    const h = harness();
    const result = await firstChat(h, '崩溃恢复用的第一条消息');
    // 模拟应用在自动标题请求中途退出：保留尝试标记，但标题仍是占位符。
    h.store.raw.db
      .prepare("UPDATE conversations SET title = '新对话', title_source = 'default' WHERE id = ?")
      .run(result.conversationId);
    const repaired = h.titleService.repairStartupTitles();
    expect(repaired).toBe(1);
    const conversation = h.store.getConversation(result.conversationId)!;
    expect(conversation.title).toBe('崩溃恢复用的第一条消息');
    expect(conversation.titleSource).toBe('first_message');
  });

  it('标题请求没有 usage 时记录为未知，不虚报零费用', async () => {
    const h = harness({ titleUsageRaw: null, titleText: '无用量标题' });
    const result = await firstChat(h, '无 usage 标题测试');
    const titleEvent = await waitForTitle(h, 'completed');
    expect(titleEvent.title).toBe('无用量标题');
    const titleRequest = h.store
      .getConversationDetail(result.conversationId)
      .turns[0].requests.find((request) => request.requestPurpose === 'title_generation')!;
    expect(titleRequest.status).toBe('completed');
    expect(titleRequest.calculationStatus).toBe('unknown');
    expect(titleRequest.costAmount).toBeNull();
    expect(h.store.getConversation(result.conversationId)?.title).toBe('无用量标题');
    expect(h.store.getConversationDetail(result.conversationId).stats.costUsd).toBe('0.00485');
  });
});
