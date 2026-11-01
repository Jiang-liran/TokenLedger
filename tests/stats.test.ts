import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { aggregateTotals, buildConversationStats, buildGlobalStats, localDateKey } from '../src/shared/stats';
import { makeStatRequest } from './helpers';
import { usageFromDeepSeek } from './helpers';

const deepseekUsage = usageFromDeepSeek();

function deepseekRow(overrides = {}) {
  return makeStatRequest({
    id: 'req_ds',
    conversationId: 'conv_1',
    provider: 'deepseek',
    model: 'deepseek-flash',
    usage: deepseekUsage,
    costAmount: '0.00608',
    costCurrency: 'CNY',
    costUsd: '0.00091387872',
    pricingVersion: 'deepseek-2026.11.01',
    ...overrides,
  });
}

describe('用量聚合', () => {
  it('Token 分类求和且不重复相加', () => {
    const totals = aggregateTotals([makeStatRequest(), deepseekRow()]);
    expect(totals.requestCount).toBe(2);
    expect(totals.inputTokens).toBe(5200 + 3000);
    expect(totals.uncachedInputTokens).toBe(700 + 1000);
    expect(totals.cacheReadTokens).toBe(4500 + 2000);
    expect(totals.cacheWriteTokens).toBe(0);
    expect(totals.outputTokens).toBe(300 + 500);
    expect(totals.reasoningTokens).toBe(120 + 180);
    expect(totals.totalTokens).toBe(5500 + 3500);
  });

  it('费用按币种分别累计并合计美元', () => {
    const totals = aggregateTotals([makeStatRequest(), deepseekRow()]);
    expect(totals.costUsd.toString()).toBe('0.00576387872');
    expect(totals.nativeCosts.get('USD')?.amount.toString()).toBe('0.00485');
    expect(totals.nativeCosts.get('CNY')?.amount.toString()).toBe('0.00608');
  });

  it('用量未知的请求不会把 Token 或费用当成 0', () => {
    const unknown = makeStatRequest({
      id: 'req_unknown',
      usage: null,
      costAmount: null,
      costCurrency: null,
      costUsd: null,
      calculationStatus: 'unknown',
    });
    const totals = aggregateTotals([unknown]);
    expect(totals.tokensUnknownRequestCount).toBe(1);
    expect(totals.unknownCostRequestCount).toBe(1);
    expect(totals.costUsd.toString()).toBe('0');
    expect(totals.totalTokens).toBe(0);
  });

  it('缺少美元折算的费用被标记为部分', () => {
    const noFx = deepseekRow({ id: 'req_no_fx', costUsd: null });
    const totals = aggregateTotals([noFx]);
    expect(totals.partialCostRequestCount).toBe(1);
  });
});

describe('会话统计', () => {
  it('多轮、多模型、多服务商正确累计', () => {
    const rows = [
      makeStatRequest(),
      makeStatRequest({ id: 'req_2', conversationId: 'conv_1' }),
      deepseekRow(),
    ];
    const stats = buildConversationStats('conv_1', rows, 3);
    expect(stats.requestCount).toBe(3);
    expect(stats.totalTokens).toBe(5500 + 5500 + 3500);
    expect(stats.costUsd).toBe('0.01061387872');
    expect(stats.nativeCosts).toHaveLength(2);
    expect(stats.byProvider).toHaveLength(2);
    expect(stats.byModel).toHaveLength(2);
    expect(stats.cacheHitRatio).toBeCloseTo((4500 + 4500 + 2000) / (5200 + 5200 + 3000), 6);
  });

  it('未知费用不参与金额累计但计入请求数', () => {
    const rows = [
      makeStatRequest(),
      makeStatRequest({
        id: 'req_unknown',
        usage: null,
        costAmount: null,
        costCurrency: null,
        costUsd: null,
        calculationStatus: 'unknown',
      }),
    ];
    const stats = buildConversationStats('conv_1', rows, 2);
    expect(stats.requestCount).toBe(2);
    expect(stats.costUsd).toBe('0.00485');
    expect(stats.unknownCostRequestCount).toBe(1);
    expect(stats.costUsdComplete).toBe(false);
  });

  it('空会话统计为零', () => {
    const stats = buildConversationStats('conv_empty', [], 0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.costUsd).toBe('0');
    expect(stats.costUsdComplete).toBe(true);
  });
});

describe('全局统计', () => {
  it('按会话、模型、服务商与日期分组', () => {
    const rows = [
      makeStatRequest(),
      makeStatRequest({
        id: 'req_2',
        conversationId: 'conv_2',
        conversationTitle: '第二个会话',
      }),
      deepseekRow({ conversationId: 'conv_2', conversationTitle: '第二个会话' }),
    ];
    const stats = buildGlobalStats(rows, { from: null, to: null, conversationCount: 2 });
    expect(stats.requestCount).toBe(3);
    expect(stats.costUsd).toBe('0.01061387872');
    expect(stats.byConversation[0].costUsd).toBe('0.00576387872');
    expect(stats.byConversation[1].costUsd).toBe('0.00485');
    expect(stats.byConversation[0].conversationId).toBe('conv_2');
    expect(stats.byProvider.find((item) => item.provider === 'deepseek')?.requestCount).toBe(1);
    expect(stats.byModel).toHaveLength(2);
    expect(stats.byDay).toHaveLength(1);
  });

  it('日期分组使用本地日期', () => {
    expect(localDateKey('2026-11-02T02:00:00.000Z')).toBe('2026-11-02');
    const rows = [
      makeStatRequest({ id: 'a', startedAt: '2026-11-02T02:00:00.000Z' }),
      makeStatRequest({ id: 'b', startedAt: '2026-11-02T16:30:00.000Z' }),
    ];
    const stats = buildGlobalStats(rows, { from: null, to: null, conversationCount: 1 });
    expect(stats.byDay.map((day) => day.date)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('全局美元合计使用 Decimal 避免浮点误差', () => {
    const rows = [
      makeStatRequest({ id: 'a', costUsd: '0.1', costAmount: '0.1' }),
      makeStatRequest({ id: 'b', costUsd: '0.2', costAmount: '0.2' }),
    ];
    const stats = buildGlobalStats(rows, { from: null, to: null, conversationCount: 1 });
    expect(new Decimal(stats.costUsd).toString()).toBe('0.3');
  });
});
