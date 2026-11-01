import { describe, expect, it } from 'vitest';
import { normalizeDeepSeekUsage, normalizeOpenAIUsage, sumUsage } from '../src/shared/usage';

describe('OpenAI usage 规范化', () => {
  it('正确解析缓存读取、30 分钟与 12 小时缓存写入，并且不重复相加', () => {
    const result = normalizeOpenAIUsage(
      {
        input_tokens: 12000,
        input_tokens_details: {
          cached_tokens: 4000,
          cache_write_tokens: 7000,
          cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
        },
        output_tokens: 1000,
        output_tokens_details: { reasoning_tokens: 300 },
        total_tokens: 13000,
      },
      { supportsCacheWrite: true },
    );

    expect(result.completeness).toBe('complete');
    expect(result.usage.inputTokens).toBe(12000);
    expect(result.usage.cacheReadTokens).toBe(4000);
    expect(result.usage.cacheWriteTokens).toBe(7000);
    expect(result.usage.cacheWrite30mTokens).toBe(3000);
    expect(result.usage.cacheWrite12hTokens).toBe(4000);
    expect(result.usage.uncachedInputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(1000);
    expect(result.usage.reasoningTokens).toBe(300);
  });

  it('不支持缓存写入的旧模型将写入字段视为“不适用”而非未知', () => {
    const result = normalizeOpenAIUsage(
      {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens: 100,
      },
      { supportsCacheWrite: false },
    );
    expect(result.completeness).toBe('complete');
    expect(result.usage.cacheWriteTokens).toBe(0);
    expect(result.usage.uncachedInputTokens).toBe(800);
  });

  it('支持缓存写入但缺失字段时标记为部分未知，不填零', () => {
    const result = normalizeOpenAIUsage(
      {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens: 100,
      },
      { supportsCacheWrite: true },
    );
    expect(result.usage.cacheWriteTokens).toBeNull();
    expect(result.usage.uncachedInputTokens).toBeNull();
    expect(result.completeness).toBe('partial');
    expect(result.issues.join(' ')).toContain('cache_write_tokens');
  });

  it('缺失 cached_tokens 时输入与未缓存输入均为未知', () => {
    const result = normalizeOpenAIUsage(
      {
        input_tokens: 1000,
        output_tokens: 100,
      },
      { supportsCacheWrite: false },
    );
    expect(result.usage.cacheReadTokens).toBeNull();
    expect(result.usage.uncachedInputTokens).toBeNull();
    expect(result.completeness).toBe('partial');
  });

  it('缓存写入明细与总量不一致时报告问题', () => {
    const result = normalizeOpenAIUsage(
      {
        input_tokens: 10000,
        input_tokens_details: {
          cached_tokens: 1000,
          cache_write_tokens: 5000,
          cache_write_tokens_details: { ttl_30m_tokens: 1000, ttl_12h_tokens: 1000 },
        },
        output_tokens: 100,
      },
      { supportsCacheWrite: true },
    );
    expect(result.completeness).toBe('partial');
    expect(result.issues.join(' ')).toContain('不一致');
  });

  it('完全没有 usage 时标记为 missing', () => {
    const result = normalizeOpenAIUsage(null, { supportsCacheWrite: true });
    expect(result.completeness).toBe('missing');
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
  });
});

describe('DeepSeek usage 规范化', () => {
  it('prompt_tokens 等于命中与未命中之和', () => {
    const result = normalizeDeepSeekUsage({
      prompt_tokens: 3000,
      prompt_cache_hit_tokens: 2000,
      prompt_cache_miss_tokens: 1000,
      completion_tokens: 500,
      completion_tokens_details: { reasoning_tokens: 180 },
      total_tokens: 3500,
    });
    expect(result.completeness).toBe('complete');
    expect(result.usage.inputTokens).toBe(3000);
    expect(result.usage.cacheReadTokens).toBe(2000);
    expect(result.usage.uncachedInputTokens).toBe(1000);
    expect(result.usage.cacheWriteTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(500);
    expect(result.usage.reasoningTokens).toBe(180);
  });

  it('命中与未命中之和不等于 prompt_tokens 时标记为部分未知', () => {
    const result = normalizeDeepSeekUsage({
      prompt_tokens: 3000,
      prompt_cache_hit_tokens: 2000,
      prompt_cache_miss_tokens: 500,
      completion_tokens: 100,
    });
    expect(result.completeness).toBe('partial');
    expect(result.issues.join(' ')).toContain('不一致');
  });

  it('reasoning_tokens 缺失时保持未知而不是 0', () => {
    const result = normalizeDeepSeekUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 10,
    });
    expect(result.usage.reasoningTokens).toBeNull();
    expect(result.completeness).toBe('complete');
  });

  it('缺失 usage 时不产生虚假的 0 用量', () => {
    const result = normalizeDeepSeekUsage(undefined);
    expect(result.completeness).toBe('missing');
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
  });
});

describe('usage 汇总', () => {
  it('同一 Turn 多次请求可汇总，并记录未知请求数', () => {
    const first = normalizeDeepSeekUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 50,
      prompt_cache_miss_tokens: 50,
      completion_tokens: 20,
    }).usage;
    const second = normalizeDeepSeekUsage({
      prompt_tokens: 300,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 200,
      completion_tokens: 30,
    }).usage;
    const summary = sumUsage([first, second, null]);
    expect(summary.usage.inputTokens).toBe(400);
    expect(summary.usage.outputTokens).toBe(50);
    expect(summary.unknownRequestCount).toBe(1);
  });
});
