import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type TokenLedgerApi } from '../shared/ipc';
import type { BudgetAlert, ChatStreamEvent } from '../shared/types';

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

const api: TokenLedgerApi = {
  getMeta: () => invoke(IPC.meta),
  listConversations: (includeArchived) =>
    invoke(IPC.conversationsList, { includeArchived }),
  createConversation: (payload) => invoke(IPC.conversationCreate, payload ?? {}),
  renameConversation: (id, title) => invoke(IPC.conversationRename, { id, title }),
  archiveConversation: (id, archived) => invoke(IPC.conversationArchive, { id, archived }),
  deleteConversation: (id) => invoke(IPC.conversationDelete, { id }),
  purgeConversation: (id) => invoke(IPC.conversationPurge, { id }),
  getConversation: (id) => invoke(IPC.conversationGet, { id }),
  sendMessage: (payload) => invoke(IPC.chatSend, payload),
  regenerate: (turnId, assistantMessageId, provider, model) =>
    invoke(IPC.chatRegenerate, { turnId, assistantMessageId, provider, model }),
  abort: (requestId) => invoke(IPC.chatAbort, { requestId }),
  listModels: (provider, refresh) => invoke(IPC.modelsList, { provider, refresh }),
  getKeyStatus: () => invoke(IPC.keysStatus),
  setKey: (provider, key) => invoke(IPC.keysSet, { provider, key }),
  setSessionKey: (provider, key) => invoke(IPC.keysSetSession, { provider, key }),
  deleteKey: (provider) => invoke(IPC.keysDelete, { provider }),
  testKey: (provider) => invoke(IPC.keysTest, { provider }),
  getDeepSeekBalance: () => invoke(IPC.balanceDeepseek),
  getGlobalStats: (range) => invoke(IPC.statsGlobal, range),
  getSettings: () => invoke(IPC.settingsGet),
  saveSettings: (settings) => invoke(IPC.settingsSave, { settings }),
  getPricing: () => invoke(IPC.pricingGet),
  setPriceOverride: (override) => invoke(IPC.pricingSetOverride, override),
  resetPriceOverride: (provider, model) => invoke(IPC.pricingResetOverride, { provider, model }),
  recalculateCosts: () => invoke(IPC.pricingRecalculate),
  refreshFxRate: () => invoke(IPC.fxRefresh),
  setFxRate: (rate, source) => invoke(IPC.fxSet, { rate, source }),
  getHolidayInfo: () => invoke(IPC.holidaysGet),
  saveHolidaySettings: (coverageEnd, overrides) =>
    invoke(IPC.holidaysSave, { coverageEnd, overrides }),
  exportConversationMarkdown: (id) => invoke(IPC.exportConversationMarkdown, { id }),
  exportConversationJson: (id) => invoke(IPC.exportConversationJson, { id }),
  exportStatsCsv: (range) => invoke(IPC.exportStatsCsv, range),
  createBackup: () => invoke(IPC.backupCreate),
  restoreBackup: () => invoke(IPC.backupRestore),
  deleteAllData: (confirmText) => invoke(IPC.dataDeleteAll, { confirmText }),
  openExternal: (url) => invoke(IPC.externalOpen, { url }),
  getRecentRequests: (limit) => invoke(IPC.requestsRecent, { limit }),
  onChatEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent) => listener(payload);
    ipcRenderer.on(IPC.chatEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, wrapped);
    };
  },
  onBudgetAlert: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: BudgetAlert) => listener(payload);
    ipcRenderer.on(IPC.budgetAlert, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC.budgetAlert, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('tokenledger', api);
