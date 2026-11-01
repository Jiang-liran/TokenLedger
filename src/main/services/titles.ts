import type {
  ChatOptions,
  Conversation,
  ApiRequestRow,
  NormalizedUsage,
  PricingSnapshot,
  RequestStatus,
  TitleEvent,
  TitleGenerationResult,
  TitleMode,
  TurnView,
  UsageCompleteness,
} from '../../shared/types';
import type { Store, FxSnapshotRecord } from '../db/repositories';
import type { KeyStore } from './secrets';
import type { PricingService } from './pricing';
import { streamProviderChat, type StreamFunction } from './transport';
import { normalizeOpenAIResponseUsage } from '../../shared/providers/openai';
import { normalizeDeepSeekResponseUsage } from '../../shared/providers/deepseek';
import { newIdWithPrefix } from '../../shared/id';
import type { Logger } from './logger';
import { redact } from './logger';
import type { AppSettings } from '../../shared/settings';

const TITLE_SYSTEM_PROMPT =
  '你是一个会话标题生成器。根据用户的问题和助手的回答，生成一个简洁、准确、自然的简体中文标题。' +
  '标题控制在 6 到 20 个中文字符，只输出标题本身。' +
  '不要输出引号、书名号、句号、Markdown、解释、分析或“关于……的问题”“用户询问……”这类机械表达。';

const MAX_TITLE_CHARS = 20;
const MAX_TITLE_CONTEXT_CHARS = 900;

export class TitleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TitleError';
    this.code = code;
  }
}

export interface TitleServiceDeps {
  store: Store;
  secrets: KeyStore;
  pricing: PricingService;
  emit: (event: TitleEvent) => void;
  stream?: StreamFunction;
  now?: () => Date;
  logger?: Logger;
}

interface TitleTarget {
  provider: 'openai' | 'deepseek';
  model: string;
  chatProvider: 'openai' | 'deepseek';
  chatModel: string;
  crossProvider: boolean;
  capabilities: ReturnType<PricingService['getCapabilities']>;
}

interface TitleJobParams {
  conversation: Conversation;
  turn: TurnView;
  target: TitleTarget;
  mode: TitleMode;
  expectedVersion: number;
}

export function sanitizeGeneratedTitle(raw: string): string {
  let title = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  title = title
    .replace(/^(会话)?标题\s*[:：]\s*/, '')
    .replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, '')
    .replace(/[。．.!！?？；;：:]+$/g, '')
    .trim();
  // 尽量避免机械化标题；提示词已约束，这里再做一次轻量清理。
  title = title.replace(/^关于(.+?)的(问题|讨论)$/, '$1').trim();
  if (title.length > MAX_TITLE_CHARS) {
    title = Array.from(title).slice(0, MAX_TITLE_CHARS).join('');
  }
  return title;
}

export function fallbackTitleFromMessage(content: string): string {
  const normalized = content.replace(/[#*_`>\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return '新对话';
  return Array.from(normalized).slice(0, 24).join('');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function buildTitlePrompt(userContent: string, assistantContent: string): string {
  return [
    '请为下面这段对话生成一个标题。',
    '',
    '【用户问题】',
    truncate(userContent, MAX_TITLE_CONTEXT_CHARS),
    '',
    '【助手回答】',
    truncate(assistantContent, MAX_TITLE_CONTEXT_CHARS),
    '',
    '只输出一个 6～20 个中文字符的标题，不要输出任何其他内容。',
  ].join('\n');
}

export class TitleService {
  private readonly store: Store;
  private readonly secrets: KeyStore;
  private readonly pricing: PricingService;
  private readonly emit: (event: TitleEvent) => void;
  private readonly stream: StreamFunction;
  private readonly now: () => Date;
  private readonly logger?: Logger;
  private readonly busy = new Set<string>();

  constructor(deps: TitleServiceDeps) {
    this.store = deps.store;
    this.secrets = deps.secrets;
    this.pricing = deps.pricing;
    this.emit = deps.emit;
    this.stream = deps.stream ?? streamProviderChat;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger;
  }

  isGenerating(conversationId: string): boolean {
    return this.busy.has(conversationId);
  }

  /** 应用启动修复：自动标题请求中断时，回退到首条用户消息。 */
  repairStartupTitles(): number {
    try {
      const repaired = this.store.repairDefaultTitles();
      if (repaired > 0) this.logger?.info('已为中断的自动标题恢复本地标题', { repaired });
      return repaired;
    } catch (error) {
      this.logger?.warn('恢复本地标题失败', redact(error));
      return 0;
    }
  }

  /**
   * 首轮成功回复后调用。只尝试一次自动命名；不会批量重命名历史会话。
   * 失败时使用首条用户消息作为本地备用标题，不额外调用模型。
   */
  async handleAutoTitle(conversationId: string): Promise<void> {
    if (this.busy.has(conversationId)) return;
    this.busy.add(conversationId);
    try {
      const conversation = this.store.getConversation(conversationId);
      if (!conversation || conversation.deletedAt) return;
      if (conversation.titleSource !== 'default' && conversation.titleSource !== 'first_message') {
        return;
      }
      if (conversation.autoTitleAttemptedAt !== null) return;

      const detail = this.store.getConversationDetail(conversationId);
      const firstCompleted = detail.turns.find((turn) =>
        turn.assistantMessages.some(
          (message) => message.status === 'complete' && message.content.trim().length > 0,
        ),
      );
      if (!firstCompleted) return;

      const marked = this.store.markAutoTitleAttempted(conversationId, this.now().toISOString());
      if (!marked) return;

      const settings = this.store.getSettings();
      if (!settings.autoTitle.enabled) {
        await this.applyFallback(conversation, firstCompleted, '自动命名已关闭');
        return;
      }

      const target = await this.resolveTarget(settings, conversation, firstCompleted);
      if (!target.ok) {
        await this.applyFallback(conversation, firstCompleted, target.error);
        this.emit({
          type: 'failed',
          conversationId,
          requestId: null,
          mode: 'auto',
          message: target.error,
          fallbackTitle: fallbackTitleFromMessage(firstCompleted.userMessage?.content ?? ''),
        });
        return;
      }

      const result = await this.runTitleJob({
        conversation,
        turn: firstCompleted,
        target: target.target,
        mode: 'auto',
        expectedVersion: conversation.titleVersion,
      });
      if (!result.ok) {
        await this.applyFallback(conversation, firstCompleted, result.error ?? '自动命名失败');
      }
    } catch (error) {
      this.logger?.warn('自动标题任务异常', redact(error));
    } finally {
      this.busy.delete(conversationId);
    }
  }

  /** 用户主动重新生成标题；允许覆盖用户手动标题。 */
  async regenerate(conversationId: string): Promise<TitleGenerationResult> {
    if (this.busy.has(conversationId)) {
      throw new TitleError('title_busy', '标题正在生成中，请稍后再试。');
    }
    const conversation = this.store.getConversationOrThrow(conversationId);
    const detail = this.store.getConversationDetail(conversationId);
    const latestTurn = [...detail.turns]
      .reverse()
      .find((turn) =>
        turn.assistantMessages.some(
          (message) => message.status === 'complete' && message.content.trim().length > 0,
        ),
      );
    if (!latestTurn) throw new TitleError('empty_conversation', '请先完成至少一轮问答，再生成标题。');

    const settings = this.store.getSettings();
    const target = await this.resolveTarget(settings, conversation, latestTurn);
    if (!target.ok) throw new TitleError('title_config', target.error);

    this.busy.add(conversationId);
    try {
      return await this.runTitleJob({
        conversation,
        turn: latestTurn,
        target: target.target,
        mode: 'manual',
        expectedVersion: this.store.getConversation(conversationId)?.titleVersion ?? conversation.titleVersion,
      });
    } finally {
      this.busy.delete(conversationId);
    }
  }

  private async resolveTarget(
    settings: AppSettings,
    conversation: Conversation,
    turn: TurnView,
  ): Promise<{ ok: true; target: TitleTarget } | { ok: false; error: string }> {
    const chatRequest = turn.requests.find(
      (request) => request.requestPurpose === 'chat' && request.status === 'completed',
    );
    const chatProvider = chatRequest?.provider ?? conversation.defaultProvider;
    const chatModel = chatRequest?.model ?? conversation.defaultModel;

    const provider = settings.autoTitle.useCurrentChat
      ? chatProvider
      : settings.autoTitle.provider;
    const model =
      settings.autoTitle.model.trim() ||
      (settings.autoTitle.useCurrentChat
        ? chatModel
        : settings.models[provider].model);

    if (provider !== chatProvider && !settings.autoTitle.allowCrossProvider) {
      return {
        ok: false,
        error: '标题服务商与当前聊天服务商不同，但尚未允许跨服务商生成标题。',
      };
    }

    const key = await this.secrets.getKey(provider);
    if (!key) {
      return {
        ok: false,
        error: `未配置 ${provider === 'openai' ? 'OpenAI' : 'DeepSeek'} API Key，无法生成标题。`,
      };
    }

    return {
      ok: true,
      target: {
        provider,
        model,
        chatProvider,
        chatModel,
        crossProvider: provider !== chatProvider,
        capabilities: this.pricing.getCapabilities(provider, model),
      },
    };
  }

  private async applyFallback(
    conversation: Conversation,
    turn: TurnView,
    reason: string,
  ): Promise<string | null> {
    const title = fallbackTitleFromMessage(turn.userMessage?.content ?? '');
    try {
      const applied = this.store.setFallbackTitle(
        conversation.id,
        title,
        conversation.titleVersion,
        this.now().toISOString(),
      );
      if (applied) {
        this.emit({ type: 'fallback', conversationId: conversation.id, title, reason });
        return title;
      }
    } catch (error) {
      this.logger?.warn('应用备用标题失败', redact(error));
    }
    return null;
  }

  private async runTitleJob(params: TitleJobParams): Promise<TitleGenerationResult> {
    const { conversation, turn, target, mode, expectedVersion } = params;
    const startedAt = this.now();
    const requestId = newIdWithPrefix('req');
    const assistantContent =
      [...turn.assistantMessages].reverse().find((message) => message.content.trim().length > 0)
        ?.content ?? '';

    let snapshot: PricingSnapshot | null = null;
    let snapshotReason: string | null = null;
    try {
      const resolution = this.pricing.createSnapshot(target.provider, target.model, startedAt);
      snapshot = resolution.snapshot;
      snapshotReason = resolution.reason;
    } catch (error) {
      this.logger?.warn('创建标题价格快照失败', redact(error));
    }

    const requestParameters = {
      purpose: 'title_generation',
      mode,
      chatProvider: target.chatProvider,
      chatModel: target.chatModel,
      crossProvider: target.crossProvider,
      titleVersion: expectedVersion,
      contextChars: Math.min(assistantContent.length, MAX_TITLE_CONTEXT_CHARS),
    };

    try {
      this.store.insertRequestStart({
        id: requestId,
        conversationId: conversation.id,
        turnId: mode === 'auto' ? turn.turn.id : null,
        assistantMessageId: null,
        purpose: 'title_generation',
        provider: target.provider,
        model: target.model,
        startedAt: startedAt.toISOString(),
        requestParameters: JSON.stringify(requestParameters),
        pricingSnapshotId: snapshot?.id ?? null,
        pricingBasis: snapshot?.pricingBasis ?? snapshotReason,
      });
    } catch (error) {
      this.logger?.error('写入标题请求记录失败', redact(error));
      this.emit({
        type: 'failed',
        conversationId: conversation.id,
        requestId: null,
        mode,
        message: '无法写入标题请求记录，已保留原会话标题。',
      });
      return {
        ok: false,
        conversationId: conversation.id,
        mode,
        error: '无法写入标题请求记录。',
      };
    }

    this.emit({ type: 'started', conversationId: conversation.id, requestId, mode });

    let content = '';
    let usageRaw: unknown | null = null;
    let usageNormalized: NormalizedUsage | null = null;
    let usageCompleteness: UsageCompleteness = 'missing';
    let usageIssues: string[] = [];
    let providerRequestId: string | null = null;
    let status: RequestStatus = 'error';
    let failureMessage = '';
    let titleApplied = false;
    let title = '';

    try {
      const options: ChatOptions = {
        thinking: 'disabled',
        reasoningEffort: null,
        maxOutputTokens: 64,
      };
      const result = await this.stream({
        provider: target.provider,
        model: target.model,
        apiKey: (await this.secrets.getKey(target.provider)) ?? '',
        messages: [
          {
            role: 'user',
            content: buildTitlePrompt(
              turn.userMessage?.content ?? '',
              assistantContent,
            ),
          },
        ],
        systemPrompt: TITLE_SYSTEM_PROMPT,
        options,
        capabilities: target.capabilities,
        purpose: 'title_generation',
        signal: new AbortController().signal,
        onTextDelta: (delta) => {
          content += delta;
        },
        onReasoningDelta: () => {},
        onUsage: (raw) => {
          usageRaw = raw;
          const normalized =
            target.provider === 'openai'
              ? normalizeOpenAIResponseUsage(raw, target.capabilities)
              : normalizeDeepSeekResponseUsage(raw);
          usageNormalized = normalized.usage;
          usageCompleteness = normalized.completeness;
          usageIssues = normalized.issues;
        },
        onProviderRequestId: (id) => {
          providerRequestId = id;
        },
      });

      if (result.usageRaw && usageRaw === null) {
        usageRaw = result.usageRaw;
        const normalized =
          target.provider === 'openai'
            ? normalizeOpenAIResponseUsage(result.usageRaw, target.capabilities)
            : normalizeDeepSeekResponseUsage(result.usageRaw);
        usageNormalized = normalized.usage;
        usageCompleteness = normalized.completeness;
        usageIssues = normalized.issues;
      }
      providerRequestId = result.providerRequestId ?? providerRequestId;

      title = sanitizeGeneratedTitle(content);
      if (!title) throw new TitleError('empty_title', '标题模型未返回有效标题。');
      status = 'completed';
    } catch (error) {
      failureMessage =
        error instanceof Error ? error.message : '标题生成失败';
      this.logger?.warn('标题生成失败', {
        conversationId: conversation.id,
        requestId,
        error: redact(failureMessage),
      });
    }

    const endedAt = this.now().toISOString();
    const fx = snapshot?.currency === 'CNY' ? this.safeFx() : null;
    let cost: ReturnType<PricingService['computeCost']> | null = null;
    if (snapshot && usageNormalized) {
      try {
        cost = this.pricing.computeCost(snapshot, usageNormalized, fx);
      } catch (error) {
        this.logger?.warn('标题费用计算失败', redact(error));
      }
    }
    const calculationStatus = cost?.status ?? 'unknown';
    const costAmount = calculationStatus === 'unknown' ? null : (cost?.amount ?? null);
    const costCurrency = calculationStatus === 'unknown' ? null : (cost?.currency ?? null);
    const costUsd = calculationStatus === 'unknown' ? null : (cost?.usdAmount ?? null);

    const warnings: string[] = [];
    if (status === 'completed') {
      if (!usageRaw) {
        warnings.push('服务商未返回 usage：标题生成使用量与费用未知（未按 0 计费）。');
      } else if (usageCompleteness !== 'complete') {
        warnings.push(`usage 不完整：${usageIssues.join('；') || '部分字段缺失'}`);
      }
      if (!snapshot) warnings.push(snapshotReason ?? '未找到标题模型价格，费用未知。');
      if (cost?.status === 'unknown') {
        warnings.push(`费用无法准确计算：${cost.missing.join('；') || '缺少必要计费数据'}`);
      }
    } else {
      warnings.push(failureMessage || '标题生成请求失败。');
      warnings.push(
        usageRaw
          ? '已保留部分 usage，费用按该用量计算。'
          : '本次标题请求未收到 usage：使用量与费用未知（未按 0 计费）。',
      );
    }
    const details = warnings.join('；') || null;

    try {
      this.store.finishRequest({
        id: requestId,
        endedAt,
        status,
        rawUsage: usageRaw,
        normalizedUsage: usageNormalized,
        costAmount,
        costCurrency,
        costUsd,
        exchangeRateSnapshotId:
          snapshot?.currency === 'CNY' && calculationStatus === 'calculated' && fx ? fx.id : null,
        calculationStatus,
        errorDetails: details,
        providerRequestId,
      });
    } catch (error) {
      this.logger?.error('保存标题请求费用失败', redact(error));
    }

    if (status === 'completed' && title) {
      try {
        titleApplied = this.store.setGeneratedTitle(
          conversation.id,
          title,
          expectedVersion,
          mode === 'auto' ? 'ai_auto' : 'ai_manual',
          mode === 'manual',
          endedAt,
        );
      } catch (error) {
        this.logger?.warn('保存 AI 标题失败', redact(error));
      }
    }

    if (mode === 'auto' && !titleApplied && status !== 'completed') {
      // 自动标题失败后由调用方回退到首条用户消息。
    }

    const request = this.store.getApiRequestRow(requestId);
    const conversationStats = this.store.getConversationStats(conversation.id);
    const turnView = mode === 'auto' ? this.store.getTurnView(turn.turn.id) : null;

    if (status === 'completed' && titleApplied) {
      this.emit({
        type: 'completed',
        conversationId: conversation.id,
        requestId,
        mode,
        title,
        request: request ?? this.emptyRequest(requestId, target, startedAt),
        conversationStats,
        turnView,
        applied: true,
      });
      return { ok: true, conversationId: conversation.id, title, requestId, mode };
    }

    if (status === 'completed' && title && !titleApplied) {
      failureMessage =
        '标题已生成，但会话标题在生成期间被手动修改，因此未覆盖；该请求费用已记录。';
    }

    const errorMessage = failureMessage || '标题生成失败，已保留原会话标题。';
    this.emit({
      type: 'failed',
      conversationId: conversation.id,
      requestId,
      mode,
      message: errorMessage,
    });
    return {
      ok: false,
      conversationId: conversation.id,
      title: title || undefined,
      requestId,
      mode,
      error: errorMessage,
    };
  }

  private safeFx(): FxSnapshotRecord | null {
    try {
      return this.pricing.ensureFxSnapshot();
    } catch (error) {
      this.logger?.warn('读取标题汇率快照失败', redact(error));
      return null;
    }
  }

  private emptyRequest(id: string, target: TitleTarget, startedAt: Date): ApiRequestRow {
    return {
      id,
      provider: target.provider,
      model: target.model,
      startedAt: startedAt.toISOString(),
      status: 'error',
      requestPurpose: 'title_generation',
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      totalTokens: null,
      costAmount: null,
      costCurrency: null,
      costUsd: null,
      calculationStatus: 'unknown',
      errorDetails: null,
      pricingSnapshotId: null,
      pricingVersion: null,
      pricingBasis: null,
    };
  }
}
