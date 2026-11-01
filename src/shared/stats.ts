import Decimal from 'decimal.js';
import type {
  ApiRequestRow,
  CalculationStatus,
  ConversationStats,
  Currency,
  GlobalStats,
  NormalizedUsage,
  ProviderId,
  RequestPurpose,
  TimeBucket,
} from './types';
import { toDecimalString } from './cost/engine';

export interface StatRequest {
  id: string;
  conversationId: string;
  conversationTitle: string;
  turnId: string | null;
  provider: ProviderId;
  model: string;
  requestPurpose: RequestPurpose;
  startedAt: string;
  status: ApiRequestRow['status'];
  usage: NormalizedUsage | null;
  costAmount: string | null;
  costCurrency: Currency | null;
  costUsd: string | null;
  calculationStatus: CalculationStatus;
  pricingSnapshotId: string | null;
  pricingVersion: string | null;
  pricingBasis: string | null;
  errorDetails: string | null;
}

export interface Totals {
  requestCount: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  tokensUnknownRequestCount: number;
  costUsd: Decimal;
  unknownCostRequestCount: number;
  partialCostRequestCount: number;
  nativeCosts: Map<Currency, { amount: Decimal; requestCount: number }>;
}

function addNumber(target: number, value: number | null): number {
  return target + (value ?? 0);
}

export function aggregateTotals(rows: StatRequest[]): Totals {
  const nativeCosts = new Map<Currency, { amount: Decimal; requestCount: number }>();
  let costUsd = new Decimal(0);
  let unknownCostRequestCount = 0;
  let partialCostRequestCount = 0;
  let inputTokens = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let tokensUnknownRequestCount = 0;

  for (const row of rows) {
    const usage = row.usage;
    if (!usage || usage.inputTokens === null || usage.outputTokens === null) {
      tokensUnknownRequestCount += 1;
    }
    inputTokens = addNumber(inputTokens, usage?.inputTokens ?? null);
    uncachedInputTokens = addNumber(uncachedInputTokens, usage?.uncachedInputTokens ?? null);
    cacheReadTokens = addNumber(cacheReadTokens, usage?.cacheReadTokens ?? null);
    cacheWriteTokens = addNumber(cacheWriteTokens, usage?.cacheWriteTokens ?? null);
    outputTokens = addNumber(outputTokens, usage?.outputTokens ?? null);
    reasoningTokens = addNumber(reasoningTokens, usage?.reasoningTokens ?? null);
    if (usage?.totalTokens !== null && usage?.totalTokens !== undefined) {
      totalTokens += usage.totalTokens;
    } else if (usage && usage.inputTokens !== null && usage.outputTokens !== null) {
      totalTokens += usage.inputTokens + usage.outputTokens;
    }

    if (row.calculationStatus === 'unknown' || row.costAmount === null) {
      unknownCostRequestCount += 1;
    } else {
      if (row.calculationStatus === 'partial') partialCostRequestCount += 1;
      if (row.costCurrency) {
        const entry = nativeCosts.get(row.costCurrency) ?? {
          amount: new Decimal(0),
          requestCount: 0,
        };
        entry.amount = entry.amount.plus(row.costAmount);
        entry.requestCount += 1;
        nativeCosts.set(row.costCurrency, entry);
      }
      if (row.costUsd !== null) {
        costUsd = costUsd.plus(row.costUsd);
      } else if (row.costCurrency !== 'USD') {
        partialCostRequestCount += 1;
      }
    }
  }

  return {
    requestCount: rows.length,
    inputTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    tokensUnknownRequestCount,
    costUsd,
    unknownCostRequestCount,
    partialCostRequestCount,
    nativeCosts,
  };
}

function nativeCostArray(
  nativeCosts: Map<Currency, { amount: Decimal; requestCount: number }>,
): { currency: Currency; amount: string; requestCount: number }[] {
  return [...nativeCosts.entries()].map(([currency, value]) => ({
    currency,
    amount: toDecimalString(value.amount),
    requestCount: value.requestCount,
  }));
}

function ratio(cacheRead: number, input: number): number | null {
  if (input <= 0) return null;
  return cacheRead / input;
}

export function buildConversationStats(
  conversationId: string,
  rows: StatRequest[],
  turnCount: number,
): ConversationStats {
  const totals = aggregateTotals(rows);
  const byModelMap = new Map<
    string,
    { provider: ProviderId; model: string; requestCount: number; totalTokens: number; costUsd: Decimal; complete: boolean }
  >();
  const byProviderMap = new Map<
    ProviderId,
    { requestCount: number; totalTokens: number; costUsd: Decimal; complete: boolean }
  >();

  for (const row of rows) {
    const tokens = row.usage?.totalTokens ?? null;
    const tokenCount =
      tokens !== null
        ? tokens
        : row.usage?.inputTokens !== null && row.usage?.outputTokens !== null
          ? (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0)
          : 0;
    const modelKey = `${row.provider}:${row.model}`;
    const modelEntry = byModelMap.get(modelKey) ?? {
      provider: row.provider,
      model: row.model,
      requestCount: 0,
      totalTokens: 0,
      costUsd: new Decimal(0),
      complete: true,
    };
    modelEntry.requestCount += 1;
    modelEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) modelEntry.costUsd = modelEntry.costUsd.plus(row.costUsd);
    else modelEntry.complete = false;
    byModelMap.set(modelKey, modelEntry);

    const providerEntry = byProviderMap.get(row.provider) ?? {
      requestCount: 0,
      totalTokens: 0,
      costUsd: new Decimal(0),
      complete: true,
    };
    providerEntry.requestCount += 1;
    providerEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) providerEntry.costUsd = providerEntry.costUsd.plus(row.costUsd);
    else providerEntry.complete = false;
    byProviderMap.set(row.provider, providerEntry);
  }

  return {
    conversationId,
    requestCount: rows.length,
    turnCount,
    inputTokens: totals.inputTokens,
    uncachedInputTokens: totals.uncachedInputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: totals.totalTokens,
    tokensUnknownRequestCount: totals.tokensUnknownRequestCount,
    costUsd: toDecimalString(totals.costUsd),
    costUsdComplete: totals.unknownCostRequestCount === 0 && totals.partialCostRequestCount === 0,
    nativeCosts: nativeCostArray(totals.nativeCosts),
    unknownCostRequestCount: totals.unknownCostRequestCount,
    partialCostRequestCount: totals.partialCostRequestCount,
    cacheHitRatio: ratio(totals.cacheReadTokens, totals.inputTokens),
    byModel: [...byModelMap.values()].map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      requestCount: entry.requestCount,
      totalTokens: entry.totalTokens,
      costUsd: toDecimalString(entry.costUsd),
    })),
    byProvider: [...byProviderMap.entries()].map(([provider, entry]) => ({
      provider,
      requestCount: entry.requestCount,
      totalTokens: entry.totalTokens,
      costUsd: toDecimalString(entry.costUsd),
    })),
  };
}

export function localDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '1970-01-01';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildGlobalStats(
  rows: StatRequest[],
  options: {
    from: string | null;
    to: string | null;
    conversationCount: number;
  },
): GlobalStats {
  const totals = aggregateTotals(rows);
  const providerMap = new Map<
    ProviderId,
    { requestCount: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: Decimal; complete: boolean }
  >();
  const modelMap = new Map<
    string,
    { provider: ProviderId; model: string; requestCount: number; totalTokens: number; costUsd: Decimal; complete: boolean }
  >();
  const purposeMap = new Map<
    RequestPurpose,
    { requestCount: number; totalTokens: number; costUsd: Decimal; complete: boolean }
  >();
  const conversationMap = new Map<
    string,
    { title: string; requestCount: number; totalTokens: number; costUsd: Decimal; complete: boolean }
  >();
  const dayMap = new Map<string, { totalTokens: number; costUsd: Decimal; requestCount: number }>();

  for (const row of rows) {
    const tokenCount =
      row.usage?.totalTokens ??
      (row.usage?.inputTokens !== null && row.usage?.outputTokens !== null
        ? (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0)
        : 0);
    const providerEntry = providerMap.get(row.provider) ?? {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: new Decimal(0),
      complete: true,
    };
    providerEntry.requestCount += 1;
    providerEntry.inputTokens += row.usage?.inputTokens ?? 0;
    providerEntry.outputTokens += row.usage?.outputTokens ?? 0;
    providerEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) providerEntry.costUsd = providerEntry.costUsd.plus(row.costUsd);
    else providerEntry.complete = false;
    providerMap.set(row.provider, providerEntry);

    const modelKey = `${row.provider}:${row.model}`;
    const modelEntry = modelMap.get(modelKey) ?? {
      provider: row.provider,
      model: row.model,
      requestCount: 0,
      totalTokens: 0,
      costUsd: new Decimal(0),
      complete: true,
    };
    modelEntry.requestCount += 1;
    modelEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) modelEntry.costUsd = modelEntry.costUsd.plus(row.costUsd);
    else modelEntry.complete = false;
    modelMap.set(modelKey, modelEntry);

    const purposeEntry = purposeMap.get(row.requestPurpose) ?? {
      requestCount: 0,
      totalTokens: 0,
      costUsd: new Decimal(0),
      complete: true,
    };
    purposeEntry.requestCount += 1;
    purposeEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) purposeEntry.costUsd = purposeEntry.costUsd.plus(row.costUsd);
    else purposeEntry.complete = false;
    purposeMap.set(row.requestPurpose, purposeEntry);

    const conversationEntry = conversationMap.get(row.conversationId) ?? {
      title: row.conversationTitle,
      requestCount: 0,
      totalTokens: 0,
      costUsd: new Decimal(0),
      complete: true,
    };
    conversationEntry.requestCount += 1;
    conversationEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) conversationEntry.costUsd = conversationEntry.costUsd.plus(row.costUsd);
    else conversationEntry.complete = false;
    conversationMap.set(row.conversationId, conversationEntry);

    const dayKey = localDateKey(row.startedAt);
    const dayEntry = dayMap.get(dayKey) ?? {
      totalTokens: 0,
      costUsd: new Decimal(0),
      requestCount: 0,
    };
    dayEntry.totalTokens += tokenCount;
    if (row.costUsd !== null) dayEntry.costUsd = dayEntry.costUsd.plus(row.costUsd);
    dayEntry.requestCount += 1;
    dayMap.set(dayKey, dayEntry);
  }

  const byDay: TimeBucket[] = [...dayMap.entries()]
    .map(([date, value]) => ({
      date,
      totalTokens: value.totalTokens,
      costUsd: toDecimalString(value.costUsd),
      requestCount: value.requestCount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const recentRequests: ApiRequestRow[] = [...rows]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 50)
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      startedAt: row.startedAt,
      status: row.status,
      requestPurpose: row.requestPurpose,
      inputTokens: row.usage?.inputTokens ?? null,
      cacheReadTokens: row.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: row.usage?.cacheWriteTokens ?? null,
      outputTokens: row.usage?.outputTokens ?? null,
      totalTokens:
        row.usage?.totalTokens ??
        (row.usage?.inputTokens !== null && row.usage?.outputTokens !== null
          ? (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0)
          : null),
      costAmount: row.costAmount,
      costCurrency: row.costCurrency,
      costUsd: row.costUsd,
      calculationStatus: row.calculationStatus,
      errorDetails: row.errorDetails,
      pricingSnapshotId: row.pricingSnapshotId,
      pricingVersion: row.pricingVersion,
      pricingBasis: row.pricingBasis,
    }));

  return {
    range: { from: options.from, to: options.to },
    requestCount: rows.length,
    conversationCount: options.conversationCount,
    inputTokens: totals.inputTokens,
    uncachedInputTokens: totals.uncachedInputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: totals.totalTokens,
    tokensUnknownRequestCount: totals.tokensUnknownRequestCount,
    costUsd: toDecimalString(totals.costUsd),
    costUsdComplete: totals.unknownCostRequestCount === 0 && totals.partialCostRequestCount === 0,
    nativeCosts: nativeCostArray(totals.nativeCosts),
    unknownCostRequestCount: totals.unknownCostRequestCount,
    partialCostRequestCount: totals.partialCostRequestCount,
    cacheHitRatio: ratio(totals.cacheReadTokens, totals.inputTokens),
    byProvider: [...providerMap.entries()].map(([provider, entry]) => ({
      provider,
      requestCount: entry.requestCount,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      costUsd: toDecimalString(entry.costUsd),
      costUsdComplete: entry.complete,
    })),
    byModel: [...modelMap.values()].map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      requestCount: entry.requestCount,
      totalTokens: entry.totalTokens,
      costUsd: toDecimalString(entry.costUsd),
      costUsdComplete: entry.complete,
    })),
    byConversation: [...conversationMap.entries()]
      .map(([conversationId, entry]) => ({
        conversationId,
        title: entry.title,
        requestCount: entry.requestCount,
        totalTokens: entry.totalTokens,
        costUsd: toDecimalString(entry.costUsd),
        costUsdComplete: entry.complete,
      }))
      .sort((a, b) => new Decimal(b.costUsd).comparedTo(new Decimal(a.costUsd))),
    byDay,
    byCurrency: nativeCostArray(totals.nativeCosts),
    recentRequests,
    byPurpose: [...purposeMap.entries()].map(([purpose, entry]) => ({
      purpose,
      requestCount: entry.requestCount,
      totalTokens: entry.totalTokens,
      costUsd: toDecimalString(entry.costUsd),
      costUsdComplete: entry.complete,
    })),
  };
}
