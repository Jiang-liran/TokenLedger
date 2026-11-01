import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calculateCost } from '../src/shared/cost/engine';
import { findModelPricing } from '../src/shared/pricing/catalog';
import { formatAmount } from '../src/shared/cost/format';
import type { NormalizedUsage } from '../src/shared/types';
import { usageFromDeepSeek, usageFromOpenAI } from './helpers';

function pricingOf(provider: 'openai' | 'deepseek', model: string) {
  const lookup = findModelPricing(provider, model);
  if (!lookup) throw new Error(`missing pricing ${model}`);
  return lookup.pricing;
}

function calculate(
  provider: 'openai' | 'deepseek',
  model: string,
  usage: NormalizedUsage,
  options: { tier?: 'peak' | 'offpeak' | 'standard'; fxRate?: string } = {},
) {
  const pricing = pricingOf(provider, model);
  return calculateCost({
    usage,
    standard: pricing.standard,
    longContext: pricing.longContext,
    offPeak: pricing.offPeak,
    billingTier: options.tier ?? 'standard',
    fx: options.fxRate
      ? { rate: options.fxRate, source: '测试汇率' }
      : null,
  });
}

describe('OpenAI 费用计算', () => {
  it('普通输入、缓存读取与输出分别按官方价格计算', () => {
    const result = calculate('openai', 'gpt-6.1-sol', usageFromOpenAI());
    expect(result.status).toBe('calculated');
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe('0.00485');
    expect(result.usdAmount).toBe('0.00485');
    expect(result.breakdown.find((item) => item.label === '普通输入')?.tokens).toBe(700);
    expect(result.breakdown.find((item) => item.label === '缓存读取')?.tokens).toBe(4500);
    expect(result.breakdown.find((item) => item.label === '输出')?.tokens).toBe(300);
  });

  it('30 分钟与 12 小时缓存写入分别计价且不重复计入', () => {
    const usage = normalizeWithWrites();
    const result = calculate('openai', 'gpt-6.1-sol', usage);
    expect(result.status).toBe('calculated');
    expect(result.amount).toBe('0.0399');
    const write30 = result.breakdown.find((item) => item.label.includes('30 分钟'));
    const write12 = result.breakdown.find((item) => item.label.includes('12 小时'));
    expect(write30?.amount).toBe('0.0075');
    expect(write12?.amount).toBe('0.02');
    expect(result.breakdown.some((item) => item.label === '缓存写入')).toBe(false);
  });

  it('推理 Token 已包含在输出中，不重复计费', () => {
    const withReasoning = usageFromOpenAI();
    const withoutReasoning: NormalizedUsage = { ...withReasoning, reasoningTokens: 0 };
    const a = calculate('openai', 'gpt-6.1-sol', withReasoning);
    const b = calculate('openai', 'gpt-6.1-sol', withoutReasoning);
    expect(a.amount).toBe(b.amount);
  });

  it('超过 272K 输入时使用长上下文档位价格', () => {
    const usage: NormalizedUsage = {
      inputTokens: 300_000,
      uncachedInputTokens: 300_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite30mTokens: 0,
      cacheWrite12hTokens: 0,
      outputTokens: 1000,
      reasoningTokens: 0,
      totalTokens: 301_000,
    };
    const result = calculate('openai', 'gpt-5.5', usage);
    expect(result.contextTier).toBe('long');
    expect(result.amount).toBe('3.045');
  });

  it('恰好 272K 输入仍使用标准档位', () => {
    const usage: NormalizedUsage = {
      inputTokens: 272_000,
      uncachedInputTokens: 272_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite30mTokens: 0,
      cacheWrite12hTokens: 0,
      outputTokens: 1000,
      reasoningTokens: 0,
      totalTokens: 273_000,
    };
    const result = calculate('openai', 'gpt-5.5', usage);
    expect(result.contextTier).toBe('short');
    expect(result.amount).toBe('1.39');
  });

  it('模型未配置缓存读取价格但 usage 含缓存 Token 时费用未知', () => {
    const usage: NormalizedUsage = {
      inputTokens: 1000,
      uncachedInputTokens: 900,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      cacheWrite30mTokens: 0,
      cacheWrite12hTokens: 0,
      outputTokens: 100,
      reasoningTokens: null,
      totalTokens: 1100,
    };
    const result = calculate('openai', 'gpt-5.5-pro', usage);
    expect(result.status).toBe('unknown');
    expect(result.amount).toBeNull();
    expect(result.missing.join(' ')).toContain('未配置缓存读取价格');
  });

  it('缺少输出 Token 时不计算费用', () => {
    const usage = { ...usageFromOpenAI(), outputTokens: null };
    const result = calculate('openai', 'gpt-6.1-sol', usage);
    expect(result.status).toBe('unknown');
    expect(result.missing.join(' ')).toContain('输出 Token');
  });

  it('长上下文输入 Token 未知时标记为未知', () => {
    const usage = { ...usageFromOpenAI(), inputTokens: null, uncachedInputTokens: null };
    const result = calculate('openai', 'gpt-5.5', usage);
    expect(result.status).toBe('unknown');
  });
});

describe('DeepSeek 费用计算', () => {
  it('高峰时段按命中、未命中与输出分别计价（CNY）', () => {
    const result = calculate('deepseek', 'deepseek-flash', usageFromDeepSeek(), { tier: 'peak' });
    expect(result.status).toBe('calculated');
    expect(result.currency).toBe('CNY');
    expect(result.amount).toBe('0.00608');
    expect(result.usdAmount).toBeNull();
  });

  it('空闲时段价格为高峰的 5 折', () => {
    const result = calculate('deepseek', 'deepseek-flash', usageFromDeepSeek(), { tier: 'offpeak' });
    expect(result.status).toBe('calculated');
    expect(result.amount).toBe('0.00304');
  });

  it('DeepSeek V4 Pro 使用不同价格', () => {
    const result = calculate('deepseek', 'deepseek-v4-pro', usageFromDeepSeek(), { tier: 'peak' });
    // 1000*9 + 2000*0.30 + 500*27 = 9000 + 600 + 13500 = 23100 / 1e6 = 0.0231
    expect(result.amount).toBe('0.0231');
  });

  it('人民币费用可按汇率快照折算为美元估算', () => {
    const result = calculate('deepseek', 'deepseek-flash', usageFromDeepSeek(), {
      tier: 'peak',
      fxRate: '0.150309',
    });
    expect(result.usdAmount).toBe('0.00091387872');
    expect(Number(result.usdAmount)).toBeCloseTo(0.0009139, 7);
    expect(result.notes.join(' ')).toContain('估算');
    expect(result.fxSource).toBe('测试汇率');
  });

  it('fee tier 未知时返回未知而不是猜测价格', () => {
    const result = calculate('deepseek', 'deepseek-flash', usageFromDeepSeek(), { tier: 'standard' });
    expect(result.status).toBe('calculated');
    const unknownTier = calculateCost({
      usage: usageFromDeepSeek(),
      standard: pricingOf('deepseek', 'deepseek-flash').standard,
      longContext: null,
      offPeak: pricingOf('deepseek', 'deepseek-flash').offPeak,
      billingTier: 'unknown',
    });
    expect(unknownTier.status).toBe('unknown');
    expect(unknownTier.missing.join(' ')).toContain('峰谷');
  });
});

describe('金额精度与展示', () => {
  it('非零微小费用不会显示为 $0.000000', () => {
    const usage: NormalizedUsage = {
      inputTokens: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite30mTokens: 0,
      cacheWrite12hTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 1,
    };
    const result = calculate('openai', 'gpt-6-luna', usage);
    expect(result.amount).toBe('0.0000005');
    const formatted = formatAmount(result.amount, 'USD');
    expect(formatted).not.toBe('$0.000000');
    expect(formatted).toBe('$0.0000005');
  });

  it('累计使用未提前舍入的高精度字符串', () => {
    const usage: NormalizedUsage = {
      inputTokens: 1,
      uncachedInputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite30mTokens: 0,
      cacheWrite12hTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
    };
    const first = calculate('openai', 'gpt-6-luna', usage);
    const second = calculate('openai', 'gpt-6-luna', usage);
    const sum = new Decimal(first.amount!).plus(second.amount!).toString();
    // 1*0.10 + 1*0.50 = 0.0000006 每次，两次合计 0.0000012
    expect(sum).toBe('0.0000012');
  });

  it('reasoning 费用说明不产生额外金额', () => {
    const result = calculate('deepseek', 'deepseek-flash', usageFromDeepSeek(), { tier: 'peak' });
    expect(result.notes.join(' ')).toContain('推理 Token 已包含在输出 Token 内');
  });
});

function normalizeWithWrites(): NormalizedUsage {
  return {
    inputTokens: 12000,
    uncachedInputTokens: 1000,
    cacheReadTokens: 4000,
    cacheWriteTokens: 7000,
    cacheWrite30mTokens: 3000,
    cacheWrite12hTokens: 4000,
    outputTokens: 1000,
    reasoningTokens: 300,
    totalTokens: 13000,
  };
}
