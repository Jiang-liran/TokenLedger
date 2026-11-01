/**
 * TokenLedger 共享领域类型。
 * 这些类型同时被主进程、渲染进程与测试使用，不依赖 Electron / Node。
 */

export type ProviderId = 'openai' | 'deepseek';

export type Currency = 'USD' | 'CNY';

export type Role = 'system' | 'user' | 'assistant';

/** 一次 API 请求的业务用途。历史请求默认为 chat。 */
export type RequestPurpose = 'chat' | 'title_generation';

export type TitleSource = 'default' | 'first_message' | 'ai_auto' | 'ai_manual' | 'manual';

export type TitleMode = 'auto' | 'manual';

export type RequestStatus =
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'interrupted';

export type MessageStatus =
  | 'streaming'
  | 'complete'
  | 'error'
  | 'superseded';

export type TurnStatus = 'running' | 'completed' | 'error' | 'aborted' | 'interrupted';

/** 费用计算状态：绝不用 0 表示“未知”。 */
export type CalculationStatus = 'calculated' | 'partial' | 'unknown';

export type BillingTier = 'standard' | 'peak' | 'offpeak' | 'unknown';

export type ContextTier = 'short' | 'long' | 'none';

/**
 * 规范化后的 usage。
 * - null 表示服务商未提供该字段（未知），不得当作 0。
 * - reasoningTokens 已包含在 outputTokens 内，禁止重复相加。
 * - cacheReadTokens 从属于 inputTokens，不额外相加。
 * - cacheWriteTokens 从属于 inputTokens，不额外相加。
 */
export interface NormalizedUsage {
  inputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite30mTokens: number | null;
  cacheWrite12hTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export type UsageCompleteness = 'complete' | 'partial' | 'missing';

export interface UsageNormalization {
  usage: NormalizedUsage;
  completeness: UsageCompleteness;
  issues: string[];
  rawUsage: unknown;
}

/** 一档价格表，单位：每百万 Token 的金额（十进制字符串）。 */
export interface PriceTable {
  inputPerM: string;
  cachedInputPerM: string | null;
  cacheWrite30mPerM: string | null;
  cacheWrite12hPerM: string | null;
  outputPerM: string;
  currency: Currency;
}

export interface ModelCapabilities {
  /** 是否支持推理强度参数 */
  reasoningEffort: boolean;
  /** 是否支持思考模式开关（DeepSeek thinking） */
  thinkingToggle: boolean;
  /** 是否支持 prompt_cache_options / 缓存写入计费 */
  cacheWrite: boolean;
  /** 是否支持温度参数 */
  temperature: boolean;
  /** 是否支持 Responses API（OpenAI） */
  responsesApi: boolean;
  /** 是否为纯文本聊天模型 */
  textChat: boolean;
}

export interface ModelPricing {
  provider: ProviderId;
  model: string;
  displayName: string;
  currency: Currency;
  pricingVersion: string;
  priceSource: string;
  lastVerifiedAt: string;
  effectiveFrom: string;
  /** 是否需要峰谷时段判断（DeepSeek） */
  tariff: 'deepseek-peak-offpeak' | null;
  /** 高峰价（标准价） */
  standard: PriceTable;
  /** 低谷价（若适用），由时段规则选择 */
  offPeak: PriceTable | null;
  longContext: (PriceTable & { thresholdTokens: number }) | null;
  capabilities: ModelCapabilities;
  status: 'verified' | 'unverified';
  notes: string[];
  aliases: string[];
}

/** 落到数据库里的不可变价格快照。 */
export interface PricingSnapshot {
  id: string;
  provider: ProviderId;
  model: string;
  pricingVersion: string;
  priceSource: string;
  effectiveAt: string;
  currency: Currency;
  billingTier: BillingTier;
  table: PriceTable;
  longContext: (PriceTable & { thresholdTokens: number }) | null;
  pricingBasis: string;
  isUserOverride: boolean;
  notes: string[];
}

export interface CostBreakdownItem {
  label: string;
  tokens: number | null;
  unitPricePerM: string | null;
  amount: string | null;
}

export interface CostResult {
  status: CalculationStatus;
  currency: Currency;
  /** 原生币种金额（高精度十进制字符串）。null 表示无法计算。 */
  amount: string | null;
  /** 美元折算金额。null 表示没有可靠汇率或无法计算。 */
  usdAmount: string | null;
  fxRate: string | null;
  fxSource: string | null;
  breakdown: CostBreakdownItem[];
  missing: string[];
  notes: string[];
  contextTier: ContextTier;
}

export interface ChatMessageInput {
  role: Role;
  content: string;
}

export interface ChatOptions {
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'max' | null;
  thinking?: 'default' | 'enabled' | 'disabled';
  maxOutputTokens?: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  defaultProvider: ProviderId;
  defaultModel: string;
  systemPrompt: string | null;
  /** 标题来源：默认占位、首条消息备用、AI 自动、AI 手动、用户手动 */
  titleSource: TitleSource;
  titleVersion: number;
  titleGeneratedAt: string | null;
  /** 自动标题是否已经尝试过；历史升级会话会预填此字段，避免批量重命名 */
  autoTitleAttemptedAt: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  turnId: string | null;
  role: Role;
  content: string;
  reasoningContent: string | null;
  model: string | null;
  provider: ProviderId | null;
  createdAt: string;
  status: MessageStatus;
  attempt: number;
  supersededAt: string | null;
  errorDetails: string | null;
}

export interface StoredTurn {
  id: string;
  conversationId: string;
  userMessageId: string | null;
  createdAt: string;
  status: TurnStatus;
  attemptCount: number;
}

export interface ApiRequestRecord {
  id: string;
  providerRequestId: string | null;
  conversationId: string;
  turnId: string | null;
  assistantMessageId: string | null;
  provider: ProviderId;
  model: string;
  startedAt: string;
  endedAt: string | null;
  status: RequestStatus;
  requestPurpose: RequestPurpose;
  requestParameters: string | null;
  rawUsage: string | null;
  normalizedUsage: string | null;
  pricingSnapshotId: string | null;
  costAmount: string | null;
  costCurrency: Currency | null;
  costUsd: string | null;
  exchangeRateSnapshotId: string | null;
  calculationStatus: CalculationStatus;
  pricingBasis: string | null;
  errorDetails: string | null;
}

export interface ConversationStats {
  conversationId: string;
  requestCount: number;
  turnCount: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  tokensUnknownRequestCount: number;
  costUsd: string;
  costUsdComplete: boolean;
  nativeCosts: { currency: Currency; amount: string; requestCount: number }[];
  unknownCostRequestCount: number;
  partialCostRequestCount: number;
  cacheHitRatio: number | null;
  byModel: {
    provider: ProviderId;
    model: string;
    requestCount: number;
    totalTokens: number;
    costUsd: string;
  }[];
  byProvider: {
    provider: ProviderId;
    requestCount: number;
    totalTokens: number;
    costUsd: string;
  }[];
}

export interface TimeBucket {
  date: string;
  totalTokens: number;
  costUsd: string;
  requestCount: number;
}

export interface GlobalStats {
  range: { from: string | null; to: string | null };
  requestCount: number;
  conversationCount: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  tokensUnknownRequestCount: number;
  costUsd: string;
  costUsdComplete: boolean;
  nativeCosts: { currency: Currency; amount: string; requestCount: number }[];
  unknownCostRequestCount: number;
  partialCostRequestCount: number;
  cacheHitRatio: number | null;
  byProvider: {
    provider: ProviderId;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: string;
    costUsdComplete: boolean;
  }[];
  byModel: {
    provider: ProviderId;
    model: string;
    requestCount: number;
    totalTokens: number;
    costUsd: string;
    costUsdComplete: boolean;
  }[];
  byConversation: {
    conversationId: string;
    title: string;
    requestCount: number;
    totalTokens: number;
    costUsd: string;
    costUsdComplete: boolean;
  }[];
  byDay: TimeBucket[];
  byCurrency: { currency: Currency; amount: string; requestCount: number }[];
  recentRequests: ApiRequestRow[];
  byPurpose: {
    purpose: RequestPurpose;
    requestCount: number;
    totalTokens: number;
    costUsd: string;
    costUsdComplete: boolean;
  }[];
}

export interface ApiRequestRow {
  id: string;
  provider: ProviderId;
  model: string;
  startedAt: string;
  status: RequestStatus;
  requestPurpose: RequestPurpose;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costAmount: string | null;
  costCurrency: Currency | null;
  costUsd: string | null;
  calculationStatus: CalculationStatus;
  errorDetails: string | null;
  pricingSnapshotId: string | null;
  pricingVersion: string | null;
  pricingBasis: string | null;
}

export interface TurnView {
  turn: StoredTurn;
  userMessage: StoredMessage | null;
  assistantMessages: StoredMessage[];
  requests: ApiRequestRow[];
  stats: {
    requestCount: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheWriteTokens: number;
    tokensUnknown: boolean;
    costUsd: string;
    nativeCosts: { currency: Currency; amount: string; requestCount: number }[];
    calculationStatus: CalculationStatus;
  };
}

export interface TitleGenerationResult {
  ok: boolean;
  conversationId: string;
  title?: string;
  requestId?: string;
  error?: string;
  mode: TitleMode;
}

export type TitleEvent =
  | {
      type: 'started';
      conversationId: string;
      requestId: string;
      mode: TitleMode;
    }
  | {
      type: 'completed';
      conversationId: string;
      requestId: string;
      mode: TitleMode;
      title: string;
      request: ApiRequestRow;
      conversationStats: ConversationStats;
      turnView: TurnView | null;
      applied: boolean;
    }
  | {
      type: 'failed';
      conversationId: string;
      requestId: string | null;
      mode: TitleMode;
      message: string;
      fallbackTitle?: string;
    }
  | {
      type: 'fallback';
      conversationId: string;
      title: string;
      reason: string;
    };

export interface ConversationDetail {
  conversation: Conversation;
  turns: TurnView[];
  stats: ConversationStats;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  defaultProvider: ProviderId;
  defaultModel: string;
  totalTokens: number;
  costUsd: string;
  requestCount: number;
  lastMessagePreview: string;
  tokensKnown: boolean;
  unknownCostRequestCount: number;
  costUsdComplete: boolean;
}

export interface ProviderKeyStatus {
  configured: boolean;
  updatedAt: string | null;
  storage: 'keychain' | 'session' | 'unavailable';
}

export interface KeyStatusResponse {
  secureStorageAvailable: boolean;
  storageBackend: string;
  openai: ProviderKeyStatus;
  deepseek: ProviderKeyStatus;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: ProviderId;
  hasPricing: boolean;
  reasoningEffort: boolean;
  thinkingToggle: boolean;
  source: 'builtin' | 'api' | 'manual';
}

export interface ModelListResult {
  models: ModelInfo[];
  source: 'api' | 'builtin';
  warning?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  httpStatus?: number;
}

export interface DeepSeekBalanceResult {
  ok: boolean;
  fetchedAt: string;
  isAvailable?: boolean;
  infos?: {
    currency: string;
    totalBalance: string;
    grantedBalance: string;
    toppedUpBalance: string;
  }[];
  error?: string;
}

export interface BudgetConfig {
  enabled: boolean;
  turnUsd: string | null;
  conversationUsd: string | null;
  dailyUsd: string | null;
  totalUsd: string | null;
}

export interface BudgetAlert {
  scope: 'turn' | 'conversation' | 'daily' | 'total';
  limitUsd: string;
  actualUsd: string;
  conversationId?: string;
  turnId?: string;
  note: string;
}

export type ChatStreamEvent =
  | { type: 'request_started'; requestId: string; conversationId: string; turnId: string; assistantMessageId: string; startedAt: string }
  | { type: 'text_delta'; requestId: string; delta: string }
  | { type: 'reasoning_delta'; requestId: string; delta: string }
  | { type: 'provider_meta'; requestId: string; providerRequestId: string | null }
  | { type: 'usage_received'; requestId: string; usage: NormalizedUsage; completeness: UsageCompleteness }
  | {
      type: 'completed';
      requestId: string;
      conversationId: string;
      turnId: string;
      assistantMessageId: string;
      message: StoredMessage;
      request: ApiRequestRow;
      turnView: TurnView;
      conversationStats: ConversationStats;
      budgetAlerts: BudgetAlert[];
    }
  | {
      type: 'failed';
      requestId: string;
      conversationId: string;
      turnId: string;
      assistantMessageId: string | null;
      code: string;
      message: string;
      detail?: string;
      partialUsage: NormalizedUsage | null;
      request: ApiRequestRow | null;
      turnView: TurnView | null;
      conversationStats: ConversationStats | null;
    }
  | { type: 'aborted'; requestId: string; conversationId: string; turnId: string; assistantMessageId: string | null; message: string; turnView: TurnView | null; conversationStats: ConversationStats | null };

export interface ChatSendResult {
  requestId: string;
  conversationId: string;
  turnId: string;
  assistantMessageId: string;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  conversation: Conversation;
}

export interface AppMeta {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  dataDir: string;
  secureStorageAvailable: boolean;
  storageBackend: string;
  schemaVersion: number;
  pricingVersions: { openai: string; deepseek: string; verifiedAt: string };
  testMode: boolean;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface BackupResult extends ExportResult {
  requestCount?: number;
  conversationCount?: number;
}

export interface RestoreResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  conversationCount?: number;
  requestCount?: number;
}

export interface RecalculateCostResult {
  totalCandidates: number;
  recalculated: number;
  skipped: number;
  unknownCostCount: number;
  note: string;
}

export interface ExchangeRateInfo {
  base: 'CNY';
  quote: 'USD';
  rate: string;
  source: string;
  sourceUrl: string;
  effectiveAt: string;
  fetchedAt: string;
  isUserConfigured: boolean;
  stale: boolean;
}

export interface HolidayRuleInfo {
  coverageStart: string;
  coverageEnd: string;
  holidays: { date: string; name: string }[];
  overrides: { date: string; name: string; action: 'add' | 'remove' }[];
  allowUncoveredEstimate: boolean;
  sourceUrl: string;
}
