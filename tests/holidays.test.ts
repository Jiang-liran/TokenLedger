import { describe, expect, it } from 'vitest';
import {
  buildHolidayConfig,
  holidayCoverageWarning,
  selectDeepSeekTariff,
  toShanghaiTime,
  type HolidayOverride,
} from '../src/shared/pricing/holidays';

const config = buildHolidayConfig();

describe('DeepSeek 峰谷时段判定（Asia/Shanghai）', () => {
  it('工作日 09:00 为高峰开始', () => {
    const result = selectDeepSeekTariff(new Date('2026-11-02T01:00:00Z'), config);
    expect(result.tier).toBe('peak');
    expect(result.shanghaiTime).toBe('09:00');
    expect(result.covered).toBe(true);
  });

  it('工作日 11:59 仍为高峰', () => {
    expect(selectDeepSeekTariff(new Date('2026-11-02T03:59:00Z'), config).tier).toBe('peak');
  });

  it('工作日 12:00 起为空闲', () => {
    expect(selectDeepSeekTariff(new Date('2026-11-02T04:00:00Z'), config).tier).toBe('offpeak');
  });

  it('工作日 14:00 起再次进入高峰', () => {
    expect(selectDeepSeekTariff(new Date('2026-11-02T06:00:00Z'), config).tier).toBe('peak');
  });

  it('工作日 18:00 起为空闲', () => {
    expect(selectDeepSeekTariff(new Date('2026-11-02T10:00:00Z'), config).tier).toBe('offpeak');
  });

  it('周末全天为空闲', () => {
    const result = selectDeepSeekTariff(new Date('2026-11-07T02:00:00Z'), config);
    expect(result.tier).toBe('offpeak');
    expect(result.isWeekend).toBe(true);
  });

  it('法定节假日全天为空闲，即使在工作日高峰时段', () => {
    // 2026-10-01 国庆节（周四）10:00
    const result = selectDeepSeekTariff(new Date('2026-10-01T02:00:00Z'), config);
    expect(result.tier).toBe('offpeak');
    expect(result.isHoliday).toBe(true);
    expect(result.holidayName).toBe('国庆节');
  });

  it('跨日时按上海时区换算日期', () => {
    const result = toShanghaiTime(new Date('2026-11-01T16:30:00Z'));
    expect(result.date).toBe('2026-11-02');
    expect(result.minutes).toBe(30);
  });

  it('日历覆盖之外默认返回未知，不静默套用错误费率', () => {
    const result = selectDeepSeekTariff(new Date('2027-01-04T02:00:00Z'), config);
    expect(result.covered).toBe(false);
    expect(result.tier).toBe('unknown');
    expect(result.reason).toContain('超出节假日日历覆盖范围');
  });

  it('用户显式允许后才按工作日规则估算', () => {
    const result = selectDeepSeekTariff(new Date('2027-01-04T02:00:00Z'), config, {
      allowUncoveredEstimate: true,
    });
    expect(result.covered).toBe(false);
    expect(result.tier).toBe('peak');
    expect(result.reason).toContain('估算');
  });
});

describe('节假日自定义与覆盖范围', () => {
  it('把节假日移除后按工作日高峰计价', () => {
    const overrides: HolidayOverride[] = [
      { date: '2026-10-01', name: '国庆节', action: 'remove' },
    ];
    const custom = buildHolidayConfig(overrides);
    const result = selectDeepSeekTariff(new Date('2026-10-01T02:00:00Z'), custom);
    expect(result.tier).toBe('peak');
  });

  it('新增节假日会生效', () => {
    const overrides: HolidayOverride[] = [
      { date: '2026-11-03', name: '公司假日', action: 'add' },
    ];
    const custom = buildHolidayConfig(overrides);
    const result = selectDeepSeekTariff(new Date('2026-11-03T02:00:00Z'), custom);
    expect(result.tier).toBe('offpeak');
    expect(result.holidayName).toBe('公司假日');
  });

  it('延长覆盖范围后不再提示未覆盖', () => {
    const extended = buildHolidayConfig([], '2027-12-31');
    const result = selectDeepSeekTariff(new Date('2027-01-04T02:00:00Z'), extended);
    expect(result.covered).toBe(true);
    expect(result.tier).toBe('peak');
  });

  it('覆盖到期时给出提示', () => {
    expect(holidayCoverageWarning(config, new Date('2027-01-05T00:00:00Z'))).toContain('仅覆盖至');
    expect(holidayCoverageWarning(config, new Date('2026-11-01T00:00:00Z'))).toBeNull();
  });
});
