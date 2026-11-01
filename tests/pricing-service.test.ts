import { describe, expect, it } from 'vitest';
import { PricingService } from '../src/main/services/pricing';
import { createStore, tempDir } from './helpers';

function setup() {
  const { db, store } = createStore(tempDir());
  const pricing = new PricingService(store);
  return { db, store, pricing };
}

describe('价格解析与快照', () => {
  it('OpenAI 使用标准美元价格', () => {
    const { db, pricing } = setup();
    const { snapshot } = pricing.createSnapshot(
      'openai',
      'gpt-6.1-sol',
      new Date('2026-11-02T02:00:00Z'),
    );
    expect(snapshot?.currency).toBe('USD');
    expect(snapshot?.billingTier).toBe('standard');
    expect(snapshot?.table.inputPerM).toBe('2.00');
    expect(snapshot?.longContext?.thresholdTokens).toBe(272_000);
    expect(snapshot?.priceSource).toContain('developers.openai.com');
    db.close();
  });

  it('DeepSeek 高峰与空闲价格分别写入快照', () => {
    const { db, pricing } = setup();
    const peak = pricing.createSnapshot(
      'deepseek',
      'deepseek-flash',
      new Date('2026-11-02T02:00:00Z'),
    );
    expect(peak.snapshot?.currency).toBe('CNY');
    expect(peak.snapshot?.billingTier).toBe('peak');
    expect(peak.snapshot?.table.inputPerM).toBe('2.00');
    expect(peak.snapshot?.table.cachedInputPerM).toBe('0.04');
    expect(peak.snapshot?.table.outputPerM).toBe('8.00');

    const offpeak = pricing.createSnapshot(
      'deepseek',
      'deepseek-flash',
      new Date('2026-11-02T04:00:00Z'),
    );
    expect(offpeak.snapshot?.billingTier).toBe('offpeak');
    expect(offpeak.snapshot?.table.inputPerM).toBe('1.00');
    expect(offpeak.snapshot?.table.outputPerM).toBe('4.00');
    db.close();
  });

  it('未覆盖日期使用 unknown 档位并记录原因', () => {
    const { db, pricing } = setup();
    const result = pricing.createSnapshot(
      'deepseek',
      'deepseek-v4-pro',
      new Date('2027-06-01T02:00:00Z'),
    );
    expect(result.snapshot?.billingTier).toBe('unknown');
    expect(result.snapshot?.pricingBasis).toContain('超出节假日日历覆盖范围');
    expect(result.tariff?.covered).toBe(false);
    db.close();
  });

  it('未配置价格的模型返回 null，并给出可读原因', () => {
    const { db, pricing } = setup();
    const result = pricing.createSnapshot('openai', 'definitely-not-a-model', new Date());
    expect(result.snapshot).toBeNull();
    expect(result.reason).toContain('未配置模型');
    db.close();
  });

  it('模型别名与日期后缀沿用官方价格', () => {
    const { db, pricing } = setup();
    const alias = pricing.createSnapshot('deepseek', 'deepseek-v4-flash', new Date('2026-11-02T02:00:00Z'));
    expect(alias.snapshot?.model).toBe('deepseek-flash');
    const dated = pricing.createSnapshot('openai', 'gpt-6.1-sol-2026-05-01', new Date());
    expect(dated.snapshot?.model).toBe('gpt-6.1-sol');
    db.close();
  });
});

describe('用户价格覆盖', () => {
  it('部分字段覆盖时其余字段沿用内置价格', () => {
    const { db, store, pricing } = setup();
    store.upsertPriceOverride({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      inputPerM: '5',
      cachedInputPerM: null,
      cacheWrite30mPerM: null,
      cacheWrite12hPerM: null,
      outputPerM: null,
      offPeakInputPerM: null,
      offPeakCachedInputPerM: null,
      offPeakOutputPerM: null,
      currency: null,
      sourceUrl: null,
      effectiveFrom: '2026-11-01',
      notes: null,
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    const { snapshot } = pricing.createSnapshot('openai', 'gpt-6.1-sol', new Date());
    expect(snapshot?.table.inputPerM).toBe('5');
    expect(snapshot?.table.cachedInputPerM).toBe('0.10');
    expect(snapshot?.table.outputPerM).toBe('10.00');
    expect(snapshot?.isUserOverride).toBe(true);
    expect(snapshot?.pricingVersion).toContain('+user.');
    db.close();
  });

  it('可为全新模型配置价格，并按其币种计价', () => {
    const { db, store, pricing } = setup();
    store.upsertPriceOverride({
      provider: 'openai',
      model: 'my-custom-chat',
      inputPerM: '1',
      cachedInputPerM: null,
      cacheWrite30mPerM: null,
      cacheWrite12hPerM: null,
      outputPerM: '2',
      offPeakInputPerM: null,
      offPeakCachedInputPerM: null,
      offPeakOutputPerM: null,
      currency: 'USD',
      sourceUrl: 'https://example.com/my-pricing',
      effectiveFrom: '2026-11-01',
      notes: '内部模型',
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    const { snapshot, reason } = pricing.createSnapshot('openai', 'my-custom-chat', new Date());
    expect(reason).toBeNull();
    expect(snapshot?.table.inputPerM).toBe('1');
    expect(snapshot?.currency).toBe('USD');
    expect(pricing.getPricingForModel('openai', 'my-custom-chat')?.pricingVersion).toContain('custom');
    db.close();
  });

  it('删除覆盖后恢复内置价格', () => {
    const { db, store, pricing } = setup();
    store.upsertPriceOverride({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      inputPerM: '9',
      cachedInputPerM: null,
      cacheWrite30mPerM: null,
      cacheWrite12hPerM: null,
      outputPerM: '9',
      offPeakInputPerM: null,
      offPeakCachedInputPerM: null,
      offPeakOutputPerM: null,
      currency: null,
      sourceUrl: null,
      effectiveFrom: '2026-11-01',
      notes: null,
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    store.deletePriceOverride('openai', 'gpt-6.1-sol');
    const { snapshot } = pricing.createSnapshot('openai', 'gpt-6.1-sol', new Date());
    expect(snapshot?.table.inputPerM).toBe('2.00');
    db.close();
  });
});

describe('汇率快照', () => {
  it('首次使用时从设置创建汇率快照，重复调用不会重复创建', () => {
    const { db, store, pricing } = setup();
    const first = pricing.ensureFxSnapshot();
    const second = pricing.ensureFxSnapshot();
    expect(first.id).toBe(second.id);
    expect(first.rate).toBe(store.getSettings().fx.rate);
    const count = db.db.prepare('SELECT COUNT(*) AS c FROM exchange_rate_snapshots').get() as {
      c: number;
    };
    expect(count.c).toBe(1);
    db.close();
  });

  it('用户修改汇率后创建新快照并标记为用户配置', () => {
    const { db, pricing } = setup();
    const before = pricing.ensureFxSnapshot();
    const info = pricing.setFxRate('0.149999', '手动核对');
    expect(info.isUserConfigured).toBe(true);
    expect(info.rate).toBe('0.149999');
    const after = pricing.ensureFxSnapshot();
    expect(after.id).not.toBe(before.id);
    expect(after.rate).toBe('0.149999');
    db.close();
  });

  it('拒绝非法汇率', () => {
    const { db, pricing } = setup();
    expect(() => pricing.setFxRate('-1', 'bad')).toThrow('大于 0');
    expect(() => pricing.setFxRate('abc', 'bad')).toThrow('大于 0');
    db.close();
  });

  it('汇率信息包含来源与时效性', () => {
    const { db, pricing } = setup();
    const info = pricing.getFxInfo();
    expect(info.source).toContain('ECB');
    expect(info.sourceUrl).toContain('ecb.europa.eu');
    expect(info.stale).toBe(false);
    db.close();
  });
});

describe('节假日规则信息', () => {
  it('返回覆盖范围、来源与用户覆盖项', () => {
    const { db, store, pricing } = setup();
    store.replaceHolidayOverrides([{ date: '2026-11-03', name: '测试假日', action: 'add' }]);
    const info = pricing.getHolidayInfo();
    expect(info.coverageStart).toBe('2025-01-01');
    expect(info.coverageEnd).toBe('2026-12-31');
    expect(info.overrides).toHaveLength(1);
    expect(info.sourceUrl).toContain('gov.cn');
    expect(info.holidays.some((holiday) => holiday.date === '2026-10-01')).toBe(true);
    db.close();
  });
});
