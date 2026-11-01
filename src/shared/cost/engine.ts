import Decimal from 'decimal.js';
import type {
  BillingTier,
  ContextTier,
  CostBreakdownItem,
  CostResult,
  Currency,
  NormalizedUsage,
  PriceTable,
} from '../types';

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

export interface FxSnapshot {
  rate: string;
  source: string;
  effectiveAt?: string;
}

export interface PriceSelection {
  table: PriceTable | null;
  longContext: (PriceTable & { thresholdTokens: number }) | null;
  contextTier: ContextTier;
  missing: string[];
  notes: string[];
}

/**
 * 按输入 Token 数量与峰谷档位选择价格表。
 * 长上下文档位只在输入 Token 已知且严格大于阈值时启用。
 */
export function selectPriceTable(
  standard: PriceTable,
  longContext: (PriceTable & { thresholdTokens: number }) | null,
  offPeak: PriceTable | null,
  usage: NormalizedUsage,
  billingTier: BillingTier,
): PriceSelection {
  const missing: string[] = [];
  const notes: string[] = [];
  let base: PriceTable | null = standard;

  if (billingTier === 'unknown') {
    missing.push('无法确定峰谷价格档位');
  } else if (billingTier === 'offpeak') {
    if (!offPeak) missing.push('该模型缺少低谷时段价格');
    else base = offPeak;
  }

  let table: PriceTable | null = base;
  let contextTier: ContextTier = 'none';
  let resolvedLong: (PriceTable & { thresholdTokens: number }) | null = null;

  if (longContext) {
    resolvedLong = longContext;
    if (usage.inputTokens === null) {
      notes.push('输入 Token 未知，无法判断长上下文价格档位');
      contextTier = 'none';
      table = null;
    } else if (usage.inputTokens > longContext.thresholdTokens) {
      contextTier = 'long';
      if (billingTier === 'offpeak' && offPeak) {
        // OpenAI 不使用峰谷价；这里为防御性处理，保持与标准档一致的长上下文表。
        notes.push('长上下文档位使用价格表中的长上下文价格');
      }
      table = longContext;
    } else {
      contextTier = 'short';
    }
  } else if (usage.inputTokens !== null) {
    contextTier = 'short';
  }

  return { table, longContext: resolvedLong, contextTier, missing, notes };
}

export interface CostInput {
  usage: NormalizedUsage;
  standard: PriceTable;
  longContext: (PriceTable & { thresholdTokens: number }) | null;
  offPeak?: PriceTable | null;
  billingTier: BillingTier;
  fx?: FxSnapshot | null;
  extraNotes?: string[];
}

export function calculateCost(input: CostInput): CostResult {
  const { usage, fx, billingTier } = input;
  const missing: string[] = [];
  const notes: string[] = [...(input.extraNotes ?? [])];
  const breakdown: CostBreakdownItem[] = [];

  const selection = selectPriceTable(
    input.standard,
    input.longContext,
    input.offPeak ?? null,
    usage,
    billingTier,
  );
  missing.push(...selection.missing);
  notes.push(...selection.notes);
  const table = selection.table;

  if (!table) {
    return {
      status: 'unknown',
      currency: input.standard.currency,
      amount: null,
      usdAmount: null,
      fxRate: null,
      fxSource: null,
      breakdown: [],
      missing: missing.length > 0 ? missing : ['缺少可用价格表'],
      notes,
      contextTier: selection.contextTier,
    };
  }

  const currency: Currency = table.currency;

  if (usage.inputTokens === null) missing.push('缺少输入 Token');
  if (usage.outputTokens === null) missing.push('缺少输出 Token');

  const cacheRead = usage.cacheReadTokens;
  if (table.cachedInputPerM === null) {
    if (cacheRead !== null && cacheRead > 0) {
      missing.push('该模型未配置缓存读取价格，但 usage 含缓存读取 Token');
    }
  } else if (cacheRead === null) {
    missing.push('usage 缺少缓存读取 Token，无法准确计算输入费用');
  }

  let cacheWrite30m = usage.cacheWrite30mTokens;
  let cacheWrite12h = usage.cacheWrite12hTokens;
  if (usage.cacheWriteTokens === 0) {
    if ((cacheWrite30m ?? 0) + (cacheWrite12h ?? 0) > 0) {
      missing.push('缓存写入总量为 0，但 TTL 明细非 0，usage 不一致');
    }
    cacheWrite30m = 0;
    cacheWrite12h = 0;
  } else {
    if (cacheWrite30m === null || cacheWrite12h === null) {
      if ((usage.cacheWriteTokens ?? 0) > 0) {
        missing.push('缺少缓存写入 TTL 明细，无法按 30 分钟 / 12 小时分别计价');
      }
    }
  }

  const writeTotal =
    cacheWrite30m !== null && cacheWrite12h !== null
      ? cacheWrite30m + cacheWrite12h
      : null;

  let uncached = usage.uncachedInputTokens;
  if (uncached === null && usage.inputTokens !== null && cacheRead !== null && writeTotal !== null) {
    uncached = usage.inputTokens - cacheRead - writeTotal;
  }
  if (uncached !== null && uncached < 0) {
    missing.push('普通输入 Token 为负数，usage 与缓存明细不一致');
  }
  if (uncached === null) missing.push('缺少未缓存输入 Token');

  if (missing.length > 0) {
    return {
      status: 'unknown',
      currency,
      amount: null,
      usdAmount: null,
      fxRate: null,
      fxSource: null,
      breakdown: [],
      missing: [...new Set(missing)],
      notes,
      contextTier: selection.contextTier,
    };
  }

  const perMillion = new Decimal(1_000_000);
  const add = (
    label: string,
    tokens: number,
    unitPricePerM: string | null,
  ): Decimal => {
    if (tokens === 0) {
      breakdown.push({ label, tokens, unitPricePerM, amount: '0' });
      return new Decimal(0);
    }
    if (unitPricePerM === null) {
      missing.push(`缺少价格：${label}`);
      breakdown.push({ label, tokens, unitPricePerM: null, amount: null });
      return new Decimal(0);
    }
    const amount = new Decimal(tokens).mul(unitPricePerM).div(perMillion);
    breakdown.push({ label, tokens, unitPricePerM, amount: toDecimalString(amount) });
    return amount;
  };

  let total = new Decimal(0);
  total = total.plus(add('普通输入', uncached!, table.inputPerM));
  total = total.plus(add('缓存读取', cacheRead ?? 0, table.cachedInputPerM));
  total = total.plus(add('缓存写入（30 分钟）', cacheWrite30m ?? 0, table.cacheWrite30mPerM));
  total = total.plus(add('缓存写入（12 小时）', cacheWrite12h ?? 0, table.cacheWrite12hPerM));
  total = total.plus(add('输出', usage.outputTokens!, table.outputPerM));

  if (missing.length > 0) {
    return {
      status: 'unknown',
      currency,
      amount: null,
      usdAmount: null,
      fxRate: null,
      fxSource: null,
      breakdown,
      missing: [...new Set(missing)],
      notes,
      contextTier: selection.contextTier,
    };
  }

  if (usage.reasoningTokens !== null && usage.reasoningTokens > 0) {
    notes.push('推理 Token 已包含在输出 Token 内，未重复计费');
  }
  if (usage.cacheWriteTokens !== null && usage.cacheWriteTokens > 0) {
    notes.push('缓存写入 Token 已包含在输入 Token 内，仅按 TTL 明细计费一次');
  }
  if (selection.contextTier === 'long') {
    notes.push(`输入超过长上下文阈值，采用长上下文价格（> ${input.longContext?.thresholdTokens ?? 0} Token）`);
  }
  if (billingTier === 'peak') notes.push('DeepSeek 高峰时段价格');
  if (billingTier === 'offpeak') notes.push('DeepSeek 空闲时段价格（高峰价 5 折）');

  const amount = toDecimalString(total);
  let usdAmount: string | null = null;
  let fxRate: string | null = null;
  let fxSource: string | null = null;

  if (currency === 'USD') {
    usdAmount = amount;
    fxRate = '1';
    fxSource = 'USD 原生计价';
  } else if (fx && fx.rate) {
    const rate = new Decimal(fx.rate);
    if (rate.greaterThan(0)) {
      usdAmount = toDecimalString(total.mul(rate));
      fxRate = toDecimalString(rate);
      fxSource = fx.source;
      notes.push('美元金额由人民币估算费用按汇率折算，仅为估算，不代表官方美元扣款');
    } else {
      notes.push('汇率无效，无法折算美元');
    }
  } else {
    notes.push('未配置汇率，仅显示人民币估算费用');
  }

  return {
    status: 'calculated',
    currency,
    amount,
    usdAmount,
    fxRate,
    fxSource,
    breakdown,
    missing: [],
    notes,
    contextTier: selection.contextTier,
  };
}

/** 将 Decimal 转为无指数、无多余尾零的十进制字符串。 */
export function toDecimalString(value: Decimal | string | number): string {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  if (decimal.isZero()) return '0';
  const fixed = decimal.toFixed(18);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}
