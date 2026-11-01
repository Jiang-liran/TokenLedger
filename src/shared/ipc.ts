import type {
  ApiRequestRow,
  AppMeta,
  BackupResult,
  BudgetAlert,
  ChatSendResult,
  ChatStreamEvent,
  ConnectionTestResult,
  ConversationDetail,
  ConversationSummary,
  DeepSeekBalanceResult,
  ExchangeRateInfo,
  ExportResult,
  GlobalStats,
  HolidayRuleInfo,
  KeyStatusResponse,
  ModelListResult,
  ModelPricing,
  ProviderId,
  RestoreResult,
  RecalculateCostResult,
  TitleEvent,
  TitleGenerationResult,
  ChatOptions,
} from './types';
import type { AppSettings } from './settings';

export interface PriceOverrideRow {
  provider: ProviderId;
  model: string;
  inputPerM: string | null;
  cachedInputPerM: string | null;
  cacheWrite30mPerM: string | null;
  cacheWrite12hPerM: string | null;
  outputPerM: string | null;
  offPeakInputPerM: string | null;
  offPeakCachedInputPerM: string | null;
  offPeakOutputPerM: string | null;
  currency: 'USD' | 'CNY' | null;
  sourceUrl: string | null;
  effectiveFrom: string;
  notes: string | null;
  createdAt: string;
}

export interface PricingCatalogResponse {
  models: ModelPricing[];
  overrides: PriceOverrideRow[];
  versions: { openai: string; deepseek: string; verifiedAt: string };
  fx: ExchangeRateInfo;
}

export interface CreateConversationPayload {
  provider?: ProviderId;
  model?: string;
  title?: string;
}

export interface SendMessagePayload {
  conversationId?: string | null;
  provider: ProviderId;
  model: string;
  content: string;
  options?: ChatOptions;
}

export interface StatsRangePayload {
  from?: string | null;
  to?: string | null;
  provider?: ProviderId | null;
  model?: string | null;
  purpose?: 'chat' | 'title_generation' | null;
}

export interface TokenLedgerApi {
  getMeta(): Promise<AppMeta>;
  listConversations(includeArchived: boolean): Promise<ConversationSummary[]>;
  createConversation(payload: CreateConversationPayload): Promise<ConversationSummary>;
  renameConversation(id: string, title: string): Promise<void>;
  archiveConversation(id: string, archived: boolean): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  purgeConversation(id: string): Promise<void>;
  getConversation(id: string): Promise<ConversationDetail>;
  sendMessage(payload: SendMessagePayload): Promise<ChatSendResult>;
  regenerate(
    turnId: string,
    assistantMessageId: string | null,
    provider: ProviderId,
    model: string,
  ): Promise<ChatSendResult>;
  abort(requestId: string): Promise<void>;
  listModels(provider: ProviderId, refresh?: boolean): Promise<ModelListResult>;
  getKeyStatus(): Promise<KeyStatusResponse>;
  setKey(provider: ProviderId, key: string): Promise<KeyStatusResponse>;
  setSessionKey(provider: ProviderId, key: string): Promise<KeyStatusResponse>;
  deleteKey(provider: ProviderId): Promise<KeyStatusResponse>;
  testKey(provider: ProviderId): Promise<ConnectionTestResult>;
  getDeepSeekBalance(): Promise<DeepSeekBalanceResult>;
  getGlobalStats(range: StatsRangePayload): Promise<GlobalStats>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  getPricing(): Promise<PricingCatalogResponse>;
  setPriceOverride(override: PriceOverrideRow): Promise<PricingCatalogResponse>;
  resetPriceOverride(provider: ProviderId, model: string): Promise<PricingCatalogResponse>;
  recalculateCosts(): Promise<RecalculateCostResult>;
  refreshFxRate(): Promise<ExchangeRateInfo>;
  setFxRate(rate: string, source: string): Promise<ExchangeRateInfo>;
  getHolidayInfo(): Promise<HolidayRuleInfo>;
  saveHolidaySettings(
    coverageEnd: string,
    overrides: { date: string; name: string; action: 'add' | 'remove' }[],
  ): Promise<HolidayRuleInfo>;
  exportConversationMarkdown(id: string): Promise<ExportResult>;
  exportConversationJson(id: string): Promise<ExportResult>;
  exportStatsCsv(range: StatsRangePayload): Promise<ExportResult>;
  createBackup(): Promise<BackupResult>;
  restoreBackup(): Promise<RestoreResult>;
  deleteAllData(confirmText: string): Promise<{ ok: boolean }>;
  openExternal(url: string): Promise<{ ok: boolean }>;
  getRecentRequests(limit: number): Promise<ApiRequestRow[]>;
  regenerateTitle(conversationId: string): Promise<TitleGenerationResult>;
  onChatEvent(listener: (event: ChatStreamEvent) => void): () => void;
  onBudgetAlert(listener: (alert: BudgetAlert) => void): () => void;
  onTitleEvent(listener: (event: TitleEvent) => void): () => void;
}

export const IPC = {
  meta: 'app:meta',
  conversationsList: 'conversations:list',
  conversationCreate: 'conversations:create',
  conversationRename: 'conversations:rename',
  conversationArchive: 'conversations:archive',
  conversationDelete: 'conversations:delete',
  conversationPurge: 'conversations:purge',
  conversationGet: 'conversations:get',
  chatSend: 'chat:send',
  chatRegenerate: 'chat:regenerate',
  chatAbort: 'chat:abort',
  chatEvent: 'chat:event',
  titleEvent: 'title:event',
  titleRegenerate: 'title:regenerate',
  budgetAlert: 'budget:alert',
  modelsList: 'models:list',
  keysStatus: 'keys:status',
  keysSet: 'keys:set',
  keysSetSession: 'keys:set-session',
  keysDelete: 'keys:delete',
  keysTest: 'keys:test',
  balanceDeepseek: 'balance:deepseek',
  statsGlobal: 'stats:global',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  pricingGet: 'pricing:get',
  pricingSetOverride: 'pricing:set-override',
  pricingResetOverride: 'pricing:reset-override',
  pricingRecalculate: 'pricing:recalculate',
  fxRefresh: 'fx:refresh',
  fxSet: 'fx:set',
  holidaysGet: 'holidays:get',
  holidaysSave: 'holidays:save',
  exportConversationMarkdown: 'export:conversation-markdown',
  exportConversationJson: 'export:conversation-json',
  exportStatsCsv: 'export:stats-csv',
  backupCreate: 'backup:create',
  backupRestore: 'backup:restore',
  dataDeleteAll: 'data:delete-all',
  externalOpen: 'external:open',
  requestsRecent: 'requests:recent',
} as const;
