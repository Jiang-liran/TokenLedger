import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/main/db/database';
import { Store } from '../src/main/db/repositories';
import { ChatError } from '../src/main/services/chat';
import { ProviderStreamError } from '../src/main/services/transport';
import type { ChatStreamEvent } from '../src/shared/types';
import {
  DEEPSEEK_USAGE_RAW,
  OPENAI_USAGE_RAW,
  createChatHarness,
  createStore,
  tempDir,
  waitFor,
  waitForEvent,
} from './helpers';

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭
    }
  }
});

function harness(options: Parameters<typeof createChatHarness>[0] = {}) {
  const h = createChatHarness(options);
  openDbs.push(h.db);
  return h;
}

async function sendFirst(
  h: ReturnType<typeof harness>,
  content = '什么是操作系统的死锁？',
  provider: 'openai' | 'deepseek' = 'openai',
  model = provider === 'openai' ? 'gpt-6.1-sol' : 'deepseek-flash',
) {
  const result = await h.chat.send({ provider, model, content });
  const completed = await waitForEvent(h.events, 'completed');
  return { result, completed };
}

describe('单轮请求与费用落库', () => {
  it('保存官方 usage、价格快照与精确费用', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '第一轮回答' });
    const { result, completed } = await sendFirst(h);

    expect(completed.request.calculationStatus).toBe('calculated');
    expect(completed.request.costAmount).toBe('0.00485');
    expect(completed.request.costCurrency).toBe('USD');
    expect(completed.turnView.stats.totalTokens).toBe(5500);
    expect(completed.turnView.stats.inputTokens).toBe(5200);
    expect(completed.turnView.stats.cacheReadTokens).toBe(4500);
    expect(completed.turnView.stats.outputTokens).toBe(300);
    expect(completed.conversationStats.costUsd).toBe('0.00485');

    const record = h.store.getRequest(result.requestId);
    expect(record?.status).toBe('completed');
    expect(record?.rawUsage).toContain('input_tokens_details');
    expect(record?.normalizedUsage).toContain('"inputTokens":5200');
    expect(record?.pricingSnapshotId).toBeTruthy();
    const snapshot = h.store.getPricingSnapshot(record!.pricingSnapshotId!);
    expect(snapshot?.table.inputPerM).toBe('2.00');
    expect(snapshot?.table.cachedInputPerM).toBe('0.10');
    expect(snapshot?.table.outputPerM).toBe('10.00');
    expect(snapshot?.pricingVersion).toBe('openai-2026.11.01');
  });

  it('会话标题由第一条用户消息本地生成，不额外调用模型', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '答复' });
    const content = '请解释操作系统的死锁以及四个必要条件';
    const { result } = await sendFirst(h, content);
    const conversation = h.store.getConversation(result.conversationId);
    expect(conversation?.title.startsWith('请解释操作系统的死锁')).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it('请求开始时即写入 streaming 记录，崩溃后不会丢失请求', async () => {
    const h = harness({ text: '部分内容', waitForAbort: true });
    const result = await h.chat.send({ provider: 'openai', model: 'gpt-6.1-sol', content: '测试' });
    await waitFor(() => h.events.some((event) => event.type === 'request_started'));
    const record = h.store.getRequest(result.requestId);
    expect(record?.status).toBe('streaming');
    expect(record?.calculationStatus).toBe('unknown');
    h.chat.abortAll();
    await waitForEvent(h.events, 'aborted');
  });
});

describe('多轮上下文与会话累计', () => {
  it('第二轮保留上下文，累计 Token 与费用正确', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '第一轮回答' });
    const first = await sendFirst(h);

    const second = await h.chat.send({
      conversationId: first.result.conversationId,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: '请继续补充一个例子。',
    });
    await waitForEvent(h.events, 'completed');
    const context = h.requests[1].messages.map((message) => `${message.role}:${message.content}`);
    expect(context).toEqual([
      'user:什么是操作系统的死锁？',
      'assistant:第一轮回答',
      'user:请继续补充一个例子。',
    ]);

    const detail = h.store.getConversationDetail(first.result.conversationId);
    expect(detail.stats.turnCount).toBe(2);
    expect(detail.stats.requestCount).toBe(2);
    expect(detail.stats.totalTokens).toBe(11000);
    expect(detail.stats.costUsd).toBe('0.0097');
    expect(detail.turns.map((turn) => turn.stats.costUsd)).toEqual(['0.00485', '0.00485']);
    expect(second.requestId).not.toBe(first.result.requestId);
  });

  it('新建会话统计独立归零，不影响旧会话', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const first = await sendFirst(h, '旧会话问题');
    const second = await h.chat.send({ provider: 'openai', model: 'gpt-6.1-sol', content: '新会话问题' });
    await waitForEvent(h.events, 'completed');

    const oldDetail = h.store.getConversationDetail(first.result.conversationId);
    const newDetail = h.store.getConversationDetail(second.conversationId);
    expect(oldDetail.stats.costUsd).toBe('0.00485');
    expect(newDetail.stats.costUsd).toBe('0.00485');
    expect(newDetail.stats.totalTokens).toBe(5500);
    expect(h.store.listConversations(false)).toHaveLength(2);
  });

  it('同一会话切换服务商时按各自价格累计', async () => {
    const h = harness({
      usageByProvider: {
        openai: OPENAI_USAGE_RAW,
        deepseek: DEEPSEEK_USAGE_RAW,
      },
      text: '回答',
      now: () => new Date('2026-11-02T02:00:00.000Z'),
    });
    const first = await sendFirst(h, 'OpenAI 问题');
    await h.chat.send({
      conversationId: first.result.conversationId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      content: 'DeepSeek 追问',
    });
    await waitForEvent(h.events, 'completed');

    const detail = h.store.getConversationDetail(first.result.conversationId);
    expect(detail.stats.requestCount).toBe(2);
    expect(detail.stats.byProvider).toHaveLength(2);
    expect(detail.stats.nativeCosts.map((item) => item.currency).sort()).toEqual(['CNY', 'USD']);
    expect(detail.stats.costUsd).toBe('0.00576387872');
    expect(detail.stats.totalTokens).toBe(9000);

    const deepseekRequest = detail.turns[1].requests[0];
    expect(deepseekRequest.provider).toBe('deepseek');
    expect(deepseekRequest.costAmount).toBe('0.00608');
    expect(deepseekRequest.costCurrency).toBe('CNY');
    expect(deepseekRequest.costUsd).toBe('0.00091387872');
    expect(h.requests[1].messages).toHaveLength(3);
  });

  it('重新生成保留旧回复与实际请求费用，并新增请求', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答内容' });
    const first = await sendFirst(h);
    await h.chat.regenerate(first.result.turnId, first.result.assistantMessageId, 'openai', 'gpt-6.1-sol');
    await waitForEvent(h.events, 'completed', 0);
    await waitFor(() => h.events.filter((event) => event.type === 'completed').length === 2);

    const detail = h.store.getConversationDetail(first.result.conversationId);
    const turn = detail.turns[0];
    expect(turn.requests).toHaveLength(2);
    expect(turn.stats.requestCount).toBe(2);
    expect(turn.stats.costUsd).toBe('0.0097');
    expect(turn.assistantMessages).toHaveLength(2);
    expect(turn.assistantMessages.filter((message) => message.status === 'superseded')).toHaveLength(1);
    expect(detail.stats.costUsd).toBe('0.0097');
    expect(detail.stats.requestCount).toBe(2);
    expect(detail.turns[0].turn.attemptCount).toBe(2);
  });
});

describe('异常与用量未知', () => {
  it('未返回 usage 时保留回答，费用标记为未知而不是 0', async () => {
    const h = harness({ usageRaw: null, text: '已收到的回答' });
    const { result, completed } = await sendFirst(h);
    expect(completed.request.calculationStatus).toBe('unknown');
    expect(completed.request.costAmount).toBeNull();
    expect(completed.request.costUsd).toBeNull();
    expect(completed.turnView.stats.calculationStatus).toBe('unknown');
    const message = h.store.getMessage(result.assistantMessageId);
    expect(message?.status).toBe('complete');
    expect(message?.content).toBe('已收到的回答');
    expect(message?.errorDetails).toContain('未返回 usage');
    expect(h.store.getGlobalStats(null, null).unknownCostRequestCount).toBe(1);
  });

  it('流式错误时保留部分文本与失败记录', async () => {
    const h = harness({
      text: '已经显示的部分',
      throwError: new ProviderStreamError('上游连接中断', 'stream_error'),
    });
    const result = await h.chat.send({ provider: 'openai', model: 'gpt-6.1-sol', content: '测试错误' });
    const failed = await waitForEvent(h.events, 'failed');
    expect(failed.code).toBe('stream_error');
    const message = h.store.getMessage(result.assistantMessageId);
    expect(message?.status).toBe('error');
    expect(message?.content).toBe('已经显示的部分');
    const record = h.store.getRequest(result.requestId);
    expect(record?.status).toBe('error');
    expect(record?.calculationStatus).toBe('unknown');
    expect(record?.costAmount).toBeNull();
  });

  it('用户停止生成后保留部分回答，请求状态为 aborted 且费用未知', async () => {
    const h = harness({ text: '部分回答', waitForAbort: true });
    const result = await h.chat.send({ provider: 'openai', model: 'gpt-6.1-sol', content: '长任务' });
    await waitFor(() => h.events.some((event) => event.type === 'request_started'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    h.chat.abort(result.requestId);
    const aborted = await waitForEvent(h.events, 'aborted');
    expect(aborted.message).toContain('已停止生成');
    const record = h.store.getRequest(result.requestId);
    expect(record?.status).toBe('aborted');
    expect(record?.costAmount).toBeNull();
    expect(record?.calculationStatus).toBe('unknown');
    const message = h.store.getMessage(result.assistantMessageId);
    expect(message?.content).toBe('部分回答');
    expect(message?.status).toBe('error');
  });

  it('未配置 API Key 时拒绝发送且不创建会话', async () => {
    const h = harness();
    await h.secrets.deleteKey('openai');
    await expect(
      h.chat.send({ provider: 'openai', model: 'gpt-6.1-sol', content: '你好' }),
    ).rejects.toBeInstanceOf(ChatError);
    expect(h.store.listConversations(false)).toHaveLength(0);
  });

  it('空消息被拒绝', async () => {
    const h = harness();
    await expect(
      h.chat.send({ provider: 'openai', model: 'gpt-6.1-sol', content: '   ' }),
    ).rejects.toMatchObject({ code: 'empty_message' });
  });

  it('未配置价格的模型仍能聊天，但费用未知', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const result = await h.chat.send({
      provider: 'openai',
      model: 'some-custom-model',
      content: '自定义模型',
    });
    const completed = await waitForEvent(h.events, 'completed');
    expect(completed.request.calculationStatus).toBe('unknown');
    expect(completed.request.costAmount).toBeNull();
    const record = h.store.getRequest(result.requestId);
    expect(record?.errorDetails).toContain('未配置模型');
    expect(record?.pricingSnapshotId).toBeNull();
  });

  it('DeepSeek 空闲时段采用 5 折价格', async () => {
    const h = harness({
      usageRaw: DEEPSEEK_USAGE_RAW,
      text: '回答',
      now: () => new Date('2026-11-02T16:30:00.000Z'), // 北京时间 00:30，周二
    });
    await sendFirst(h, 'DeepSeek 空闲测试', 'deepseek', 'deepseek-flash');
    const detail = h.store.getConversationDetail(h.store.listConversations(false)[0].id);
    const request = detail.turns[0].requests[0];
    expect(request.costAmount).toBe('0.00304');
    const snapshot = h.store.getPricingSnapshot(request.pricingSnapshotId!);
    expect(snapshot?.billingTier).toBe('offpeak');
    expect(snapshot?.pricingBasis).toContain('空闲时段');
  });

  it('节假日日历未覆盖未来日期时费用未知，不静默套用费率', async () => {
    const h = harness({
      usageRaw: DEEPSEEK_USAGE_RAW,
      text: '回答',
      now: () => new Date('2027-01-04T02:00:00.000Z'),
    });
    await sendFirst(h, '未来日期测试', 'deepseek', 'deepseek-flash');
    const detail = h.store.getConversationDetail(h.store.listConversations(false)[0].id);
    const request = detail.turns[0].requests[0];
    expect(request.calculationStatus).toBe('unknown');
    expect(request.costAmount).toBeNull();
    const snapshot = h.store.getPricingSnapshot(request.pricingSnapshotId!);
    expect(snapshot?.billingTier).toBe('unknown');
    expect(snapshot?.pricingBasis).toContain('超出节假日日历覆盖范围');
  });
});

describe('价格快照与历史费用', () => {
  it('价格覆盖只影响之后的新请求，旧请求费用与快照不变', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const first = await sendFirst(h);
    const firstSnapshotId = h.store.getRequest(first.result.requestId)!.pricingSnapshotId!;

    h.store.upsertPriceOverride({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      inputPerM: '100',
      cachedInputPerM: '0.10',
      cacheWrite30mPerM: null,
      cacheWrite12hPerM: null,
      outputPerM: '10',
      offPeakInputPerM: null,
      offPeakCachedInputPerM: null,
      offPeakOutputPerM: null,
      currency: 'USD',
      sourceUrl: 'https://example.com/pricing',
      effectiveFrom: '2026-11-01',
      notes: '测试覆盖',
      createdAt: '2026-11-01T00:00:00.000Z',
    });

    await h.chat.send({
      conversationId: first.result.conversationId,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      content: '第二次请求',
    });
    const completed2 = await waitForEvent(h.events, 'completed');

    const firstRequest = h.store.getRequest(first.result.requestId)!;
    expect(firstRequest.costAmount).toBe('0.00485');
    expect(h.store.getPricingSnapshot(firstSnapshotId)?.table.inputPerM).toBe('2.00');
    expect(completed2.request.costAmount).toBe('0.07345');
    expect(h.store.getPricingSnapshot(completed2.request.pricingSnapshotId!)?.table.inputPerM).toBe(
      '100',
    );
    expect(h.store.getPricingSnapshot(completed2.request.pricingSnapshotId!)?.isUserOverride).toBe(
      true,
    );

    const detail = h.store.getConversationDetail(first.result.conversationId);
    expect(detail.turns[0].stats.costUsd).toBe('0.00485');
    expect(detail.turns[1].stats.costUsd).toBe('0.07345');
    expect(detail.stats.costUsd).toBe('0.0783');
  });
});

describe('历史费用重算', () => {
  it('用户触发后更新费用，并在日志中保留旧费用与两个快照 ID', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const first = await sendFirst(h);
    const original = h.store.getRequest(first.result.requestId)!;
    const originalSnapshotId = original.pricingSnapshotId!;

    h.store.upsertPriceOverride({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      inputPerM: '100',
      cachedInputPerM: '0.10',
      cacheWrite30mPerM: null,
      cacheWrite12hPerM: null,
      outputPerM: '10',
      offPeakInputPerM: null,
      offPeakCachedInputPerM: null,
      offPeakOutputPerM: null,
      currency: 'USD',
      sourceUrl: null,
      effectiveFrom: '2026-11-01',
      notes: null,
      createdAt: '2026-11-02T00:00:00.000Z',
    });

    const result = h.pricing.recalculateHistory();
    expect(result.totalCandidates).toBe(1);
    expect(result.recalculated).toBe(1);
    expect(result.skipped).toBe(0);

    const updated = h.store.getRequest(first.result.requestId)!;
    expect(updated.costAmount).toBe('0.07345');
    expect(updated.pricingSnapshotId).not.toBe(originalSnapshotId);
    expect(h.store.getPricingSnapshot(originalSnapshotId)?.table.inputPerM).toBe('2.00');

    const logs = h.store.listRecalculationLog();
    expect(logs).toHaveLength(1);
    expect(logs[0].oldCostAmount).toBe('0.00485');
    expect(logs[0].newCostAmount).toBe('0.07345');
    expect(logs[0].oldPricingSnapshotId).toBe(originalSnapshotId);
    expect(logs[0].newPricingSnapshotId).toBe(updated.pricingSnapshotId);
  });
});

describe('预算提醒集成', () => {
  it('完成请求后按本地估算触发单轮预算提醒', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const settings = h.store.getSettings();
    h.store.saveSettings({
      ...settings,
      budget: { enabled: true, turnUsd: '0.001', conversationUsd: null, dailyUsd: null, totalUsd: null },
    });
    const { completed } = await sendFirst(h);
    expect(completed.budgetAlerts).toHaveLength(1);
    expect(completed.budgetAlerts[0].scope).toBe('turn');
    expect(completed.budgetAlerts[0].actualUsd).toBe('0.00485');
  });
});

describe('持久化、删除与恢复', () => {
  it('关闭并重新打开数据库后聊天与统计完整', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '持久化回答' });
    const first = await sendFirst(h);
    const dbPath = path.join(h.dir, 'tokenledger.db');
    h.db.close();
    openDbs.length = 0;

    const reopened = new Database(dbPath);
    openDbs.push(reopened);
    const store = new Store(reopened);
    const detail = store.getConversationDetail(first.result.conversationId);
    expect(detail.stats.totalTokens).toBe(5500);
    expect(detail.stats.costUsd).toBe('0.00485');
    expect(detail.turns[0].userMessage?.content).toBe('什么是操作系统的死锁？');
    expect(detail.turns[0].assistantMessages[0].content).toBe('持久化回答');
    expect(store.getGlobalStats(null, null).costUsd).toBe('0.00485');
  });

  it('异常退出遗留的 streaming 记录被标记为中断且费用未知', async () => {
    const { db, store } = createStore(tempDir());
    openDbs.push(db);
    const conversation = store.createConversation({
      title: '崩溃测试',
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    const now = new Date().toISOString();
    store.createTurn({
      turnId: 'turn_crash',
      conversationId: conversation.id,
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      content: '测试',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      now,
    });
    store.insertRequestStart({
      id: 'req_crash',
      conversationId: conversation.id,
      turnId: 'turn_crash',
      assistantMessageId: 'msg_assistant',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      startedAt: now,
      requestParameters: '{}',
      pricingSnapshotId: null,
      pricingBasis: null,
    });

    const result = store.markInterrupted();
    expect(result.requests).toBe(1);
    const record = store.getRequest('req_crash');
    expect(record?.status).toBe('interrupted');
    expect(record?.calculationStatus).toBe('unknown');
    expect(store.getMessage('msg_assistant')?.status).toBe('error');
    expect(store.getTurn('turn_crash')?.status).toBe('interrupted');
  });

  it('移除会话后全局费用仍保留，彻底删除后才移除', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const first = await sendFirst(h);
    h.store.softDeleteConversation(first.result.conversationId);
    expect(h.store.listConversations(false)).toHaveLength(0);
    expect(h.store.getGlobalStats(null, null).costUsd).toBe('0.00485');
    h.store.purgeConversation(first.result.conversationId);
    expect(h.store.getGlobalStats(null, null).costUsd).toBe('0');
    expect(h.store.countRequests()).toBe(0);
  });

  it('全量备份与恢复可重建会话、请求与费用', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '备份回答' });
    const first = await sendFirst(h);
    const dump = h.store.dumpAll();
    const target = createStore(tempDir());
    openDbs.push(target.db);
    target.store.restoreAll(dump);
    const detail = target.store.getConversationDetail(first.result.conversationId);
    expect(detail.stats.costUsd).toBe('0.00485');
    expect(detail.stats.totalTokens).toBe(5500);
    expect(target.store.getGlobalStats(null, null).requestCount).toBe(1);
  });

  it('备份恢复拒绝未知数据表，避免注入', () => {
    const { db, store } = createStore(tempDir());
    openDbs.push(db);
    expect(() => store.restoreAll({ evil_table: [{ id: 'x' }] })).toThrow('未知数据表');
  });

  it('备份恢复拒绝未知列名与非法值类型', () => {
    const { db, store } = createStore(tempDir());
    openDbs.push(db);
    expect(() =>
      store.restoreAll({ conversations: [{ id: 'x', "id = 1; --": 'y' }] }),
    ).toThrow('未知字段');
    expect(() =>
      store.restoreAll({ conversations: [{ id: { nested: true } as unknown as string }] }),
    ).toThrow('字段类型无效');
  });

  it('会话搜索与归档互不影响费用', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const first = await sendFirst(h);
    h.store.archiveConversation(first.result.conversationId, true);
    expect(h.store.listConversations(false)).toHaveLength(0);
    expect(h.store.listConversations(true)).toHaveLength(1);
    expect(h.store.getGlobalStats(null, null).costUsd).toBe('0.00485');
  });
});

describe('价格和模型备注', () => {
  it('DeepSeek 请求记录峰谷依据与人民币价格', async () => {
    const h = harness({
      usageRaw: DEEPSEEK_USAGE_RAW,
      text: '回答',
      now: () => new Date('2026-11-02T01:30:00.000Z'),
    });
    await sendFirst(h, '峰值测试', 'deepseek', 'deepseek-flash');
    const conversationId = h.store.listConversations(false)[0].id;
    const detail = h.store.getConversationDetail(conversationId);
    const request = detail.turns[0].requests[0];
    expect(request.costAmount).toBe('0.00608');
    expect(request.costCurrency).toBe('CNY');
    const snapshot = h.store.getPricingSnapshot(request.pricingSnapshotId!);
    expect(snapshot?.billingTier).toBe('peak');
    expect(snapshot?.pricingBasis).toContain('高峰时段');
    expect(snapshot?.currency).toBe('CNY');
  });

  it('请求参数快照不包含消息正文', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const { result } = await sendFirst(h, '不该出现在参数里的正文');
    const record = h.store.getRequest(result.requestId);
    expect(record?.requestParameters).not.toContain('不该出现在参数里的正文');
    expect(record?.requestParameters).toContain('responses');
  });

  it('删除全部数据会清空费用统计但保留设置', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    await sendFirst(h);
    h.store.deleteAllData();
    expect(h.store.getGlobalStats(null, null).requestCount).toBe(0);
    expect(h.store.listConversations(true)).toHaveLength(0);
    expect(h.store.getSettings().models.openai.model).toBe('gpt-6.1-sol');
  });
});

describe('事件与状态', () => {
  it('成功完成后发出 completed，并携带本轮与会话统计', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    await sendFirst(h);
    const completed = h.events.find(
      (event): event is Extract<ChatStreamEvent, { type: 'completed' }> => event.type === 'completed',
    );
    expect(completed).toBeTruthy();
    expect(completed?.turnView.requests).toHaveLength(1);
    expect(completed?.conversationStats.requestCount).toBe(1);
    expect(h.events.some((event) => event.type === 'text_delta')).toBe(true);
  });

  it('数据库中存在价格快照且可追溯来源与生效时间', async () => {
    const h = harness({ usageRaw: OPENAI_USAGE_RAW, text: '回答' });
    const { result } = await sendFirst(h);
    const record = h.store.getRequest(result.requestId)!;
    const snapshot = h.store.getPricingSnapshot(record.pricingSnapshotId!)!;
    expect(snapshot.priceSource).toContain('developers.openai.com');
    expect(snapshot.effectiveAt).toBeTruthy();
    expect(snapshot.pricingVersion).toContain('openai');
    expect(snapshot.table.currency).toBe('USD');
  });
});
