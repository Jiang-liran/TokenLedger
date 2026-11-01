import Decimal from 'decimal.js';
import type { Currency } from '../types';

const tokenFormatter = new Intl.NumberFormat('en-US');

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return tokenFormatter.format(value);
}

/** 费用符号：美元 $，人民币 ¥。 */
export function currencySymbol(currency: Currency): string {
  return currency === 'USD' ? '$' : '¥';
}

/**
 * 金额格式化：
 * - 默认至少 6 位小数；
 * - 极小的非零费用自动扩展小数位，绝不显示成 0.000000；
 * - 未知（null）显示“未知”，不显示 0。
 */
export function formatAmount(
  amount: string | null | undefined,
  currency: Currency,
  minDecimals = 6,
): string {
  if (amount === null || amount === undefined) return '未知';
  let value: Decimal;
  try {
    value = new Decimal(amount);
  } catch {
    return '未知';
  }
  if (!value.isFinite()) return '未知';
  const symbol = currencySymbol(currency);
  if (value.isZero()) return `${symbol}${new Decimal(0).toFixed(minDecimals)}`;
  let decimals = minDecimals;
  while (decimals < 15 && value.abs().lt(new Decimal(10).pow(-decimals))) decimals += 1;
  return `${symbol}${value.toFixed(decimals, Decimal.ROUND_HALF_UP)}`;
}

/** 美元金额，带 ≈ 前缀表示折算。 */
export function formatUsd(amount: string | null | undefined, approx = false): string {
  const formatted = formatAmount(amount, 'USD');
  if (formatted === '未知') return formatted;
  return approx ? `≈ ${formatted}` : formatted;
}

export function formatNativeAndUsd(
  amount: string | null,
  currency: Currency,
  usdAmount: string | null,
): string {
  if (amount === null) return '费用未知';
  const native = formatAmount(amount, currency);
  if (currency === 'USD') return native;
  if (usdAmount === null) return `${native}（美元折算不可用）`;
  return `${native} · ${formatUsd(usdAmount, true)}`;
}

export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '未知';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date);
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const diff = now - date.getTime();
  if (!Number.isFinite(diff)) return '';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '未知';
  return `${value.toFixed(1)}%`;
}

/** 紧凑格式用于顶栏：40,000 Tokens · $0.104000 */
export function compactUsageLine(totalTokens: number, costUsd: string | null): string {
  const tokenPart = `${formatTokens(totalTokens)} Tokens`;
  const costPart = costUsd === null ? '费用未知' : formatUsd(costUsd);
  return `${tokenPart} · ${costPart}`;
}

export function truncateTitle(text: string, max = 48): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}
