import type {
  BillingTier,
  CostResult,
  Currency,
  ExchangeRateInfo,
  HolidayRuleInfo,
  ModelPricing,
  NormalizedUsage,
  PriceTable,
  PricingSnapshot,
  ProviderId,
  RecalculateCostResult,
} from '../../shared/types';
import type { PriceOverrideRow } from '../../shared/ipc';
import type { Store } from '../db/repositories';
import type { FxSnapshotRecord } from '../db/repositories';
import {
  ALL_PRICING,
  DEEPSEEK_PRICING_VERSION,
  OPENAI_PRICING_VERSION,
  PRICING_VERIFIED_AT,
  findModelPricing,
  inferCapabilities,
  normalizeModelId,
} from '../../shared/pricing/catalog';
import {
  buildHolidayConfig,
  selectDeepSeekTariff,
  type HolidayConfig,
  type TariffSelection,
} from '../../shared/pricing/holidays';
import { calculateCost } from '../../shared/cost/engine';
import { parseStoredUsage } from '../../shared/usage';
import { newIdWithPrefix } from '../../shared/id';
import type { AppSettings } from '../../shared/settings';

export interface PricingResolution {
  snapshot: PricingSnapshot | null;
  pricing: ModelPricing | null;
  tariff: TariffSelection | null;
  reason: string | null;
}

function mergePriceTable(
  base: PriceTable | null,
  override: PriceOverrideRow,
  currency: Currency,
  prefix: 'cacheWrite' | 'offPeak',
): PriceTable | null {
  const input =
    prefix === 'offPeak'
      ? (override.offPeakInputPerM ?? base?.inputPerM ?? null)
      : (override.inputPerM ?? base?.inputPerM ?? null);
  const output =
    prefix === 'offPeak'
      ? (override.offPeakOutputPerM ?? base?.outputPerM ?? null)
      : (override.outputPerM ?? base?.outputPerM ?? null);
  if (!input || !output) return null;
  if (prefix === 'offPeak') {
    return {
      currency,
      inputPerM: input,
      outputPerM: output,
      cachedInputPerM: override.offPeakCachedInputPerM ?? base?.cachedInputPerM ?? null,
      cacheWrite30mPerM: base?.cacheWrite30mPerM ?? null,
      cacheWrite12hPerM: base?.cacheWrite12hPerM ?? null,
    };
  }
  return {
    currency,
    inputPerM: input,
    outputPerM: output,
    cachedInputPerM: override.cachedInputPerM ?? base?.cachedInputPerM ?? null,
    cacheWrite30mPerM: override.cacheWrite30mPerM ?? base?.cacheWrite30mPerM ?? null,
    cacheWrite12hPerM: override.cacheWrite12hPerM ?? base?.cacheWrite12hPerM ?? null,
  };
}

function mergeOverride(base: ModelPricing | undefined, override: PriceOverrideRow): ModelPricing | null {
  const provider = override.provider;
  const providerCurrency: Currency = provider === 'openai' ? 'USD' : 'CNY';
  const currency = override.currency ?? base?.currency ?? providerCurrency;
  const standard = mergePriceTable(base?.standard ?? null, override, currency, 'cacheWrite');
  if (!standard) return null;
  const offPeakBase = base?.offPeak ?? null;
  const offPeak = mergePriceTable(offPeakBase, override, currency, 'offPeak');
  const notes = [...(base?.notes ?? []), '该模型价格包含用户手动覆盖，请核对官方价格与来源。'];
  if (base?.longContext) {
    notes.push('用户覆盖仅作用于标准档位，长上下文档位仍使用内置价格。');
  }
  return {
    provider,
    model: base?.model ?? normalizeModelId(override.model),
    displayName: base?.displayName ?? normalizeModelId(override.model),
    currency,
    pricingVersion: base
      ? `${base.pricingVersion}+user.${override.createdAt.slice(0, 10)}`
      : `${provider}-custom.${override.createdAt.slice(0, 10)}`,
    priceSource: override.sourceUrl || base?.priceSource || '用户手动配置',
    lastVerifiedAt: override.createdAt.slice(0, 10),
    effectiveFrom: override.effectiveFrom,
    tariff: base?.tariff ?? (provider === 'deepseek' ? 'deepseek-peak-offpeak' : null),
    standard,
    offPeak,
    longContext: base?.longContext ?? null,
    capabilities: base?.capabilities ?? inferCapabilities(provider, override.model),
    status: 'verified',
    notes,
    aliases: base?.aliases ?? [],
  };
}

export class PricingService {
  constructor(private readonly store: Store) {}

  private get settings(): AppSettings {
    return this.store.getSettings();
  }

  getHolidayConfig(): HolidayConfig {
    return buildHolidayConfig(this.store.listHolidayOverrides(), this.settings.holidayCoverageEnd);
  }

  getCatalog(): ModelPricing[] {
    const overrides = this.store.listPriceOverrides();
    const byKey = new Map(overrides.map((override) => [`${override.provider}:${normalizeModelId(override.model)}`, override]));
    const merged: ModelPricing[] = [];
    const used = new Set<string>();

    for (const base of ALL_PRICING) {
      const override = byKey.get(`${base.provider}:${base.model}`);
      if (override) {
        used.add(`${override.provider}:${normalizeModelId(override.model)}`);
        const mergedEntry = mergeOverride(base, override);
        merged.push(mergedEntry ?? base);
      } else {
        merged.push(base);
      }
    }
    for (const override of overrides) {
      const key = `${override.provider}:${normalizeModelId(override.model)}`;
      if (used.has(key)) continue;
      const mergedEntry = mergeOverride(undefined, override);
      if (mergedEntry) merged.push(mergedEntry);
    }
    return merged;
  }

  getCapabilities(provider: ProviderId, model: string) {
    const lookup = findModelPricing(provider, model, this.getCatalog());
    return lookup?.pricing.capabilities ?? inferCapabilities(provider, model);
  }

  getPricingForModel(provider: ProviderId, model: string): ModelPricing | null {
    const lookup = findModelPricing(provider, model, this.getCatalog());
    return lookup?.pricing ?? null;
  }

  getVersions(): { openai: string; deepseek: string; verifiedAt: string } {
    return {
      openai: OPENAI_PRICING_VERSION,
      deepseek: DEEPSEEK_PRICING_VERSION,
      verifiedAt: PRICING_VERIFIED_AT,
    };
  }

  /**
   * 在请求开始时创建不可变价格快照。
   * 快照包含当时采用的峰谷档位与实际单价；未来修改价格不会改变历史费用。
   */
  createSnapshot(provider: ProviderId, model: string, at: Date): PricingResolution {
    const catalog = this.getCatalog();
    const lookup = findModelPricing(provider, model, catalog);
    if (!lookup) {
      return {
        snapshot: null,
        pricing: null,
        tariff: null,
        reason: `未配置模型「${model}」的价格，费用将标记为未知（不会被当作免费）。可在设置中手动添加单价。`,
      };
    }
    const pricing = lookup.pricing;
    const notes = [...pricing.notes];
    if (lookup.matchedBy === 'prefix') {
      notes.push(`模型 ${model} 未精确匹配，按前缀匹配到 ${pricing.model} 的价格。`);
    } else if (lookup.matchedBy === 'alias') {
      notes.push(`模型 ${model} 按官方别名映射到 ${pricing.model} 的价格。`);
    }

    let billingTier: BillingTier = 'standard';
    let table = pricing.standard;
    let basis = '采用标准价格档位';
    let tariff: TariffSelection | null = null;

    if (pricing.tariff === 'deepseek-peak-offpeak') {
      tariff = selectDeepSeekTariff(at, this.getHolidayConfig(), {
        allowUncoveredEstimate: this.settings.allowUncoveredHolidayEstimate,
      });
      if (tariff.tier === 'unknown') {
        billingTier = 'unknown';
        basis = tariff.reason;
      } else if (tariff.tier === 'offpeak') {
        if (pricing.offPeak) {
          billingTier = 'offpeak';
          table = pricing.offPeak;
          basis = `${tariff.reason}；采用空闲时段价格（高峰价 5 折）`;
        } else {
          billingTier = 'unknown';
          basis = `${tariff.reason}；但该模型未配置空闲时段价格，无法计价`;
        }
      } else {
        billingTier = 'peak';
        table = pricing.standard;
        basis = `${tariff.reason}；采用高峰时段价格`;
      }
      if (!tariff.covered) notes.push('该请求的峰谷判定超出已核对的节假日日历范围。');
    }

    const snapshot: PricingSnapshot = {
      id: newIdWithPrefix('prc'),
      provider,
      model: pricing.model,
      pricingVersion: pricing.pricingVersion,
      priceSource: pricing.priceSource,
      effectiveAt: at.toISOString(),
      currency: pricing.currency,
      billingTier,
      table,
      longContext: pricing.longContext,
      pricingBasis: basis,
      isUserOverride: pricing.pricingVersion.includes('+user.'),
      notes,
    };
    this.store.insertPricingSnapshot(snapshot);
    return { snapshot, pricing, tariff, reason: null };
  }

  /** 使用快照与官方 usage 计算费用；不会重新读取当前价格表。 */
  computeCost(
    snapshot: PricingSnapshot,
    usage: NormalizedUsage,
    fx: FxSnapshotRecord | null,
  ): CostResult {
    return calculateCost({
      usage,
      standard: snapshot.table,
      longContext: snapshot.longContext,
      offPeak: null,
      billingTier: snapshot.billingTier === 'unknown' ? 'unknown' : 'standard',
      fx:
        snapshot.currency === 'CNY' && fx
          ? { rate: fx.rate, source: fx.source, effectiveAt: fx.effectiveAt }
          : null,
      extraNotes: [snapshot.pricingBasis, ...snapshot.notes],
    });
  }

  ensureFxSnapshot(): FxSnapshotRecord {
    const settings = this.settings;
    const latest = this.store.getLatestFxSnapshot();
    if (
      latest &&
      latest.rate === settings.fx.rate &&
      latest.source === settings.fx.source &&
      latest.effectiveAt === settings.fx.effectiveAt
    ) {
      return latest;
    }
    return this.store.insertFxSnapshot({
      base: 'CNY',
      quote: 'USD',
      rate: settings.fx.rate,
      source: settings.fx.source,
      sourceUrl: settings.fx.sourceUrl,
      effectiveAt: settings.fx.effectiveAt,
      isUserConfigured: false,
    });
  }

  getFxInfo(): ExchangeRateInfo {
    const record = this.ensureFxSnapshot();
    return this.toFxInfo(record);
  }

  toFxInfo(record: FxSnapshotRecord): ExchangeRateInfo {
    const ece = new Date(record.effectiveAt);
    const days = Number.isNaN(ece.getTime())
      ? Number.POSITIVE_INFINITY
      : (Date.now() - ece.getTime()) / 86_400_000;
    return {
      base: 'CNY',
      quote: 'USD',
      rate: record.rate,
      source: record.source,
      sourceUrl: record.sourceUrl,
      effectiveAt: record.effectiveAt,
      fetchedAt: record.fetchedAt,
      isUserConfigured: record.isUserConfigured,
      stale: days > 30,
    };
  }

  setFxRate(rate: string, source: string, effectiveAt?: string): ExchangeRateInfo {
    if (!/^\d+(\.\d{1,12})?$/.test(rate) || Number(rate) <= 0) {
      throw new Error('汇率必须是大于 0 的数字');
    }
    const record = this.store.insertFxSnapshot({
      base: 'CNY',
      quote: 'USD',
      rate,
      source: source.trim() || '用户配置的汇率',
      sourceUrl: 'local://user-configured',
      effectiveAt: effectiveAt ?? new Date().toISOString().slice(0, 10),
      isUserConfigured: true,
    });
    const settings = this.store.getSettings();
    this.store.saveSettings({
      ...settings,
      fx: {
        rate: record.rate,
        source: record.source,
        sourceUrl: record.sourceUrl,
        effectiveAt: record.effectiveAt,
      },
    });
    return this.toFxInfo(record);
  }

  setFxSnapshot(input: {
    rate: string;
    source: string;
    sourceUrl: string;
    effectiveAt: string;
  }): ExchangeRateInfo {
    const record = this.store.insertFxSnapshot({
      base: 'CNY',
      quote: 'USD',
      rate: input.rate,
      source: input.source,
      sourceUrl: input.sourceUrl,
      effectiveAt: input.effectiveAt,
      isUserConfigured: true,
    });
    const settings = this.store.getSettings();
    this.store.saveSettings({
      ...settings,
      fx: {
        rate: record.rate,
        source: record.source,
        sourceUrl: record.sourceUrl,
        effectiveAt: record.effectiveAt,
      },
    });
    return this.toFxInfo(record);
  }

  /**
   * 用户显式触发的历史费用重算：
   * - 使用当前价格配置与原始请求时间重新解析价格快照；
   * - 原费用、原快照 ID 与新费用一并写入 cost_recalculation_log；
   * - 原始 pricing_snapshots 行不会被修改，仍可追溯；
   * - 使用请求原始汇率快照；若原本没有，则使用当前汇率。
   */
  recalculateHistory(): RecalculateCostResult {
    const candidates = this.store.listRecalculationCandidates();
    let recalculated = 0;
    let skipped = 0;
    let unknownCostCount = 0;
    let missingFx = 0;

    this.store.transaction(() => {
      for (const candidate of candidates) {
        const usage = parseStoredUsage(candidate.normalizedUsage);
        if (!usage) {
          skipped += 1;
          continue;
        }
        let resolution;
        try {
          resolution = this.createSnapshot(
            candidate.provider,
            candidate.model,
            new Date(candidate.startedAt),
          );
        } catch {
          skipped += 1;
          continue;
        }
        if (!resolution.snapshot) {
          skipped += 1;
          continue;
        }
        let fx =
          candidate.exchangeRateSnapshotId !== null
            ? this.store.getFxSnapshotById(candidate.exchangeRateSnapshotId)
            : null;
        if (!fx && resolution.snapshot.currency === 'CNY') {
          fx = this.ensureFxSnapshot();
          missingFx += 1;
        }
        const cost = this.computeCost(resolution.snapshot, usage, fx);
        const calculationStatus = cost.status;
        const costAmount = calculationStatus === 'unknown' ? null : cost.amount;
        const costCurrency = calculationStatus === 'unknown' ? null : cost.currency;
        const costUsd = calculationStatus === 'unknown' ? null : cost.usdAmount;

        this.store.updateRequestCost(candidate.id, {
          costAmount,
          costCurrency,
          costUsd,
          exchangeRateSnapshotId:
            resolution.snapshot.currency === 'CNY' && calculationStatus === 'calculated' && fx
              ? fx.id
              : null,
          calculationStatus,
          pricingSnapshotId: resolution.snapshot.id,
          pricingBasis: resolution.snapshot.pricingBasis,
        });
        this.store.insertRecalculationLog({
          requestId: candidate.id,
          oldPricingSnapshotId: candidate.pricingSnapshotId,
          newPricingSnapshotId: resolution.snapshot.id,
          oldCostAmount: candidate.costAmount,
          oldCostCurrency: candidate.costCurrency,
          oldCostUsd: candidate.costUsd,
          newCostAmount: costAmount,
          newCostCurrency: costCurrency,
          newCostUsd: costUsd,
          reason: '用户触发的历史费用重算（按当前价格配置）',
        });
        recalculated += 1;
        if (calculationStatus === 'unknown') unknownCostCount += 1;
      }
    });

    return {
      totalCandidates: candidates.length,
      recalculated,
      skipped,
      unknownCostCount,
      note:
        missingFx > 0
          ? `有 ${missingFx} 次人民币请求缺少原始汇率快照，已使用当前汇率重新折算。`
          : '历史费用已按当前价格配置重新核算，原费用与核算记录已保留。',
    };
  }

  getHolidayInfo(): HolidayRuleInfo {
    const config = this.getHolidayConfig();
    return {
      coverageStart: config.coverageStart,
      coverageEnd: config.coverageEnd,
      holidays: config.holidays,
      overrides: config.overrides,
      allowUncoveredEstimate: this.settings.allowUncoveredHolidayEstimate,
      sourceUrl: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
    };
  }
}
