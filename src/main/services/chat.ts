import type {
  BudgetAlert,
  ChatMessageInput,
  ChatOptions,
  ChatSendResult,
  ChatStreamEvent,
  Conversation,
  ConversationDetail,
  ConversationStats,
  CostResult,
  Currency,
  ModelCapabilities,
  NormalizedUsage,
  PricingSnapshot,
  ProviderId,
  TurnView,
  UsageCompleteness,
} from '../../shared/types';
import type { SendMessagePayload } from '../../shared/ipc';
import type { Store } from '../db/repositories';
import type { FxSnapshotRecord } from '../db/repositories';
import type { KeyStore } from './secrets';
import type { PricingService } from './pricing';
import { streamProviderChat, type StreamFunction } from './transport';
import { normalizeOpenAIResponseUsage } from '../../shared/providers/openai';
import { normalizeDeepSeekResponseUsage } from '../../shared/providers/deepseek';
import { newIdWithPrefix } from '../../shared/id';
import { truncateTitle } from '../../shared/cost/format';
import { evaluateBudget, localDayEnd, localDayStart } from './budget';
import type { Logger } from './logger';
import { redact } from './logger';
import type { AppSettings } from '../../shared/settings';

export class ChatError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

export interface ChatDeps {
  store: Store;
  secrets: KeyStore;
  pricing: PricingService;
  emit: (event: ChatStreamEvent) => void;
  emitBudgetAlert?: (alert: BudgetAlert) => void;
  /** 首轮（或首个成功回复）完成后通知标题服务；不阻塞聊天完成事件。 */
  onTurnCompleted?: (conversationId: string) => void;
  stream?: StreamFunction;
  now?: () => Date;
  logger?: Logger;
}

interface InFlight {
  abort: AbortController;
  conversationId: string;
  turnId: string;
  assistantMessageId: string;
}

interface RunParams {
  requestId: string;
  conversation: Conversation;
  turnId: string;
  assistantMessageId: string;
  provider: ProviderId;
  model: string;
  apiKey: string;
  capabilities: ModelCapabilities;
  options: ChatOptions;
  contextMessages: ChatMessageInput[];
  contextTruncated: boolean;
  snapshot: PricingSnapshot | null;
  snapshotReason: string | null;
  startedAt: string;
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
};

export function buildContext(
  messages: ChatMessageInput[],
  maxMessages: number,
  maxChars: number,
): { messages: ChatMessageInput[]; truncated: boolean } {
  const valid = messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') && message.content.trim() !== '',
  );
  const selected = valid.slice(-Math.max(1, maxMessages));
  const truncatedByMessages = selected.length < valid.length;
  let chars = selected.reduce((total, message) => total + message.content.length, 0);
  let truncatedByChars = false;
  while (selected.length > 1 && chars > maxChars) {
    const removed = selected.shift();
    chars -= removed?.content.length ?? 0;
    truncatedByChars = true;
  }
  return { messages: selected, truncated: truncatedByMessages || truncatedByChars };
}

function validEffort(value: unknown): ChatOptions['reasoningEffort'] {
  return ['minimal', 'low', 'medium', 'high', 'max'].includes(String(value))
    ? (value as ChatOptions['reasoningEffort'])
    : null;
}

export class ChatService {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly stream: StreamFunction;
  private readonly now: () => Date;

  constructor(private readonly deps: ChatDeps) {
    this.stream = deps.stream ?? streamProviderChat;
    this.now = deps.now ?? (() => new Date());
  }

  private emit(event: ChatStreamEvent): void {
    try {
      this.deps.emit(event);
    } catch (error) {
      this.deps.logger?.warn('向渲染进程发送事件失败', redact(error));
    }
  }

  private resolveOptions(
    provider: ProviderId,
    options: ChatOptions | undefined,
    settings: AppSettings,
  ): ChatOptions {
    const defaults = settings.models[provider];
    return {
      reasoningEffort:
        options?.reasoningEffort !== undefined
          ? validEffort(options.reasoningEffort)
          : defaults.reasoningEffort,
      thinking: options?.thinking ?? defaults.thinking,
      maxOutputTokens: options?.maxOutputTokens ?? null,
    };
  }

  private async requireKey(provider: ProviderId): Promise<string> {
    const key = await this.deps.secrets.getKey(provider);
    if (!key) {
      throw new ChatError(
        'missing_api_key',
        `请先在设置中填写 ${PROVIDER_LABEL[provider]} API Key 并测试连接。`,
      );
    }
    return key;
  }

  private contextFor(
    conversationId: string,
    excludeIds: string[],
    settings: AppSettings,
    extra: ChatMessageInput[] = [],
  ): { messages: ChatMessageInput[]; truncated: boolean } {
    const stored = this.deps.store.listContextMessages(conversationId, excludeIds);
    const mapped: ChatMessageInput[] = stored.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    return buildContext(
      [...mapped, ...extra],
      settings.maxContextMessages,
      settings.maxContextChars,
    );
  }

  async send(payload: SendMessagePayload): Promise<ChatSendResult> {
    const content = (payload.content ?? '').trim();
    if (!content) throw new ChatError('empty_message', '消息不能为空。');
    if (content.length > 200_000) throw new ChatError('message_too_long', '单条消息过长（上限 20 万字符）。');
    if (payload.provider !== 'openai' && payload.provider !== 'deepseek') {
      throw new ChatError('invalid_provider', '不支持的服务商。');
    }
    const provider = payload.provider;
    const model = (payload.model ?? '').trim();
    if (!model) throw new ChatError('missing_model', '请选择或输入模型 ID。');

    const apiKey = await this.requireKey(provider);
    const settings = this.deps.store.getSettings();
    const now = this.now();
    const startedAt = now.toISOString();

    let conversation: Conversation;
    if (payload.conversationId) {
      conversation = this.deps.store.getConversationOrThrow(payload.conversationId);
    } else {
      conversation = this.deps.store.createConversation({
        title: truncateTitle(content, 48),
        provider,
        model,
        now: startedAt,
      });
    }

    if (conversation.defaultProvider !== provider || conversation.defaultModel !== model) {
      this.deps.store.updateConversationMeta(conversation.id, provider, model, startedAt);
      conversation = { ...conversation, defaultProvider: provider, defaultModel: model };
    }

    const capabilities = this.deps.pricing.getCapabilities(provider, model);
    const options = this.resolveOptions(provider, payload.options, settings);
    const resolution = this.deps.pricing.createSnapshot(provider, model, now);
    const requestId = newIdWithPrefix('req');
    const turnId = newIdWithPrefix('turn');
    const userMessageId = newIdWithPrefix('msg');
    const assistantMessageId = newIdWithPrefix('msg');

    const context = this.contextFor(
      conversation.id,
      [userMessageId, assistantMessageId],
      settings,
      [{ role: 'user', content }],
    );

    const requestParameters = {
      api: provider === 'openai' ? 'responses' : 'chat.completions',
      purpose: 'chat',
      model,
      provider,
      stream: true,
      store: false,
      contextMessageCount: context.messages.length,
      contextTruncated: context.truncated,
      systemPromptIncluded: !!conversation.systemPrompt,
      reasoningEffort: options.reasoningEffort ?? null,
      thinking: options.thinking ?? 'default',
      maxOutputTokens: options.maxOutputTokens ?? null,
      pricingSnapshotId: resolution.snapshot?.id ?? null,
      pricingReason: resolution.reason,
    };

    this.deps.store.transaction(() => {
      this.deps.store.createTurn({
        turnId,
        conversationId: conversation.id,
        userMessageId,
        assistantMessageId,
        content,
        provider,
        model,
        now: startedAt,
        attempt: 1,
      });
      this.deps.store.insertRequestStart({
        id: requestId,
        conversationId: conversation.id,
        turnId,
        assistantMessageId,
        provider,
        model,
        startedAt,
        requestParameters: JSON.stringify(requestParameters),
        purpose: 'chat',
        pricingSnapshotId: resolution.snapshot?.id ?? null,
        pricingBasis: resolution.snapshot?.pricingBasis ?? resolution.reason,
      });
    });

    this.emit({
      type: 'request_started',
      requestId,
      conversationId: conversation.id,
      turnId,
      assistantMessageId,
      startedAt,
    });

    const userMessage = this.deps.store.getMessage(userMessageId);
    const assistantMessage = this.deps.store.getMessage(assistantMessageId);
    if (!userMessage || !assistantMessage) throw new ChatError('db_error', '创建消息失败。');

    void this.runStream({
      requestId,
      conversation,
      turnId,
      assistantMessageId,
      provider,
      model,
      apiKey,
      capabilities,
      options,
      contextMessages: context.messages,
      contextTruncated: context.truncated,
      snapshot: resolution.snapshot,
      snapshotReason: resolution.reason,
      startedAt,
    });

    return {
      requestId,
      conversationId: conversation.id,
      turnId,
      assistantMessageId,
      userMessage,
      assistantMessage,
      conversation,
    };
  }

  async regenerate(
    turnId: string,
    assistantMessageId: string | null,
    provider: ProviderId,
    model: string,
  ): Promise<ChatSendResult> {
    if (provider !== 'openai' && provider !== 'deepseek') {
      throw new ChatError('invalid_provider', '不支持的服务商。');
    }
    const modelId = (model ?? '').trim();
    if (!modelId) throw new ChatError('missing_model', '请选择或输入模型 ID。');
    const turn = this.deps.store.getTurn(turnId);
    if (!turn) throw new ChatError('turn_not_found', '该轮对话不存在。');
    const conversation = this.deps.store.getConversationOrThrow(turn.conversationId);
    const userMessage = turn.userMessageId ? this.deps.store.getMessage(turn.userMessageId) : null;
    if (!userMessage) throw new ChatError('message_not_found', '找不到该轮的用户消息。');

    const apiKey = await this.requireKey(provider);
    const settings = this.deps.store.getSettings();
    const now = this.now();
    const startedAt = now.toISOString();

    const attempts = this.deps.store
      .listMessages(conversation.id)
      .filter((message) => message.turnId === turnId && message.role === 'assistant');
    const previous =
      (assistantMessageId ? attempts.find((message) => message.id === assistantMessageId) : null) ??
      attempts[attempts.length - 1] ??
      null;

    const capabilities = this.deps.pricing.getCapabilities(provider, modelId);
    const options = this.resolveOptions(provider, undefined, settings);
    const resolution = this.deps.pricing.createSnapshot(provider, modelId, now);
    const requestId = newIdWithPrefix('req');
    const newAssistantId = newIdWithPrefix('msg');

    const context = this.contextFor(
      conversation.id,
      [...attempts.map((message) => message.id), newAssistantId],
      settings,
    );

    const requestParameters = {
      api: provider === 'openai' ? 'responses' : 'chat.completions',
      model: modelId,
      provider,
      stream: true,
      store: false,
      regenerateOf: previous?.id ?? null,
      contextMessageCount: context.messages.length,
      contextTruncated: context.truncated,
      reasoningEffort: options.reasoningEffort ?? null,
      thinking: options.thinking ?? 'default',
      pricingSnapshotId: resolution.snapshot?.id ?? null,
      pricingReason: resolution.reason,
    };

    const created = this.deps.store.transaction(() => {
      if (previous) this.deps.store.supersedeMessage(previous.id, startedAt);
      const attempt = this.deps.store.incrementAttempt(turnId);
      const message = this.deps.store.createAssistantAttempt({
        id: newAssistantId,
        conversationId: conversation.id,
        turnId,
        provider,
        model: modelId,
        attempt,
        now: startedAt,
      });
      this.deps.store.insertRequestStart({
        id: requestId,
        conversationId: conversation.id,
        turnId,
        assistantMessageId: newAssistantId,
        provider,
        model: modelId,
        startedAt,
        requestParameters: JSON.stringify(requestParameters),
        purpose: 'chat',
        pricingSnapshotId: resolution.snapshot?.id ?? null,
        pricingBasis: resolution.snapshot?.pricingBasis ?? resolution.reason,
      });
      this.deps.store.updateConversationMeta(conversation.id, provider, modelId, startedAt);
      return message;
    });

    this.emit({
      type: 'request_started',
      requestId,
      conversationId: conversation.id,
      turnId,
      assistantMessageId: newAssistantId,
      startedAt,
    });

    void this.runStream({
      requestId,
      conversation: { ...conversation, defaultProvider: provider, defaultModel: modelId },
      turnId,
      assistantMessageId: newAssistantId,
      provider,
      model: modelId,
      apiKey,
      capabilities,
      options,
      contextMessages: context.messages,
      contextTruncated: context.truncated,
      snapshot: resolution.snapshot,
      snapshotReason: resolution.reason,
      startedAt,
    });

    return {
      requestId,
      conversationId: conversation.id,
      turnId,
      assistantMessageId: newAssistantId,
      userMessage,
      assistantMessage: created,
      conversation: { ...conversation, defaultProvider: provider, defaultModel: modelId },
    };
  }

  abort(requestId: string): void {
    const entry = this.inFlight.get(requestId);
    if (entry) entry.abort.abort();
  }

  abortAll(): void {
    for (const entry of this.inFlight.values()) entry.abort.abort();
  }

  private async runStream(params: RunParams): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(params.requestId, {
      abort: controller,
      conversationId: params.conversation.id,
      turnId: params.turnId,
      assistantMessageId: params.assistantMessageId,
    });

    let content = '';
    let reasoning = '';
    let usageRaw: unknown | null = null;
    let usageNormalized: NormalizedUsage | null = null;
    let usageCompleteness: UsageCompleteness = 'missing';
    let usageIssues: string[] = [];
    let providerRequestId: string | null = null;
    let lastPersistAt = Date.now();

    const persistPartial = () => {
      const now = Date.now();
      if (now - lastPersistAt < 1500) return;
      lastPersistAt = now;
      try {
        this.deps.store.updateAssistantMessage(params.assistantMessageId, {
          content,
          reasoningContent: reasoning || null,
        });
      } catch (error) {
        this.deps.logger?.warn('保存流式内容失败', redact(error));
      }
    };

    try {
      const result = await this.stream({
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        messages: params.contextMessages,
        systemPrompt: params.conversation.systemPrompt,
        options: params.options,
        capabilities: params.capabilities,
        signal: controller.signal,
        onTextDelta: (delta) => {
          if (controller.signal.aborted) return;
          content += delta;
          persistPartial();
          this.emit({ type: 'text_delta', requestId: params.requestId, delta });
        },
        onReasoningDelta: (delta) => {
          if (controller.signal.aborted) return;
          reasoning += delta;
          persistPartial();
          this.emit({ type: 'reasoning_delta', requestId: params.requestId, delta });
        },
        onUsage: (raw) => {
          usageRaw = raw;
          const normalized =
            params.provider === 'openai'
              ? normalizeOpenAIResponseUsage(raw, params.capabilities)
              : normalizeDeepSeekResponseUsage(raw);
          usageNormalized = normalized.usage;
          usageCompleteness = normalized.completeness;
          usageIssues = normalized.issues;
          this.emit({
            type: 'usage_received',
            requestId: params.requestId,
            usage: normalized.usage,
            completeness: normalized.completeness,
          });
        },
        onProviderRequestId: (id) => {
          providerRequestId = id;
          this.emit({ type: 'provider_meta', requestId: params.requestId, providerRequestId: id });
        },
      });

      if (result.usageRaw && usageRaw === null) {
        usageRaw = result.usageRaw;
        const normalized =
          params.provider === 'openai'
            ? normalizeOpenAIResponseUsage(result.usageRaw, params.capabilities)
            : normalizeDeepSeekResponseUsage(result.usageRaw);
        usageNormalized = normalized.usage;
        usageCompleteness = normalized.completeness;
        usageIssues = normalized.issues;
      }
      if (result.providerRequestId && !providerRequestId) {
        providerRequestId = result.providerRequestId;
      }

      await this.finishSuccess(params, {
        content,
        reasoning,
        usageRaw,
        usageNormalized,
        usageCompleteness,
        usageIssues,
        providerRequestId,
        finishStatus: result.finishStatus,
        note: result.note,
      });
    } catch (error) {
      await this.finishFailure(params, error, controller.signal.aborted, {
        content,
        reasoning,
        usageRaw,
        usageNormalized,
        usageIssues,
        providerRequestId,
      });
    } finally {
      this.inFlight.delete(params.requestId);
    }
  }

  private safeFx(): FxSnapshotRecord | null {
    try {
      return this.deps.pricing.ensureFxSnapshot();
    } catch (error) {
      this.deps.logger?.warn('读取汇率快照失败', redact(error));
      return null;
    }
  }

  private computeCost(
    snapshot: PricingSnapshot | null,
    usage: NormalizedUsage | null,
  ): { cost: CostResult | null; fx: FxSnapshotRecord | null } {
    if (!snapshot || !usage) return { cost: null, fx: null };
    const fx = snapshot.currency === 'CNY' ? this.safeFx() : null;
    try {
      return { cost: this.deps.pricing.computeCost(snapshot, usage, fx), fx };
    } catch (error) {
      this.deps.logger?.error('费用计算异常', redact(error));
      return { cost: null, fx };
    }
  }

  private async finishSuccess(
    params: RunParams,
    result: {
      content: string;
      reasoning: string;
      usageRaw: unknown | null;
      usageNormalized: NormalizedUsage | null;
      usageCompleteness: UsageCompleteness;
      usageIssues: string[];
      providerRequestId: string | null;
      finishStatus: 'completed' | 'incomplete';
      note?: string;
    },
  ): Promise<void> {
    const endedAt = this.now().toISOString();
    const { cost, fx } = this.computeCost(params.snapshot, result.usageNormalized);
    const calculationStatus = cost?.status ?? 'unknown';
    const costAmount = cost?.status === 'unknown' ? null : (cost?.amount ?? null);
    const costCurrency: Currency | null =
      cost?.status === 'unknown' ? null : (cost?.currency ?? params.snapshot?.currency ?? null);
    const costUsd = cost?.status === 'unknown' ? null : (cost?.usdAmount ?? null);

    const warnings: string[] = [];
    if (result.finishStatus === 'incomplete') {
      warnings.push(result.note ?? '回答未完整生成。');
    }
    if (!result.usageRaw) {
      warnings.push('服务商未返回 usage：本次使用量与费用未知（未按 0 计费）。');
    } else if (result.usageCompleteness !== 'complete') {
      warnings.push(`usage 不完整：${result.usageIssues.join('；') || '部分字段缺失'}`);
    }
    if (cost?.status === 'unknown') {
      warnings.push(
        `费用无法准确计算：${cost.missing.join('；') || params.snapshotReason || '缺少必要计费数据'}`,
      );
    }
    if (!params.snapshot) {
      warnings.push(params.snapshotReason ?? '未找到该模型的价格，费用未知。');
    }

    const messageErrorDetails = warnings.length > 0 ? warnings.join('\n') : null;
    const requestErrorDetails = warnings.length > 0 ? warnings.join('；') : null;

    try {
      this.deps.store.transaction(() => {
        this.deps.store.updateAssistantMessage(params.assistantMessageId, {
          content: result.content,
          reasoningContent: result.reasoning || null,
          status: 'complete',
          errorDetails: messageErrorDetails,
        });
        this.deps.store.finishRequest({
          id: params.requestId,
          endedAt,
          status: 'completed',
          rawUsage: result.usageRaw,
          normalizedUsage: result.usageNormalized,
          costAmount,
          costCurrency,
          costUsd,
          exchangeRateSnapshotId:
            params.snapshot?.currency === 'CNY' && cost?.status === 'calculated' && fx ? fx.id : null,
          calculationStatus,
          errorDetails: requestErrorDetails,
          providerRequestId: result.providerRequestId,
        });
        this.deps.store.setTurnStatus(params.turnId, 'completed');
        this.deps.store.touchConversation(params.conversation.id, endedAt);
      });
    } catch (error) {
      this.deps.logger?.error('保存请求结果失败', redact(error));
      this.emit({
        type: 'failed',
        requestId: params.requestId,
        conversationId: params.conversation.id,
        turnId: params.turnId,
        assistantMessageId: params.assistantMessageId,
        code: 'db_error',
        message: '回答已收到，但保存到本地数据库失败。请检查磁盘空间后重试。',
        detail: redact(error),
        partialUsage: result.usageNormalized,
        request: null,
        turnView: null,
        conversationStats: null,
      });
      return;
    }

    const detail = this.loadDetail(params.conversation.id);
    const turnView = detail?.turns.find((view) => view.turn.id === params.turnId) ?? null;
    const message = this.deps.store.getMessage(params.assistantMessageId);
    const request = turnView?.requests.find((row) => row.id === params.requestId) ?? null;
    if (!message || !request || !turnView || !detail) {
      this.deps.logger?.warn('请求完成后无法读取详情', params.requestId);
      this.emit({
        type: 'failed',
        requestId: params.requestId,
        conversationId: params.conversation.id,
        turnId: params.turnId,
        assistantMessageId: params.assistantMessageId,
        code: 'db_error',
        message: '回答已保存，但读取会话详情失败。请刷新或重新打开该会话。',
        partialUsage: result.usageNormalized,
        request,
        turnView,
        conversationStats: detail?.stats ?? null,
      });
      return;
    }

    const budgetAlerts = this.buildBudgetAlerts(turnView, detail.stats, params, endedAt);
    for (const alert of budgetAlerts) {
      try {
        this.deps.emitBudgetAlert?.(alert);
      } catch {
        // 预算提醒失败不影响主流程。
      }
    }

    this.emit({
      type: 'completed',
      requestId: params.requestId,
      conversationId: params.conversation.id,
      turnId: params.turnId,
      assistantMessageId: params.assistantMessageId,
      message,
      request,
      turnView,
      conversationStats: detail.stats,
      budgetAlerts,
    });

    if (this.deps.onTurnCompleted) {
      try {
        this.deps.onTurnCompleted(params.conversation.id);
      } catch (error) {
        this.deps.logger?.warn('触发标题生成失败', redact(error));
      }
    }
  }

  private loadDetail(conversationId: string): ConversationDetail | null {
    try {
      return this.deps.store.getConversationDetail(conversationId);
    } catch (error) {
      this.deps.logger?.warn('读取会话详情失败', redact(error));
      return null;
    }
  }

  private buildBudgetAlerts(
    turnView: TurnView,
    conversationStats: ConversationStats,
    params: RunParams,
    endedAt: string,
  ): BudgetAlert[] {
    const settings = this.deps.store.getSettings();
    if (!settings.budget.enabled) return [];
    try {
      const end = new Date(endedAt);
      const daily = this.deps.store.getGlobalStats(
        localDayStart(end).toISOString(),
        localDayEnd(end).toISOString(),
      );
      const total = this.deps.store.getGlobalStats(null, null);
      return evaluateBudget(
        settings.budget,
        {
          turnUsd: turnView.stats.costUsd,
          conversationUsd: conversationStats.costUsd,
          dailyUsd: daily.costUsd,
          totalUsd: total.costUsd,
        },
        { conversationId: params.conversation.id, turnId: params.turnId },
      );
    } catch (error) {
      this.deps.logger?.warn('预算提醒计算失败', redact(error));
      return [];
    }
  }

  private async finishFailure(
    params: RunParams,
    error: unknown,
    aborted: boolean,
    partial: {
      content: string;
      reasoning: string;
      usageRaw: unknown | null;
      usageNormalized: NormalizedUsage | null;
      usageIssues: string[];
      providerRequestId: string | null;
    },
  ): Promise<void> {
    const endedAt = this.now().toISOString();
    const { cost, fx } = this.computeCost(params.snapshot, partial.usageNormalized);
    const calculationStatus = cost?.status ?? 'unknown';
    const costAmount = cost?.status === 'unknown' ? null : (cost?.amount ?? null);
    const costCurrency: Currency | null =
      cost?.status === 'unknown' ? null : (cost?.currency ?? params.snapshot?.currency ?? null);
    const costUsd = cost?.status === 'unknown' ? null : (cost?.usdAmount ?? null);

    const errorInfo = this.describeError(error, aborted);
    const messageStatus = 'error' as const;
    const requestStatus = aborted
      ? ('aborted' as const)
      : errorInfo.code === 'stream_interrupted'
        ? ('interrupted' as const)
        : ('error' as const);
    const turnStatus = aborted ? ('aborted' as const) : ('error' as const);

    const warnings: string[] = [];
    if (partial.usageRaw) {
      warnings.push('已收到部分 usage，费用按该用量计算。');
    } else {
      warnings.push('本次请求未收到 usage：使用量与费用未知（未按 0 计费）。');
    }
    if (cost?.status === 'unknown') {
      warnings.push(`费用无法准确计算：${cost.missing.join('；') || '缺少必要计费数据'}`);
    }
    const details = [errorInfo.message, ...warnings].join('\n');

    try {
      this.deps.store.transaction(() => {
        this.deps.store.updateAssistantMessage(params.assistantMessageId, {
          content: partial.content,
          reasoningContent: partial.reasoning || null,
          status: messageStatus,
          errorDetails: details,
        });
        this.deps.store.finishRequest({
          id: params.requestId,
          endedAt,
          status: requestStatus,
          rawUsage: partial.usageRaw,
          normalizedUsage: partial.usageNormalized,
          costAmount,
          costCurrency,
          costUsd,
          exchangeRateSnapshotId:
            params.snapshot?.currency === 'CNY' && cost?.status === 'calculated' && fx ? fx.id : null,
          calculationStatus,
          errorDetails: details,
          providerRequestId: partial.providerRequestId,
        });
        this.deps.store.setTurnStatus(params.turnId, turnStatus);
        this.deps.store.touchConversation(params.conversation.id, endedAt);
      });
    } catch (dbError) {
      this.deps.logger?.error('保存失败请求结果时出错', redact(dbError));
    }

    const detail = this.loadDetail(params.conversation.id);
    const turnView = detail?.turns.find((view) => view.turn.id === params.turnId) ?? null;
    const request = turnView?.requests.find((row) => row.id === params.requestId) ?? null;

    if (aborted) {
      this.emit({
        type: 'aborted',
        requestId: params.requestId,
        conversationId: params.conversation.id,
        turnId: params.turnId,
        assistantMessageId: params.assistantMessageId,
        message: '已停止生成。已保留已收到的内容；本次用量未知，不计为 $0。',
        turnView,
        conversationStats: detail?.stats ?? null,
      });
      return;
    }

    this.emit({
      type: 'failed',
      requestId: params.requestId,
      conversationId: params.conversation.id,
      turnId: params.turnId,
      assistantMessageId: params.assistantMessageId,
      code: errorInfo.code,
      message: errorInfo.message,
      detail: errorInfo.detail,
      partialUsage: partial.usageNormalized,
      request,
      turnView,
      conversationStats: detail?.stats ?? null,
    });
  }

  private describeError(
    error: unknown,
    aborted: boolean,
  ): { code: string; message: string; detail?: string } {
    if (aborted) {
      return { code: 'aborted', message: '已停止生成。' };
    }
    const err = error as { code?: string; message?: string; status?: number; detail?: string; name?: string };
    if (err?.code === 'invalid_api_key') {
      return { code: 'invalid_api_key', message: err.message ?? 'API Key 无效。', detail: err.detail };
    }
    if (err?.code === 'stream_interrupted') {
      return {
        code: 'stream_interrupted',
        message: err.message ?? '流式响应中断。',
        detail: err.detail,
      };
    }
    if (typeof err?.code === 'string' && typeof err?.message === 'string') {
      return { code: err.code, message: err.message, detail: err.detail };
    }
    if (err?.name === 'AbortError') {
      return { code: 'aborted', message: '已停止生成。' };
    }
    return {
      code: 'internal_error',
      message: '请求失败。',
      detail: redact(error instanceof Error ? error.message : error),
    };
  }
}
