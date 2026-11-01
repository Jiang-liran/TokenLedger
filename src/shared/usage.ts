import type { NormalizedUsage, UsageCompleteness, UsageNormalization } from './types';

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite30mTokens: null,
    cacheWrite12hTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  };
}

export function usageHasAnyValue(usage: NormalizedUsage | null | undefined): boolean {
  if (!usage) return false;
  return Object.values(usage).some((v) => v !== null && v !== undefined);
}

/**
 * 解析 OpenAI Responses API 的 usage。
 *
 * 官方结构（见 https://developers.openai.com/api/docs/guides/prompt-caching）：
 * usage.input_tokens
 * usage.input_tokens_details.cached_tokens
 * usage.input_tokens_details.cache_write_tokens
 * usage.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens / ttl_12h_tokens
 * usage.output_tokens
 * usage.output_tokens_details.reasoning_tokens
 *
 * 关键规则：
 * - cached_tokens 与 cache_write_tokens 都包含在 input_tokens 内，不重复相加。
 * - 两类 cache write 互不重叠，且之和等于 cache_write_tokens。
 * - reasoning_tokens 已包含在 output_tokens 内。
 * - 缺失字段标记为 null（未知），不填零。
 */
export function normalizeOpenAIUsage(
  raw: unknown,
  options: { supportsCacheWrite: boolean } = { supportsCacheWrite: false },
): UsageNormalization {
  const issues: string[] = [];
  const root = asRecord(raw);
  if (!root) {
    return {
      usage: emptyUsage(),
      completeness: 'missing',
      issues: ['服务商未返回 usage 字段'],
      rawUsage: raw ?? null,
    };
  }

  const details = asRecord(root.input_tokens_details) ?? asRecord(root.prompt_tokens_details) ?? {};
  const outputDetails =
    asRecord(root.output_tokens_details) ?? asRecord(root.completion_tokens_details) ?? {};

  const inputTokens = num(root.input_tokens) ?? num(root.prompt_tokens);
  const cachedRaw = num(details.cached_tokens);
  const writeRaw = num(details.cache_write_tokens);
  const writeDetails = asRecord(details.cache_write_tokens_details);
  const ttl30Raw = writeDetails ? num(writeDetails.ttl_30m_tokens) : null;
  const ttl12Raw = writeDetails ? num(writeDetails.ttl_12h_tokens) : null;
  const outputTokens = num(root.output_tokens) ?? num(root.completion_tokens);
  const reasoningTokens =
    num(outputDetails.reasoning_tokens) ?? num(root.reasoning_tokens);
  const totalTokens = num(root.total_tokens);

  if (inputTokens === null) issues.push('缺少 input_tokens');
  if (outputTokens === null) issues.push('缺少 output_tokens');
  if (cachedRaw === null) issues.push('缺少 input_tokens_details.cached_tokens');

  let cacheWriteTokens: number | null = writeRaw;
  let ttl30: number | null = ttl30Raw;
  let ttl12: number | null = ttl12Raw;

  if (!options.supportsCacheWrite) {
    // 该模型不支持缓存写入计费，OpenAI 也不会返回写入字段；此处 0 是“不适用”，而非猜测。
    cacheWriteTokens = 0;
    ttl30 = 0;
    ttl12 = 0;
    if (writeRaw !== null && writeRaw > 0) {
      issues.push('模型价格未配置缓存写入，但服务商返回了缓存写入 Token');
    }
  } else if (cacheWriteTokens === null) {
    if (ttl30Raw !== null && ttl12Raw !== null) {
      cacheWriteTokens = ttl30Raw + ttl12Raw;
      issues.push('cache_write_tokens 缺失，按 TTL 明细求和');
    } else {
      issues.push('缺少 input_tokens_details.cache_write_tokens');
    }
  } else if (ttl30Raw !== null && ttl12Raw !== null) {
    const sum = ttl30Raw + ttl12Raw;
    if (sum !== cacheWriteTokens) {
      issues.push(
        `缓存写入明细之和 ${sum} 与 cache_write_tokens ${cacheWriteTokens} 不一致`,
      );
    }
  } else if (cacheWriteTokens > 0) {
    issues.push('缺少缓存写入 TTL 明细（ttl_30m_tokens / ttl_12h_tokens）');
  }

  let uncachedInputTokens: number | null = null;
  if (inputTokens !== null && cachedRaw !== null && cacheWriteTokens !== null) {
    const ordinary = inputTokens - cachedRaw - cacheWriteTokens;
    if (ordinary < 0) {
      issues.push('input_tokens 小于缓存读取与写入之和，usage 不一致');
    } else {
      uncachedInputTokens = ordinary;
    }
  }

  const completeness: UsageCompleteness =
    inputTokens === null || outputTokens === null
      ? 'missing'
      : issues.length > 0
        ? 'partial'
        : 'complete';

  return {
    usage: {
      inputTokens,
      uncachedInputTokens,
      cacheReadTokens: cachedRaw,
      cacheWriteTokens,
      cacheWrite30mTokens: ttl30,
      cacheWrite12hTokens: ttl12,
      outputTokens,
      reasoningTokens,
      totalTokens,
    },
    completeness,
    issues,
    rawUsage: raw,
  };
}

/**
 * 解析 DeepSeek Chat Completions 的 usage。
 *
 * 官方字段：
 * prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
 * completion_tokens
 * total_tokens
 * completion_tokens_details.reasoning_tokens（如提供）
 *
 * reasoning_tokens 已包含于 completion_tokens，不重复计费。
 * DeepSeek 不单独收取缓存写入费用，因此缓存写入记为 0（不适用）。
 */
export function normalizeDeepSeekUsage(raw: unknown): UsageNormalization {
  const issues: string[] = [];
  const root = asRecord(raw);
  if (!root) {
    return {
      usage: emptyUsage(),
      completeness: 'missing',
      issues: ['服务商未返回 usage 字段'],
      rawUsage: raw ?? null,
    };
  }

  const details =
    asRecord(root.completion_tokens_details) ?? asRecord(root.output_tokens_details) ?? {};

  const inputTokens = num(root.prompt_tokens) ?? num(root.input_tokens);
  const cacheRead = num(root.prompt_cache_hit_tokens);
  const cacheMiss = num(root.prompt_cache_miss_tokens);
  const outputTokens = num(root.completion_tokens) ?? num(root.output_tokens);
  const reasoningTokens = num(details.reasoning_tokens) ?? num(root.reasoning_tokens);
  const totalTokens = num(root.total_tokens);

  if (inputTokens === null) issues.push('缺少 prompt_tokens');
  if (outputTokens === null) issues.push('缺少 completion_tokens');
  if (cacheRead === null) issues.push('缺少 prompt_cache_hit_tokens');
  if (cacheMiss === null) issues.push('缺少 prompt_cache_miss_tokens');

  if (inputTokens !== null && cacheRead !== null && cacheMiss !== null) {
    if (cacheRead + cacheMiss !== inputTokens) {
      issues.push(
        `缓存命中 ${cacheRead} + 未命中 ${cacheMiss} 与 prompt_tokens ${inputTokens} 不一致`,
      );
    }
  }

  const completeness: UsageCompleteness =
    inputTokens === null || outputTokens === null
      ? 'missing'
      : issues.length > 0
        ? 'partial'
        : 'complete';

  return {
    usage: {
      inputTokens,
      uncachedInputTokens: cacheMiss,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      cacheWrite30mTokens: 0,
      cacheWrite12hTokens: 0,
      outputTokens,
      reasoningTokens,
      totalTokens,
    },
    completeness,
    issues,
    rawUsage: raw,
  };
}

/** 汇总多份 usage（同一 Turn 的多次请求）。null 视为未知，不参与求和。 */
export function sumUsage(list: (NormalizedUsage | null | undefined)[]): {
  usage: NormalizedUsage;
  unknownRequestCount: number;
} {
  const acc = emptyUsage();
  let unknownRequestCount = 0;
  for (const item of list) {
    if (!item || item.inputTokens === null || item.outputTokens === null) {
      unknownRequestCount += 1;
      continue;
    }
    for (const key of Object.keys(acc) as (keyof NormalizedUsage)[]) {
      const value = item[key];
      if (value === null) {
        acc[key] = null;
        continue;
      }
      acc[key] = (acc[key] ?? 0) + value;
    }
  }
  return { usage: acc, unknownRequestCount };
}

export function parseStoredUsage(json: string | null): NormalizedUsage | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<NormalizedUsage>;
    const base = emptyUsage();
    for (const key of Object.keys(base) as (keyof NormalizedUsage)[]) {
      const value = parsed[key];
      base[key] = typeof value === 'number' ? value : null;
    }
    return base;
  } catch {
    return null;
  }
}
