import { create } from 'zustand';
import type {
  AppMeta,
  ChatOptions,
  ChatStreamEvent,
  ConversationDetail,
  ConversationStats,
  ConversationSummary,
  DeepSeekBalanceResult,
  GlobalStats,
  HolidayRuleInfo,
  KeyStatusResponse,
  ModelListResult,
  ProviderId,
  TitleEvent,
} from '../shared/types';
import type { PriceOverrideRow, PricingCatalogResponse } from '../shared/ipc';
import type { AppSettings } from '../shared/settings';
import { computeCustomRange, computePresetRange, type RangePreset, type TimeRange } from '../shared/time';

export type Page = 'chat' | 'usage' | 'settings';

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'error';
  message: string;
}

export interface ConfirmState {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (value: boolean) => void;
}

interface AppState {
  ready: boolean;
  bootError: string | null;
  page: Page;
  meta: AppMeta | null;
  settings: AppSettings | null;
  conversations: ConversationSummary[];
  includeArchived: boolean;
  activeId: string | null;
  detail: ConversationDetail | null;
  loadingConversation: boolean;
  provider: ProviderId;
  model: string;
  options: ChatOptions;
  modelsByProvider: Partial<Record<ProviderId, ModelListResult>>;
  modelsLoading: boolean;
  keyStatus: KeyStatusResponse | null;
  pricing: PricingCatalogResponse | null;
  holidays: HolidayRuleInfo | null;
  generating: { requestId: string; conversationId: string; turnId: string; assistantMessageId: string } | null;
  titleJobs: Record<string, boolean>;
  activeRequests: Record<string, { conversationId: string; turnId: string; assistantMessageId: string }>;
  streamText: Record<string, { text: string; reasoning: string }>;
  pendingByRequest: Record<string, { text: string; reasoning: string }>;
  usage: GlobalStats | null;
  usageRange: TimeRange;
  usageFilter: { provider: ProviderId | null; model: string | null; purpose: 'chat' | 'title_generation' | null };
  usageLoading: boolean;
  search: string;
  error: string | null;
  toasts: Toast[];
  confirm: ConfirmState | null;
  balanceOpen: boolean;
  balance: DeepSeekBalanceResult | null;
  balanceLoading: boolean;
  keyTestResult: Record<ProviderId, { ok: boolean; message: string; at: string } | null>;

  bootstrap: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  selectPage: (page: Page) => void;
  selectConversation: (id: string) => Promise<void>;
  loadDetail: (conversationId: string) => Promise<void>;
  newConversation: () => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  archiveConversation: (id: string, archived: boolean) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  purgeConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<boolean>;
  regenerate: (turnId: string, assistantMessageId: string | null) => Promise<void>;
  stopGeneration: () => Promise<void>;
  setProvider: (provider: ProviderId) => Promise<void>;
  setModel: (model: string) => void;
  setOptions: (options: Partial<ChatOptions>) => void;
  loadModels: (provider: ProviderId, refresh?: boolean) => Promise<void>;
  refreshKeyStatus: () => Promise<void>;
  saveKey: (provider: ProviderId, key: string) => Promise<boolean>;
  saveSessionKey: (provider: ProviderId, key: string) => Promise<boolean>;
  deleteKeyAction: (provider: ProviderId) => Promise<void>;
  testKeyAction: (provider: ProviderId) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  loadPricing: () => Promise<void>;
  setPriceOverride: (override: PriceOverrideRow) => Promise<void>;
  resetPriceOverride: (provider: ProviderId, model: string) => Promise<void>;
  recalculateCosts: () => Promise<void>;
  refreshFx: () => Promise<void>;
  saveFx: (rate: string, source: string) => Promise<void>;
  loadHolidays: () => Promise<void>;
  saveHolidays: (
    coverageEnd: string,
    overrides: { date: string; name: string; action: 'add' | 'remove' }[],
  ) => Promise<void>;
  loadUsage: (preset: RangePreset, fromDate?: string, toDate?: string) => Promise<void>;
  refreshUsage: () => Promise<void>;
  setUsageFilter: (filter: Partial<{ provider: ProviderId | null; model: string | null; purpose: 'chat' | 'title_generation' | null }>) => void;
  exportConversationMarkdown: () => Promise<void>;
  exportConversationJson: () => Promise<void>;
  exportStatsCsv: () => Promise<void>;
  createBackup: () => Promise<void>;
  restoreBackup: () => Promise<void>;
  deleteAllData: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  pushToast: (tone: Toast['tone'], message: string) => void;
  dismissToast: (id: string) => void;
  askConfirm: (options: Omit<ConfirmState, 'resolve'>) => Promise<boolean>;
  resolveConfirm: (value: boolean) => void;
  openBalance: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  closeBalance: () => void;
  handleChatEvent: (event: ChatStreamEvent) => void;
  handleTitleEvent: (event: TitleEvent) => void;
  regenerateTitle: (conversationId?: string) => Promise<void>;
  flushDeltas: () => void;
  setSearch: (search: string) => void;
  setIncludeArchived: (include: boolean) => void;
  clearError: () => void;
  reloadAfterRestore: () => Promise<void>;
}

const api = () => window.tokenledger;

function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
  return message || '操作失败，请重试。';
}

function optionsFor(settings: AppSettings, provider: ProviderId): ChatOptions {
  return {
    reasoningEffort: settings.models[provider].reasoningEffort,
    thinking: settings.models[provider].thinking,
    maxOutputTokens: null,
  };
}

function emptyStats(conversationId: string): ConversationStats {
  return {
    conversationId,
    requestCount: 0,
    turnCount: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    tokensUnknownRequestCount: 0,
    costUsd: '0',
    costUsdComplete: true,
    nativeCosts: [],
    unknownCostRequestCount: 0,
    partialCostRequestCount: 0,
    cacheHitRatio: null,
    byModel: [],
    byProvider: [],
  };
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(run: () => void): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    run();
  }, 45);
}

function applyTurnView(
  detail: ConversationDetail | null,
  conversationId: string,
  turnView: ConversationDetail['turns'][number] | null,
  stats: ConversationStats | null,
): ConversationDetail | null {
  if (!detail || detail.conversation.id !== conversationId || !turnView) return detail;
  const turns = [...detail.turns];
  const index = turns.findIndex((turn) => turn.turn.id === turnView.turn.id);
  if (index >= 0) turns[index] = turnView;
  else turns.push(turnView);
  return { ...detail, turns, stats: stats ?? detail.stats };
}

export const useAppStore = create<AppState>()((set, get) => ({
  ready: false,
  bootError: null,
  page: 'chat',
  meta: null,
  settings: null,
  conversations: [],
  includeArchived: false,
  activeId: null,
  detail: null,
  loadingConversation: false,
  provider: 'openai',
  model: 'gpt-6.1-sol',
  options: { reasoningEffort: null, thinking: 'default', maxOutputTokens: null },
  modelsByProvider: {},
  modelsLoading: false,
  keyStatus: null,
  pricing: null,
  holidays: null,
  generating: null,
  titleJobs: {},
  activeRequests: {},
  streamText: {},
  pendingByRequest: {},
  usage: null,
  usageRange: computePresetRange('today'),
  usageFilter: { provider: null, model: null, purpose: null },
  usageLoading: false,
  search: '',
  error: null,
  toasts: [],
  confirm: null,
  balanceOpen: false,
  balance: null,
  balanceLoading: false,
  keyTestResult: { openai: null, deepseek: null },

  bootstrap: async () => {
    try {
      const [meta, settings, keyStatus, pricing] = await Promise.all([
        api().getMeta(),
        api().getSettings(),
        api().getKeyStatus(),
        api().getPricing(),
      ]);
      const provider = settings.defaultProvider;
      const model = settings.models[provider].model;
      set({
        meta,
        settings,
        keyStatus,
        pricing,
        provider,
        model,
        options: optionsFor(settings, provider),
      });
      const [conversations, models] = await Promise.all([
        api().listConversations(false),
        api().listModels(provider),
      ]);
      set({ conversations, modelsByProvider: { [provider]: models } });
      if (conversations.length > 0) {
        await get().selectConversation(conversations[0].id);
      }
      set({ ready: true });
    } catch (error) {
      set({ bootError: errorMessage(error), ready: true });
    }
  },

  refreshConversations: async () => {
    const conversations = await api().listConversations(get().includeArchived);
    set({ conversations });
  },

  selectPage: (page) => {
    set({ page });
    if (page === 'usage') void get().refreshUsage();
    if (page === 'settings') {
      void get().loadPricing();
      void get().loadHolidays();
      void get().refreshKeyStatus();
    }
  },

  selectConversation: async (id) => {
    set({ activeId: id, loadingConversation: true, error: null, page: 'chat' });
    try {
      const detail = await api().getConversation(id);
      if (get().activeId !== id) return;
      set({
        detail,
        loadingConversation: false,
        provider: detail.conversation.defaultProvider,
        model: detail.conversation.defaultModel,
      });
      const settings = get().settings;
      if (settings) set({ options: optionsFor(settings, detail.conversation.defaultProvider) });
      if (!get().modelsByProvider[detail.conversation.defaultProvider]) {
        void get().loadModels(detail.conversation.defaultProvider);
      }
    } catch (error) {
      set({ loadingConversation: false, error: errorMessage(error) });
      get().pushToast('error', errorMessage(error));
    }
  },

  loadDetail: async (conversationId) => {
    try {
      const detail = await api().getConversation(conversationId);
      if (get().activeId !== conversationId) return;
      set({
        detail,
        loadingConversation: false,
        provider: detail.conversation.defaultProvider,
        model: detail.conversation.defaultModel,
      });
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  newConversation: async () => {
    const { activeId, detail, provider, model } = get();
    if (activeId && detail && detail.conversation.id === activeId && detail.turns.length === 0) {
      set({ page: 'chat' });
      return;
    }
    try {
      const summary = await api().createConversation({ provider, model });
      if (!summary) throw new Error('创建会话失败');
      await get().refreshConversations();
      set({ activeId: summary.id, page: 'chat' });
      await get().selectConversation(summary.id);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  renameConversation: async (id, title) => {
    try {
      await api().renameConversation(id, title);
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === id ? { ...conversation, title } : conversation,
        ),
        detail:
          state.detail && state.detail.conversation.id === id
            ? { ...state.detail, conversation: { ...state.detail.conversation, title } }
            : state.detail,
      }));
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  archiveConversation: async (id, archived) => {
    try {
      await api().archiveConversation(id, archived);
      await get().refreshConversations();
      if (archived && get().activeId === id && !get().includeArchived) {
        set({ activeId: null, detail: null, page: 'chat' });
      }
      get().pushToast('success', archived ? '会话已归档' : '会话已取消归档');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  deleteConversation: async (id) => {
    try {
      await api().deleteConversation(id);
      if (get().activeId === id) set({ activeId: null, detail: null, page: 'chat' });
      await get().refreshConversations();
      get().pushToast('success', '会话已从列表移除，历史费用统计仍保留');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  purgeConversation: async (id) => {
    try {
      await api().purgeConversation(id);
      if (get().activeId === id) set({ activeId: null, detail: null, page: 'chat' });
      await get().refreshConversations();
      set({ usage: null });
      get().pushToast('success', '会话及其用量记录已彻底删除');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const { activeId, provider, model, options } = get();
    set({ error: null });
    try {
      const result = await api().sendMessage({
        conversationId: activeId,
        provider,
        model,
        content: trimmed,
        options,
      });
      const mapping = {
        conversationId: result.conversationId,
        turnId: result.turnId,
        assistantMessageId: result.assistantMessageId,
      };
      set((state) => ({
        activeId: result.conversationId,
        page: 'chat',
        generating: { requestId: result.requestId, ...mapping },
        activeRequests: { ...state.activeRequests, [result.requestId]: mapping },
        streamText: { ...state.streamText, [result.assistantMessageId]: { text: '', reasoning: '' } },
      }));
      await get().loadDetail(result.conversationId);
      await get().refreshConversations();
      return true;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message });
      get().pushToast('error', message);
      return false;
    }
  },

  regenerate: async (turnId, assistantMessageId) => {
    const { provider, model } = get();
    try {
      const result = await api().regenerate(turnId, assistantMessageId, provider, model);
      const mapping = {
        conversationId: result.conversationId,
        turnId: result.turnId,
        assistantMessageId: result.assistantMessageId,
      };
      set((state) => ({
        generating: { requestId: result.requestId, ...mapping },
        activeRequests: { ...state.activeRequests, [result.requestId]: mapping },
        streamText: { ...state.streamText, [result.assistantMessageId]: { text: '', reasoning: '' } },
      }));
      await get().loadDetail(result.conversationId);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  regenerateTitle: async (conversationId) => {
    const id = conversationId ?? get().activeId;
    if (!id) {
      get().pushToast('error', '请先选择一个会话。');
      return;
    }
    if (get().titleJobs[id]) {
      get().pushToast('info', '标题正在生成中，请稍后再试。');
      return;
    }
    set((state) => ({ titleJobs: { ...state.titleJobs, [id]: true } }));
    try {
      // 成功/失败反馈由 title:event 统一处理，避免手动操作出现重复提示。
      await api().regenerateTitle(id);
    } catch (error) {
      set((state) => ({ titleJobs: { ...state.titleJobs, [id]: false } }));
      get().pushToast('error', errorMessage(error));
    }
  },

  handleTitleEvent: (event) => {
    const current = get();
    if (event.type === 'started') {
      set((state) => ({ titleJobs: { ...state.titleJobs, [event.conversationId]: true } }));
      return;
    }
    if (event.type === 'completed') {
      set((state) => ({
        titleJobs: { ...state.titleJobs, [event.conversationId]: false },
        conversations: state.conversations.map((conversation) =>
          conversation.id === event.conversationId && event.applied
            ? { ...conversation, title: event.title }
            : conversation,
        ),
        detail:
          state.detail &&
          state.detail.conversation.id === event.conversationId &&
          event.applied
            ? {
                ...state.detail,
                conversation: { ...state.detail.conversation, title: event.title },
                stats: event.conversationStats,
              }
            : state.detail,
      }));
      void get().refreshConversations();
      if (current.activeId === event.conversationId) {
        void get().loadDetail(event.conversationId);
      }
      if (event.mode === 'manual') {
        get().pushToast(
          'success',
          event.applied
            ? `标题已更新为「${event.title}」，本次标题请求费用已记录`
            : '标题已生成但未覆盖手动标题，请求费用已记录',
        );
      }
      return;
    }
    if (event.type === 'fallback') {
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === event.conversationId
            ? { ...conversation, title: event.title }
            : conversation,
        ),
        detail:
          state.detail && state.detail.conversation.id === event.conversationId
            ? {
                ...state.detail,
                conversation: { ...state.detail.conversation, title: event.title },
              }
            : state.detail,
      }));
      void get().refreshConversations();
      return;
    }
    if (event.type === 'failed') {
      set((state) => ({
        titleJobs: { ...state.titleJobs, [event.conversationId]: false },
      }));
      if (event.mode === 'manual') get().pushToast('error', event.message);
      void get().refreshConversations();
      if (current.activeId === event.conversationId) void get().loadDetail(event.conversationId);
    }
  },

  stopGeneration: async () => {
    const generating = get().generating;
    if (!generating) return;
    try {
      await api().abort(generating.requestId);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  setProvider: async (provider) => {
    const settings = get().settings;
    const model =
      settings?.models[provider].model ?? (provider === 'openai' ? 'gpt-6.1-sol' : 'deepseek-flash');
    set({ provider, model, options: settings ? optionsFor(settings, provider) : get().options });
    if (!get().modelsByProvider[provider]) await get().loadModels(provider);
  },

  setModel: (model) => set({ model }),

  setOptions: (options) => set((state) => ({ options: { ...state.options, ...options } })),

  loadModels: async (provider, refresh = false) => {
    set({ modelsLoading: true });
    try {
      const result = await api().listModels(provider, refresh);
      set((state) => ({ modelsByProvider: { ...state.modelsByProvider, [provider]: result } }));
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    } finally {
      set({ modelsLoading: false });
    }
  },

  refreshKeyStatus: async () => {
    try {
      set({ keyStatus: await api().getKeyStatus() });
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  saveKey: async (provider, key) => {
    try {
      const status = await api().setKey(provider, key);
      set((state) => ({
        keyStatus: status,
        keyTestResult: { ...state.keyTestResult, [provider]: null },
      }));
      get().pushToast('success', 'API Key 已安全保存');
      return true;
    } catch (error) {
      get().pushToast('error', errorMessage(error));
      return false;
    }
  },

  saveSessionKey: async (provider, key) => {
    try {
      const status = await api().setSessionKey(provider, key);
      set((state) => ({
        keyStatus: status,
        keyTestResult: { ...state.keyTestResult, [provider]: null },
      }));
      get().pushToast('info', '会话密钥已保存在内存中，退出应用后失效，不会写入磁盘');
      return true;
    } catch (error) {
      get().pushToast('error', errorMessage(error));
      return false;
    }
  },

  deleteKeyAction: async (provider) => {
    try {
      const status = await api().deleteKey(provider);
      set({ keyStatus: status });
      get().pushToast('success', 'API Key 已删除');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  testKeyAction: async (provider) => {
    try {
      const result = await api().testKey(provider);
      set((state) => ({
        keyTestResult: {
          ...state.keyTestResult,
          [provider]: { ...result, at: new Date().toISOString() },
        },
      }));
      get().pushToast(result.ok ? 'success' : 'error', result.message);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  loadSettings: async () => {
    try {
      set({ settings: await api().getSettings() });
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  saveSettings: async (settings) => {
    try {
      const saved = await api().saveSettings(settings);
      set({ settings: saved });
      get().pushToast('success', '设置已保存');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  loadPricing: async () => {
    try {
      set({ pricing: await api().getPricing() });
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  setPriceOverride: async (override) => {
    try {
      const pricing = await api().setPriceOverride(override);
      set({ pricing });
      get().pushToast('success', '价格覆盖已保存，将用于之后的新请求');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  resetPriceOverride: async (provider, model) => {
    try {
      const pricing = await api().resetPriceOverride(provider, model);
      set({ pricing });
      get().pushToast('success', '已恢复内置价格');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  recalculateCosts: async () => {
    try {
      const result = await api().recalculateCosts();
      const activeId = get().activeId;
      if (activeId) await get().loadDetail(activeId);
      await get().refreshConversations();
      set({ usage: null });
      get().pushToast(
        result.skipped > 0 ? 'info' : 'success',
        `已重算 ${result.recalculated} 次请求（共 ${result.totalCandidates} 次，跳过 ${result.skipped} 次）。${result.note}`,
      );
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  refreshFx: async () => {
    try {
      const fx = await api().refreshFxRate();
      set((state) => ({ pricing: state.pricing ? { ...state.pricing, fx } : state.pricing }));
      await get().loadSettings();
      get().pushToast('success', `已更新 ECB 参考汇率：1 CNY ≈ ${fx.rate} USD`);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  saveFx: async (rate, source) => {
    try {
      const fx = await api().setFxRate(rate, source);
      set((state) => ({ pricing: state.pricing ? { ...state.pricing, fx } : state.pricing }));
      await get().loadSettings();
      get().pushToast('success', '汇率已保存，将用于之后的 DeepSeek 美元折算');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  loadHolidays: async () => {
    try {
      set({ holidays: await api().getHolidayInfo() });
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  saveHolidays: async (coverageEnd, overrides) => {
    try {
      const holidays = await api().saveHolidaySettings(coverageEnd, overrides);
      set({ holidays });
      await get().loadSettings();
      get().pushToast('success', '节假日规则已保存');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  loadUsage: async (preset, fromDate, toDate) => {
    const range =
      preset === 'custom' && fromDate && toDate
        ? computeCustomRange(fromDate, toDate)
        : computePresetRange(preset);
    set({ usageRange: range, usageLoading: true });
    try {
      const filter = get().usageFilter;
      const usage = await api().getGlobalStats({
        from: range.from,
        to: range.to,
        provider: filter.provider,
        model: filter.model,
        purpose: filter.purpose,
      });
      set({ usage, usageLoading: false });
    } catch (error) {
      set({ usageLoading: false });
      get().pushToast('error', errorMessage(error));
    }
  },

  refreshUsage: async () => {
    const range = get().usageRange;
    set({ usageLoading: true });
    try {
      const filter = get().usageFilter;
      const usage = await api().getGlobalStats({
        from: range.from,
        to: range.to,
        provider: filter.provider,
        model: filter.model,
        purpose: filter.purpose,
      });
      set({ usage, usageLoading: false });
    } catch (error) {
      set({ usageLoading: false });
      get().pushToast('error', errorMessage(error));
    }
  },

  setUsageFilter: (filter) => {
    const current = get().usageFilter;
    const next = { ...current, ...filter };
    if (filter.provider !== undefined && filter.provider !== current.provider) next.model = null;
    set({ usageFilter: next });
    void get().refreshUsage();
  },

  exportConversationMarkdown: async () => {
    const activeId = get().activeId;
    if (!activeId) return;
    try {
      const result = await api().exportConversationMarkdown(activeId);
      if (result.ok) get().pushToast('success', `已导出：${result.path}`);
      else if (result.error) get().pushToast('error', result.error);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  exportConversationJson: async () => {
    const activeId = get().activeId;
    if (!activeId) return;
    try {
      const result = await api().exportConversationJson(activeId);
      if (result.ok) get().pushToast('success', `已导出：${result.path}`);
      else if (result.error) get().pushToast('error', result.error);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  exportStatsCsv: async () => {
    const { usageRange } = get();
    try {
      const result = await api().exportStatsCsv({ from: usageRange.from, to: usageRange.to });
      if (result.ok) get().pushToast('success', `已导出：${result.path}`);
      else if (result.error) get().pushToast('error', result.error);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  createBackup: async () => {
    try {
      const result = await api().createBackup();
      if (result.ok) {
        get().pushToast(
          'success',
          `备份已创建：${result.path}（${result.conversationCount ?? 0} 个会话，${result.requestCount ?? 0} 次请求）`,
        );
      } else if (result.error) get().pushToast('error', result.error);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  restoreBackup: async () => {
    try {
      const result = await api().restoreBackup();
      if (result.ok) {
        await get().reloadAfterRestore();
        get().pushToast(
          'success',
          `恢复完成：${result.conversationCount ?? 0} 个会话，${result.requestCount ?? 0} 次请求`,
        );
      } else if (result.error) get().pushToast('error', result.error);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  deleteAllData: async () => {
    try {
      await api().deleteAllData('删除全部数据');
      set({
        conversations: [],
        activeId: null,
        detail: null,
        usage: null,
        page: 'chat',
        streamText: {},
        activeRequests: {},
        generating: null,
      });
      get().pushToast('success', '全部聊天与费用记录已删除，API Key 仍保留在安全存储中');
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  openExternal: async (url) => {
    try {
      await api().openExternal(url);
    } catch (error) {
      get().pushToast('error', errorMessage(error));
    }
  },

  pushToast: (tone, message) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ toasts: [...state.toasts, { id, tone, message }] }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4200);
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  askConfirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({ confirm: { ...options, resolve } });
    }),

  resolveConfirm: (value) => {
    const confirm = get().confirm;
    if (confirm) {
      confirm.resolve(value);
      set({ confirm: null });
    }
  },

  openBalance: async () => {
    set({ balanceOpen: true });
    await get().refreshBalance();
  },

  refreshBalance: async () => {
    set({ balanceLoading: true });
    try {
      const balance = await api().getDeepSeekBalance();
      set({ balance, balanceLoading: false });
    } catch (error) {
      set({
        balanceLoading: false,
        balance: { ok: false, fetchedAt: new Date().toISOString(), error: errorMessage(error) },
      });
    }
  },

  closeBalance: () => set({ balanceOpen: false }),

  handleChatEvent: (event) => {
    const state = get();
    if (event.type === 'request_started') {
      const mapping = {
        conversationId: event.conversationId,
        turnId: event.turnId,
        assistantMessageId: event.assistantMessageId,
      };
      set((current) => ({
        activeRequests: { ...current.activeRequests, [event.requestId]: mapping },
        generating: current.generating ?? { requestId: event.requestId, ...mapping },
        streamText: current.streamText[event.assistantMessageId]
          ? current.streamText
          : { ...current.streamText, [event.assistantMessageId]: { text: '', reasoning: '' } },
      }));
      return;
    }

    if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
      if (!state.activeRequests[event.requestId]) return;
      set((current) => {
        const pending = current.pendingByRequest[event.requestId] ?? { text: '', reasoning: '' };
        return {
          pendingByRequest: {
            ...current.pendingByRequest,
            [event.requestId]: {
              text: event.type === 'text_delta' ? pending.text + event.delta : pending.text,
              reasoning:
                event.type === 'reasoning_delta' ? pending.reasoning + event.delta : pending.reasoning,
            },
          },
        };
      });
      scheduleFlush(() => get().flushDeltas());
      return;
    }

    if (event.type === 'usage_received' || event.type === 'provider_meta') return;

    if (event.type === 'completed') {
      get().flushDeltas();
      set((current) => {
        const nextRequests = { ...current.activeRequests };
        delete nextRequests[event.requestId];
        const nextPending = { ...current.pendingByRequest };
        delete nextPending[event.requestId];
        const nextStream = { ...current.streamText };
        delete nextStream[event.assistantMessageId];
        const generating = current.generating?.requestId === event.requestId ? null : current.generating;
        const detail = applyTurnView(
          current.detail,
          event.conversationId,
          event.turnView,
          event.conversationStats,
        );
        return {
          detail,
          activeRequests: nextRequests,
          pendingByRequest: nextPending,
          streamText: nextStream,
          generating,
          conversations: current.conversations.map((conversation) =>
            conversation.id === event.conversationId
              ? {
                  ...conversation,
                  totalTokens: event.conversationStats.totalTokens,
                  costUsd: event.conversationStats.costUsd,
                  requestCount: event.conversationStats.requestCount,
                }
              : conversation,
          ),
        };
      });
      if (get().activeId === event.conversationId && !get().detail) {
        void get().loadDetail(event.conversationId);
      }
      for (const alert of event.budgetAlerts) {
        get().pushToast(
          'error',
          `预算提醒（${alert.scope === 'turn' ? '单轮' : alert.scope === 'conversation' ? '单会话' : alert.scope === 'daily' ? '今日' : '总计'}）：本地估算 $${alert.actualUsd} 已达上限 $${alert.limitUsd}。${alert.note}`,
        );
      }
      void get().refreshConversations();
      return;
    }

    if (event.type === 'failed') {
      get().flushDeltas();
      const mapping = state.activeRequests[event.requestId];
      set((current) => {
        const nextRequests = { ...current.activeRequests };
        delete nextRequests[event.requestId];
        const nextPending = { ...current.pendingByRequest };
        delete nextPending[event.requestId];
        const nextStream = { ...current.streamText };
        if (mapping) delete nextStream[mapping.assistantMessageId];
        const generating = current.generating?.requestId === event.requestId ? null : current.generating;
        const detail = applyTurnView(
          current.detail,
          event.conversationId,
          event.turnView,
          event.conversationStats,
        );
        return {
          detail,
          activeRequests: nextRequests,
          pendingByRequest: nextPending,
          streamText: nextStream,
          generating,
          error: current.activeId === event.conversationId ? event.message : current.error,
        };
      });
      if (get().activeId === event.conversationId && !event.turnView) {
        void get().loadDetail(event.conversationId);
      }
      get().pushToast('error', event.message);
      void get().refreshConversations();
      return;
    }

    if (event.type === 'aborted') {
      get().flushDeltas();
      const mapping = state.activeRequests[event.requestId];
      set((current) => {
        const nextRequests = { ...current.activeRequests };
        delete nextRequests[event.requestId];
        const nextPending = { ...current.pendingByRequest };
        delete nextPending[event.requestId];
        const nextStream = { ...current.streamText };
        if (mapping) delete nextStream[mapping.assistantMessageId];
        const generating = current.generating?.requestId === event.requestId ? null : current.generating;
        const detail = applyTurnView(
          current.detail,
          event.conversationId,
          event.turnView,
          event.conversationStats,
        );
        return {
          detail,
          activeRequests: nextRequests,
          pendingByRequest: nextPending,
          streamText: nextStream,
          generating,
        };
      });
      if (get().activeId === event.conversationId && !event.turnView) {
        void get().loadDetail(event.conversationId);
      }
      get().pushToast('info', event.message);
      void get().refreshConversations();
    }
  },

  flushDeltas: () => {
    const { pendingByRequest, activeRequests, streamText } = get();
    const entries = Object.entries(pendingByRequest);
    if (entries.length === 0) return;
    const nextStream = { ...streamText };
    for (const [requestId, pending] of entries) {
      const mapping = activeRequests[requestId];
      if (!mapping) continue;
      const current = nextStream[mapping.assistantMessageId] ?? { text: '', reasoning: '' };
      nextStream[mapping.assistantMessageId] = {
        text: current.text + pending.text,
        reasoning: current.reasoning + pending.reasoning,
      };
    }
    set({ streamText: nextStream, pendingByRequest: {} });
  },

  setSearch: (search) => set({ search }),

  setIncludeArchived: (includeArchived) => {
    set({ includeArchived });
    void get().refreshConversations();
  },

  clearError: () => set({ error: null }),

  reloadAfterRestore: async () => {
    const [conversations, settings, keyStatus, pricing] = await Promise.all([
      api().listConversations(false),
      api().getSettings(),
      api().getKeyStatus(),
      api().getPricing(),
    ]);
    set({
      conversations,
      settings,
      keyStatus,
      pricing,
      activeId: null,
      detail: null,
      usage: null,
      generating: null,
      activeRequests: {},
      streamText: {},
      pendingByRequest: {},
      provider: settings.defaultProvider,
      model: settings.models[settings.defaultProvider].model,
    });
    if (conversations.length > 0) await get().selectConversation(conversations[0].id);
  },
}));

// 便于测试与复用：计算空会话统计。
export const emptyConversationStats = emptyStats;
