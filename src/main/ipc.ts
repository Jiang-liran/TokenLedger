import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { mergeSettings } from '../shared/settings';
import { IPC, type PriceOverrideRow } from '../shared/ipc';
import type {
  AppMeta,
  ChatOptions,
  DeepSeekBalanceResult,
  ExchangeRateInfo,
  HolidayRuleInfo,
  KeyStatusResponse,
} from '../shared/types';
import type { Store } from './db/repositories';
import type { KeyStore } from './services/secrets';
import type { PricingService } from './services/pricing';
import type { ChatService } from './services/chat';
import type { TitleService } from './services/titles';
import type { ModelsService } from './services/models';
import type { BalanceService } from './services/balance';
import type { ExportService } from './services/export';
import type { BackupService } from './services/backup';
import type { Logger } from './services/logger';
import { fetchEcbCnyUsd } from './services/fx';
import { testProviderConnection } from './services/transport';
import { redact } from './services/logger';
import { APP_VERSION } from '../shared/version';

const providerSchema = z.enum(['openai', 'deepseek']);
const idSchema = z.string().trim().min(1).max(200);
const modelSchema = z.string().trim().min(1).max(200);
const nullableRange = z.object({
  from: z.string().min(1).max(60).nullable().optional(),
  to: z.string().min(1).max(60).nullable().optional(),
  provider: providerSchema.nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  purpose: z.enum(['chat', 'title_generation']).nullable().optional(),
});
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,12})?$/)
  .nullable();

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'platform.openai.com',
  'developers.openai.com',
  'openai.com',
  'help.openai.com',
  'platform.deepseek.com',
  'www.deepseek.com',
  'api-docs.deepseek.com',
  'www.ecb.europa.eu',
  'www.gov.cn',
]);

export interface IpcDeps {
  store: Store;
  secrets: KeyStore;
  pricing: PricingService;
  chat: ChatService;
  titles: TitleService;
  models: ModelsService;
  balance: BalanceService;
  exporter: ExportService;
  backup: BackupService;
  logger: Logger;
  isTestMode: boolean;
  dataDir: string;
  getWindow: () => Electron.BrowserWindow | null;
  devServerUrl: string | null;
}

function trustedSender(event: IpcMainInvokeEvent, deps: IpcDeps): void {
  const window = deps.getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('拒绝来自未知窗口的请求');
  }
  const url = event.senderFrame?.url ?? '';
  const isFile = url.startsWith('file://');
  const isDev = !!deps.devServerUrl && url.startsWith(deps.devServerUrl);
  if (!isFile && !isDev) throw new Error('拒绝来自不受信任页面的请求');
}

type Handler<T> = (payload: T) => unknown | Promise<unknown>;

export function registerIpc(deps: IpcDeps): void {
  const handle = <T>(channel: string, schema: z.ZodType<T>, handler: Handler<T>): void => {
    ipcMain.handle(channel, async (event, rawPayload: unknown) => {
      try {
        trustedSender(event, deps);
        const parsed = schema.safeParse(rawPayload);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(`请求参数无效：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
        }
        return await handler(parsed.data);
      } catch (error) {
        deps.logger.warn(`IPC ${channel} 失败`, redact(error));
        throw new Error(redact(error instanceof Error ? error.message : error));
      }
    });
  };

  const keyStatus = async (): Promise<KeyStatusResponse> => {
    const [available, openai, deepseek] = await Promise.all([
      deps.secrets.isAvailable(),
      deps.secrets.getStatus('openai'),
      deps.secrets.getStatus('deepseek'),
    ]);
    return {
      secureStorageAvailable: available,
      storageBackend: deps.secrets.storageBackend,
      openai,
      deepseek,
    };
  };

  const meta = async (): Promise<AppMeta> => ({
    version: APP_VERSION,
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataDir: deps.dataDir,
    secureStorageAvailable: await deps.secrets.isAvailable(),
    storageBackend: deps.secrets.storageBackend,
    schemaVersion: deps.store.schemaVersion,
    pricingVersions: deps.pricing.getVersions(),
    testMode: deps.isTestMode,
  });

  const pricingResponse = () => ({
    models: deps.pricing.getCatalog(),
    overrides: deps.store.listPriceOverrides(),
    versions: deps.pricing.getVersions(),
    fx: deps.pricing.getFxInfo(),
  });

  handle(IPC.meta, z.any().optional(), () => meta());

  handle(IPC.conversationsList, z.object({ includeArchived: z.boolean() }), ({ includeArchived }) =>
    deps.store.listConversations(includeArchived),
  );

  handle(
    IPC.conversationCreate,
    z.object({
      provider: providerSchema.optional(),
      model: modelSchema.optional(),
      title: z.string().max(200).optional(),
    }).optional(),
    (payload) => {
      const settings = deps.store.getSettings();
      const provider = payload?.provider ?? settings.defaultProvider;
      const model = payload?.model ?? settings.models[provider].model;
      const conversation = deps.store.createConversation({
        title: payload?.title ?? '新对话',
        provider,
        model,
      });
      return deps.store
        .listConversations(true)
        .find((summary) => summary.id === conversation.id);
    },
  );

  handle(
    IPC.conversationRename,
    z.object({ id: idSchema, title: z.string().trim().min(1).max(160) }),
    ({ id, title }) => {
      deps.store.renameConversation(id, title);
    },
  );

  handle(
    IPC.conversationArchive,
    z.object({ id: idSchema, archived: z.boolean() }),
    ({ id, archived }) => {
      deps.store.archiveConversation(id, archived);
    },
  );

  handle(IPC.conversationDelete, z.object({ id: idSchema }), ({ id }) => {
    deps.store.softDeleteConversation(id);
  });

  handle(IPC.conversationPurge, z.object({ id: idSchema }), ({ id }) => {
    deps.store.purgeConversation(id);
  });

  handle(IPC.conversationGet, z.object({ id: idSchema }), ({ id }) => deps.store.getConversationDetail(id));

  handle(
    IPC.chatSend,
    z.object({
      conversationId: z.string().min(1).max(200).nullable().optional(),
      provider: providerSchema,
      model: modelSchema,
      content: z.string().min(1).max(200_000),
      options: z
        .object({
          reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'max']).nullable().optional(),
          thinking: z.enum(['default', 'enabled', 'disabled']).optional(),
          maxOutputTokens: z.number().int().positive().max(384_000).nullable().optional(),
        })
        .optional(),
    }),
    (payload) =>
      deps.chat.send({
        conversationId: payload.conversationId ?? null,
        provider: payload.provider,
        model: payload.model,
        content: payload.content,
        options: payload.options as ChatOptions | undefined,
      }),
  );

  handle(
    IPC.chatRegenerate,
    z.object({
      turnId: idSchema,
      assistantMessageId: idSchema.nullable(),
      provider: providerSchema,
      model: modelSchema,
    }),
    ({ turnId, assistantMessageId, provider, model }) =>
      deps.chat.regenerate(turnId, assistantMessageId, provider, model),
  );

  handle(IPC.chatAbort, z.object({ requestId: idSchema }), ({ requestId }) => {
    deps.chat.abort(requestId);
  });

  handle(IPC.titleRegenerate, z.object({ conversationId: idSchema }), ({ conversationId }) =>
    deps.titles.regenerate(conversationId),
  );

  handle(
    IPC.modelsList,
    z.object({ provider: providerSchema, refresh: z.boolean().optional() }),
    ({ provider, refresh }) =>
      deps.isTestMode
        ? deps.models.builtinList(provider)
        : deps.models.list(provider, refresh ?? false),
  );

  handle(IPC.keysStatus, z.any().optional(), () => keyStatus());

  handle(
    IPC.keysSet,
    z.object({ provider: providerSchema, key: z.string().min(8).max(4096) }),
    async ({ provider, key }) => {
      await deps.secrets.setKey(provider, key);
      deps.models.refreshKnownModels();
      return keyStatus();
    },
  );

  handle(
    IPC.keysSetSession,
    z.object({ provider: providerSchema, key: z.string().min(8).max(4096) }),
    async ({ provider, key }) => {
      deps.secrets.setSessionKey(provider, key);
      deps.models.refreshKnownModels();
      return keyStatus();
    },
  );

  handle(IPC.keysDelete, z.object({ provider: providerSchema }), async ({ provider }) => {
    await deps.secrets.deleteKey(provider);
    deps.models.refreshKnownModels();
    return keyStatus();
  });

  handle(IPC.keysTest, z.object({ provider: providerSchema }), async ({ provider }) => {
    if (deps.isTestMode) {
      return { ok: true, message: '测试模式：已模拟连接成功（未访问官方 API）。', latencyMs: 1 };
    }
    const key = await deps.secrets.getKey(provider);
    if (!key) {
      return { ok: false, message: '尚未配置该服务商的 API Key。' };
    }
    return testProviderConnection(provider, key);
  });

  handle(IPC.balanceDeepseek, z.any().optional(), async (): Promise<DeepSeekBalanceResult> => {
    if (deps.isTestMode) {
      return {
        ok: true,
        fetchedAt: new Date().toISOString(),
        isAvailable: true,
        infos: [
          {
            currency: 'CNY',
            totalBalance: '110.00',
            grantedBalance: '10.00',
            toppedUpBalance: '100.00',
          },
        ],
      };
    }
    return deps.balance.getDeepSeekBalance();
  });

  handle(IPC.statsGlobal, nullableRange.optional(), (range) =>
    deps.store.getGlobalStats(
      range?.from ?? null,
      range?.to ?? null,
      range?.provider ?? null,
      range?.model ?? null,
      range?.purpose ?? null,
    ),
  );

  handle(IPC.settingsGet, z.any().optional(), () => deps.store.getSettings());

  handle(IPC.settingsSave, z.object({ settings: z.unknown() }), ({ settings }) => {
    const before = deps.store.getSettings();
    const merged = deps.store.saveSettings(mergeSettings(settings));
    if (
      before.fx.rate !== merged.fx.rate ||
      before.fx.effectiveAt !== merged.fx.effectiveAt ||
      before.fx.source !== merged.fx.source
    ) {
      deps.pricing.setFxRate(merged.fx.rate, merged.fx.source, merged.fx.effectiveAt);
    }
    return merged;
  });

  handle(IPC.pricingGet, z.any().optional(), () => pricingResponse());

  const overrideSchema = z.object({
    provider: providerSchema,
    model: modelSchema,
    inputPerM: moneySchema,
    cachedInputPerM: moneySchema,
    cacheWrite30mPerM: moneySchema,
    cacheWrite12hPerM: moneySchema,
    outputPerM: moneySchema,
    offPeakInputPerM: moneySchema,
    offPeakCachedInputPerM: moneySchema,
    offPeakOutputPerM: moneySchema,
    currency: z.enum(['USD', 'CNY']).nullable(),
    sourceUrl: z.string().trim().max(500).nullable(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().max(2000).nullable(),
    createdAt: z.string().optional(),
  });

  handle(IPC.pricingSetOverride, overrideSchema, (override) => {
    if (!override.inputPerM && !override.outputPerM) {
      throw new Error('至少需要填写输入与输出单价（每百万 Token）');
    }
    const row: PriceOverrideRow = {
      provider: override.provider,
      model: override.model,
      inputPerM: override.inputPerM,
      cachedInputPerM: override.cachedInputPerM,
      cacheWrite30mPerM: override.cacheWrite30mPerM,
      cacheWrite12hPerM: override.cacheWrite12hPerM,
      outputPerM: override.outputPerM,
      offPeakInputPerM: override.offPeakInputPerM,
      offPeakCachedInputPerM: override.offPeakCachedInputPerM,
      offPeakOutputPerM: override.offPeakOutputPerM,
      currency: override.currency,
      sourceUrl: override.sourceUrl,
      effectiveFrom: override.effectiveFrom,
      notes: override.notes,
      createdAt: new Date().toISOString(),
    };
    deps.store.upsertPriceOverride(row);
    return pricingResponse();
  });

  handle(
    IPC.pricingResetOverride,
    z.object({ provider: providerSchema, model: modelSchema }),
    ({ provider, model }) => {
      deps.store.deletePriceOverride(provider, model);
      return pricingResponse();
    },
  );

  handle(IPC.pricingRecalculate, z.any().optional(), () => deps.pricing.recalculateHistory());

  handle(IPC.fxRefresh, z.any().optional(), async (): Promise<ExchangeRateInfo> => {
    const result = await fetchEcbCnyUsd();
    return deps.pricing.setFxSnapshot(result);
  });

  handle(
    IPC.fxSet,
    z.object({ rate: z.string().regex(/^\d+(\.\d{1,12})?$/), source: z.string().max(300) }),
    ({ rate, source }) => deps.pricing.setFxRate(rate, source),
  );

  handle(IPC.holidaysGet, z.any().optional(), (): HolidayRuleInfo => deps.pricing.getHolidayInfo());

  handle(
    IPC.holidaysSave,
    z.object({
      coverageEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      overrides: z.array(
        z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          name: z.string().max(60),
          action: z.enum(['add', 'remove']),
        }),
      ),
    }),
    ({ coverageEnd, overrides }): HolidayRuleInfo => {
      const settings = deps.store.getSettings();
      deps.store.saveSettings({ ...settings, holidayCoverageEnd: coverageEnd });
      deps.store.replaceHolidayOverrides(overrides);
      return deps.pricing.getHolidayInfo();
    },
  );

  handle(IPC.exportConversationMarkdown, z.object({ id: idSchema }), ({ id }) =>
    deps.exporter.exportConversationMarkdown(id),
  );

  handle(IPC.exportConversationJson, z.object({ id: idSchema }), ({ id }) =>
    deps.exporter.exportConversationJson(id),
  );

  handle(IPC.exportStatsCsv, nullableRange.optional(), (range) =>
    deps.exporter.exportStatsCsv(range?.from ?? null, range?.to ?? null),
  );

  handle(IPC.backupCreate, z.any().optional(), () => deps.backup.create());

  handle(IPC.backupRestore, z.any().optional(), () => deps.backup.restore());

  handle(
    IPC.dataDeleteAll,
    z.object({ confirmText: z.string().max(200) }),
    ({ confirmText }) => {
      if (confirmText !== '删除全部数据') {
        throw new Error('确认文本不匹配，已取消删除');
      }
      deps.store.deleteAllData();
      return { ok: true };
    },
  );

  handle(IPC.externalOpen, z.object({ url: z.string().url().max(2000) }), async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('仅允许打开 HTTPS 链接');
    if (!ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
      throw new Error(`不允许打开该域名的链接：${parsed.hostname}`);
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });

  handle(
    IPC.requestsRecent,
    z.object({ limit: z.number().int().min(1).max(500).optional() }),
    ({ limit }) => deps.store.getRecentRequests(limit ?? 50),
  );
}
