import type { BudgetConfig, ProviderId } from './types';
import { HOLIDAY_COVERAGE_END } from './pricing/holidays';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max' | null;
export type ThinkingMode = 'default' | 'enabled' | 'disabled';

export interface ProviderModelDefaults {
  model: string;
  reasoningEffort: ReasoningEffort;
  thinking: ThinkingMode;
}

export interface FxSetting {
  rate: string;
  source: string;
  sourceUrl: string;
  effectiveAt: string;
}

export interface AutoTitleSettings {
  enabled: boolean;
  /** 为 true 时标题服务商跟随当前聊天服务商，模型为空则跟随聊天模型 */
  useCurrentChat: boolean;
  provider: ProviderId;
  /** 空字符串表示使用聊天模型（useCurrentChat=true）或该服务商默认模型 */
  model: string;
  /** 跨服务商标题生成必须显式同意 */
  allowCrossProvider: boolean;
}

export interface AppSettings {
  defaultProvider: ProviderId;
  models: Record<ProviderId, ProviderModelDefaults>;
  autoTitle: AutoTitleSettings;
  maxContextMessages: number;
  maxContextChars: number;
  fx: FxSetting;
  budget: BudgetConfig;
  holidayCoverageEnd: string;
  allowUncoveredHolidayEstimate: boolean;
  showReasoning: boolean;
  onboardingDismissed: boolean;
}

/** ECB 2026-10-30 参考汇率（EUR/CNY 7.4326, EUR/USD 1.1172）折算的 CNY→USD。 */
export const ECB_REFERENCE_RATE = '0.150309';
export const ECB_SOURCE_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: 'openai',
  models: {
    openai: { model: 'gpt-6.1-sol', reasoningEffort: null, thinking: 'default' },
    deepseek: { model: 'deepseek-flash', reasoningEffort: null, thinking: 'default' },
  },
  autoTitle: {
    enabled: true,
    useCurrentChat: true,
    provider: 'openai',
    model: '',
    allowCrossProvider: false,
  },
  maxContextMessages: 200,
  maxContextChars: 240_000,
  fx: {
    rate: ECB_REFERENCE_RATE,
    source: '欧洲中央银行（ECB）参考汇率折算（CNY→USD）',
    sourceUrl: ECB_SOURCE_URL,
    effectiveAt: '2026-10-30',
  },
  budget: {
    enabled: false,
    turnUsd: null,
    conversationUsd: null,
    dailyUsd: null,
    totalUsd: null,
  },
  holidayCoverageEnd: HOLIDAY_COVERAGE_END,
  allowUncoveredHolidayEstimate: false,
  showReasoning: true,
  onboardingDismissed: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeProviderDefaults(
  base: ProviderModelDefaults,
  value: unknown,
): ProviderModelDefaults {
  if (!isRecord(value)) return base;
  const reasoning = ['minimal', 'low', 'medium', 'high', 'max'].includes(
    String(value.reasoningEffort),
  )
    ? (value.reasoningEffort as ReasoningEffort)
    : null;
  const thinking = ['default', 'enabled', 'disabled'].includes(String(value.thinking))
    ? (value.thinking as ThinkingMode)
    : base.thinking;
  return {
    model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : base.model,
    reasoningEffort: value.reasoningEffort === null ? null : reasoning,
    thinking,
  };
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function optionalMoney(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,12})?$/.test(text)) return null;
  return text;
}

/** 将未知/部分设置与默认值合并，并校验数值边界。 */
export function mergeSettings(input: unknown): AppSettings {
  const raw = isRecord(input) ? input : {};
  const modelsRaw = isRecord(raw.models) ? raw.models : {};
  const fxRaw = isRecord(raw.fx) ? raw.fx : {};
  const budgetRaw = isRecord(raw.budget) ? raw.budget : {};
  const autoTitleRaw = isRecord(raw.autoTitle) ? raw.autoTitle : {};

  const defaultProvider: ProviderId =
    raw.defaultProvider === 'deepseek' ? 'deepseek' : 'openai';

  const fxRate =
    typeof fxRaw.rate === 'string' && /^\d+(\.\d{1,12})?$/.test(fxRaw.rate.trim())
      ? fxRaw.rate.trim()
      : DEFAULT_SETTINGS.fx.rate;

  return {
    defaultProvider,
    models: {
      openai: mergeProviderDefaults(DEFAULT_SETTINGS.models.openai, modelsRaw.openai),
      deepseek: mergeProviderDefaults(DEFAULT_SETTINGS.models.deepseek, modelsRaw.deepseek),
    },
    autoTitle: {
      enabled: autoTitleRaw.enabled !== false,
      useCurrentChat: autoTitleRaw.useCurrentChat !== false,
      provider:
        autoTitleRaw.provider === 'deepseek' ? 'deepseek' : DEFAULT_SETTINGS.autoTitle.provider,
      model:
        typeof autoTitleRaw.model === 'string'
          ? autoTitleRaw.model.trim().slice(0, 200)
          : DEFAULT_SETTINGS.autoTitle.model,
      allowCrossProvider: autoTitleRaw.allowCrossProvider === true,
    },
    maxContextMessages: positiveInt(raw.maxContextMessages, 200, 2, 1000),
    maxContextChars: positiveInt(raw.maxContextChars, 240_000, 4_000, 2_000_000),
    fx: {
      rate: fxRate,
      source:
        typeof fxRaw.source === 'string' && fxRaw.source.trim()
          ? fxRaw.source.trim().slice(0, 300)
          : DEFAULT_SETTINGS.fx.source,
      sourceUrl:
        typeof fxRaw.sourceUrl === 'string' && fxRaw.sourceUrl.trim()
          ? fxRaw.sourceUrl.trim().slice(0, 500)
          : DEFAULT_SETTINGS.fx.sourceUrl,
      effectiveAt:
        typeof fxRaw.effectiveAt === 'string' && fxRaw.effectiveAt.trim()
          ? fxRaw.effectiveAt.trim().slice(0, 40)
          : DEFAULT_SETTINGS.fx.effectiveAt,
    },
    budget: {
      enabled: budgetRaw.enabled === true,
      turnUsd: optionalMoney(budgetRaw.turnUsd),
      conversationUsd: optionalMoney(budgetRaw.conversationUsd),
      dailyUsd: optionalMoney(budgetRaw.dailyUsd),
      totalUsd: optionalMoney(budgetRaw.totalUsd),
    },
    holidayCoverageEnd:
      typeof raw.holidayCoverageEnd === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw.holidayCoverageEnd)
        ? raw.holidayCoverageEnd
        : DEFAULT_SETTINGS.holidayCoverageEnd,
    allowUncoveredHolidayEstimate: raw.allowUncoveredHolidayEstimate === true,
    showReasoning: raw.showReasoning !== false,
    onboardingDismissed: raw.onboardingDismissed === true,
  };
}
