import type {
  Currency,
  ModelCapabilities,
  ModelPricing,
  PriceTable,
  ProviderId,
} from '../types';

export const PRICING_VERIFIED_AT = '2026-11-01';
export const OPENAI_PRICING_VERSION = 'openai-2026.11.01';
export const DEEPSEEK_PRICING_VERSION = 'deepseek-2026.11.01';
export const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';
export const OPENAI_CACHING_SOURCE = 'https://developers.openai.com/api/docs/guides/prompt-caching';
export const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const DEEPSEEK_CACHE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/guides/kv_cache/';
export const DEEPSEEK_THINKING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/';

/** 长上下文价格档位阈值：≤272K 输入使用标准价，>272K 使用长上下文价。 */
export const LONG_CONTEXT_THRESHOLD = 272_000;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function table(
  currency: Currency,
  input: string,
  output: string,
  cached: string | null,
  write30m: string | null = null,
  write12h: string | null = null,
): PriceTable {
  return {
    currency,
    inputPerM: input,
    outputPerM: output,
    cachedInputPerM: cached,
    cacheWrite30mPerM: write30m,
    cacheWrite12hPerM: write12h,
  };
}

const OPENAI_CAPS: ModelCapabilities = {
  reasoningEffort: true,
  thinkingToggle: false,
  cacheWrite: false,
  temperature: false,
  responsesApi: true,
  textChat: true,
};

const OPENAI_CLASSIC_CAPS: ModelCapabilities = {
  reasoningEffort: false,
  thinkingToggle: false,
  cacheWrite: false,
  temperature: true,
  responsesApi: true,
  textChat: true,
};

const OPENAI_CACHE_WRITE_CAPS: ModelCapabilities = {
  ...OPENAI_CAPS,
  cacheWrite: true,
};

const DEEPSEEK_CAPS: ModelCapabilities = {
  reasoningEffort: true,
  thinkingToggle: true,
  cacheWrite: false,
  temperature: true,
  responsesApi: false,
  textChat: true,
};

function openai(
  model: string,
  displayName: string,
  input: string,
  output: string,
  cached: string | null,
  options: {
    write30m?: string | null;
    write12h?: string | null;
    long?: PriceTable & { thresholdTokens: number };
    caps?: ModelCapabilities;
    notes?: string[];
    aliases?: string[];
  } = {},
): ModelPricing {
  const caps = options.caps ?? (options.write30m ? OPENAI_CACHE_WRITE_CAPS : OPENAI_CAPS);
  return {
    provider: 'openai',
    model,
    displayName,
    currency: 'USD',
    pricingVersion: OPENAI_PRICING_VERSION,
    priceSource: OPENAI_PRICING_SOURCE,
    lastVerifiedAt: PRICING_VERIFIED_AT,
    effectiveFrom: '2026-01-01',
    tariff: null,
    standard: table('USD', input, output, cached, options.write30m ?? null, options.write12h ?? null),
    offPeak: null,
    longContext: options.long ?? null,
    capabilities: caps,
    status: 'verified',
    notes: options.notes ?? [],
    aliases: options.aliases ?? [],
  };
}

function openaiLong(
  input: string,
  output: string,
  cached: string | null,
  write30m: string | null = null,
  write12h: string | null = null,
): PriceTable & { thresholdTokens: number } {
  return { ...table('USD', input, output, cached, write30m, write12h), thresholdTokens: LONG_CONTEXT_THRESHOLD };
}

function deepseek(
  model: string,
  displayName: string,
  peak: { input: string; cached: string; output: string },
  offPeak: { input: string; cached: string; output: string },
  aliases: string[] = [],
): ModelPricing {
  return {
    provider: 'deepseek',
    model,
    displayName,
    currency: 'CNY',
    pricingVersion: DEEPSEEK_PRICING_VERSION,
    priceSource: DEEPSEEK_PRICING_SOURCE,
    lastVerifiedAt: PRICING_VERIFIED_AT,
    effectiveFrom: '2026-01-01',
    tariff: 'deepseek-peak-offpeak',
    standard: table('CNY', peak.input, peak.output, peak.cached),
    offPeak: table('CNY', offPeak.input, offPeak.output, offPeak.cached),
    longContext: null,
    capabilities: DEEPSEEK_CAPS,
    status: 'verified',
    notes: [
      '高峰时段（北京时间工作日 09:00–12:00、14:00–18:00，不含法定节假日）按标准价；其余时段为低谷价（5 折）。',
      'DeepSeek 不单独收取缓存写入费用。',
    ],
    aliases,
  };
}

/**
 * 内置价格表。所有价格均于 2026-11-01 从官方价格页核对。
 * 价格是数据而非业务逻辑，可在设置中按模型覆盖；每次请求会写入不可变快照。
 */
export const OPENAI_PRICING: ModelPricing[] = [
  openai('gpt-6-astra', 'GPT-6 Astra', '10.00', '50.00', '1.00', {
    write30m: '12.50',
    write12h: '25.00',
    long: openaiLong('20.00', '75.00', '2.00', '25.00', '50.00'),
  }),
  openai('gpt-6.1-sol', 'GPT-6.1 Sol', '2.00', '10.00', '0.10', {
    write30m: '2.50',
    write12h: '5.00',
    long: openaiLong('4.00', '15.00', '0.20', '5.00', '10.00'),
  }),
  openai('gpt-6.1-terra', 'GPT-6.1 Terra', '1.00', '5.00', '0.05', {
    write30m: '1.25',
    write12h: '2.50',
    long: openaiLong('2.00', '7.50', '0.10', '2.50', '5.00'),
  }),
  openai('gpt-6-luna', 'GPT-6 Luna', '0.10', '0.50', '0.01', {
    write30m: '0.125',
    write12h: '0.25',
    long: openaiLong('0.20', '0.75', '0.02', '0.25', '0.50'),
  }),
  openai('gpt-6-sol', 'GPT-6 Sol', '2.00', '10.00', '0.20', {
    write30m: '2.50',
    write12h: '5.00',
    long: openaiLong('4.00', '15.00', '0.40', '5.00', '10.00'),
  }),
  openai('gpt-5.6-sol', 'GPT-5.6 Sol', '4.00', '20.00', '0.40', {
    write30m: '5.00',
    write12h: '10.00',
    long: openaiLong('8.00', '30.00', '0.80', '10.00', '20.00'),
  }),
  openai('gpt-5.6-terra', 'GPT-5.6 Terra', '2.00', '12.00', '0.20', {
    write30m: '2.50',
    write12h: '5.00',
    long: openaiLong('4.00', '18.00', '0.40', '5.00', '10.00'),
  }),
  openai('gpt-5.6-luna', 'GPT-5.6 Luna', '0.20', '1.20', '0.02', {
    write30m: '0.25',
    write12h: '0.50',
    long: openaiLong('0.40', '1.80', '0.04', '0.50', '1.00'),
  }),
  openai('gpt-5.5', 'GPT-5.5', '5.00', '30.00', '0.50', {
    long: openaiLong('10.00', '45.00', '1.00'),
  }),
  openai('gpt-5.5-pro', 'GPT-5.5 Pro', '30.00', '180.00', null, {
    long: openaiLong('60.00', '270.00', null),
  }),
  openai('gpt-5.4', 'GPT-5.4', '2.50', '15.00', '0.25', {
    long: openaiLong('5.00', '22.50', '0.50'),
  }),
  openai('gpt-5.4-pro', 'GPT-5.4 Pro', '30.00', '180.00', null, {
    long: openaiLong('60.00', '270.00', null),
  }),
  openai('gpt-5.4-mini', 'GPT-5.4 mini', '0.75', '4.50', '0.075'),
  openai('gpt-5.4-nano', 'GPT-5.4 nano', '0.20', '1.25', '0.02'),
  openai('gpt-5.2', 'GPT-5.2', '1.75', '14.00', '0.175'),
  openai('gpt-5.2-pro', 'GPT-5.2 Pro', '21.00', '168.00', null),
  openai('gpt-5.1', 'GPT-5.1', '1.25', '10.00', '0.125'),
  openai('gpt-5', 'GPT-5', '1.25', '10.00', '0.125'),
  openai('gpt-5-mini', 'GPT-5 mini', '0.25', '2.00', '0.025'),
  openai('gpt-5-nano', 'GPT-5 nano', '0.05', '0.40', '0.005'),
  openai('gpt-5-pro', 'GPT-5 Pro', '15.00', '120.00', null),
  openai('gpt-4.1', 'GPT-4.1', '2.00', '8.00', '0.50', { caps: OPENAI_CLASSIC_CAPS }),
  openai('gpt-4.1-mini', 'GPT-4.1 mini', '0.40', '1.60', '0.10', { caps: OPENAI_CLASSIC_CAPS }),
  openai('gpt-4.1-nano', 'GPT-4.1 nano', '0.10', '0.40', '0.025', { caps: OPENAI_CLASSIC_CAPS }),
  openai('gpt-4o', 'GPT-4o', '2.50', '10.00', '1.25', { caps: OPENAI_CLASSIC_CAPS }),
  openai('gpt-4o-2024-05-13', 'GPT-4o (2024-05-13)', '5.00', '15.00', null, {
    caps: OPENAI_CLASSIC_CAPS,
  }),
  openai('gpt-4o-mini', 'GPT-4o mini', '0.15', '0.60', '0.075', { caps: OPENAI_CLASSIC_CAPS }),
  openai('o1', 'o1', '15.00', '60.00', '7.50'),
  openai('o1-pro', 'o1 Pro', '150.00', '600.00', null),
  openai('o3', 'o3', '2.00', '8.00', '0.50'),
  openai('o3-pro', 'o3 Pro', '20.00', '80.00', null),
  openai('o3-mini', 'o3-mini', '1.10', '4.40', '0.55'),
  openai('o4-mini', 'o4-mini', '1.10', '4.40', '0.275'),
  openai('gpt-4-turbo-2024-04-09', 'GPT-4 Turbo (2024-04-09)', '10.00', '30.00', null, {
    caps: OPENAI_CLASSIC_CAPS,
  }),
  openai('gpt-4-0613', 'GPT-4 (0613)', '30.00', '60.00', null, { caps: OPENAI_CLASSIC_CAPS }),
  openai('gpt-3.5-turbo', 'GPT-3.5 Turbo', '0.50', '1.50', null, {
    caps: OPENAI_CLASSIC_CAPS,
  }),
  openai('gpt-3.5-turbo-0125', 'GPT-3.5 Turbo (0125)', '0.50', '1.50', null, {
    caps: OPENAI_CLASSIC_CAPS,
  }),
];

export const DEEPSEEK_PRICING: ModelPricing[] = [
  deepseek(
    'deepseek-flash',
    'DeepSeek Flash',
    { input: '2.00', cached: '0.04', output: '8.00' },
    { input: '1.00', cached: '0.02', output: '4.00' },
    ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
  ),
  deepseek(
    'deepseek-v4-pro',
    'DeepSeek V4 Pro',
    { input: '9.00', cached: '0.30', output: '27.00' },
    { input: '4.50', cached: '0.15', output: '13.50' },
  ),
];

export const ALL_PRICING: ModelPricing[] = [...OPENAI_PRICING, ...DEEPSEEK_PRICING];

export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, '')
    .replace(/^deepseek\//, '');
}

export function inferCapabilities(provider: ProviderId, model: string): ModelCapabilities {
  const id = normalizeModelId(model);
  if (provider === 'deepseek') return { ...DEEPSEEK_CAPS };
  if (/^(gpt-6|gpt-5|o[134])/.test(id)) return { ...OPENAI_CAPS };
  return { ...OPENAI_CLASSIC_CAPS };
}

/** 在 OpenAI /v1/models 列表中过滤出可能支持文本聊天的模型。 */
export function isLikelyTextChatModel(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  const deny = [
    'embedding',
    'whisper',
    'tts',
    'dall-e',
    'gpt-image',
    'image',
    'moderation',
    'babbage',
    'davinci',
    'realtime',
    'transcribe',
    'audio',
    'sora',
    'video',
    'omni-moderation',
    'text-embedding',
    'computer-use-preview-2025',
  ];
  if (deny.some((token) => id.includes(token))) return false;
  return true;
}

export interface PricingLookup {
  pricing: ModelPricing;
  matchedBy: 'exact' | 'alias' | 'prefix';
  requestedModel: string;
}

export function findModelPricing(
  provider: ProviderId,
  model: string,
  catalog: ModelPricing[] = ALL_PRICING,
): PricingLookup | null {
  const id = normalizeModelId(model);
  if (!id) return null;
  const candidates = catalog.filter((entry) => entry.provider === provider);

  const exact = candidates.find((entry) => entry.model === id);
  if (exact) return { pricing: exact, matchedBy: 'exact', requestedModel: model };

  const alias = candidates.find((entry) => entry.aliases.includes(id));
  if (alias) return { pricing: alias, matchedBy: 'alias', requestedModel: model };

  // 兼容带日期后缀或版本后缀的模型 ID，例如 gpt-6.1-sol-2026-05-01。
  const prefixMatches = candidates
    .filter((entry) => id.startsWith(`${entry.model}-`) || id.startsWith(`${entry.model}:`))
    .sort((a, b) => b.model.length - a.model.length);
  if (prefixMatches[0]) {
    return { pricing: prefixMatches[0], matchedBy: 'prefix', requestedModel: model };
  }
  return null;
}

export function getBuiltinModels(provider: ProviderId): ModelPricing[] {
  return provider === 'openai' ? OPENAI_PRICING : DEEPSEEK_PRICING;
}

export function suggestedModels(provider: ProviderId): string[] {
  if (provider === 'deepseek') return ['deepseek-flash', 'deepseek-v4-pro'];
  return ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-4o-mini'];
}

export function priceTableKey(provider: ProviderId): Currency {
  return provider === 'openai' ? 'USD' : 'CNY';
}
