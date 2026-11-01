import { describe, expect, it } from 'vitest';
import { evaluateBudget, localDayEnd, localDayStart } from '../src/main/services/budget';
import { computeCustomRange, computePresetRange, toDateInputValue } from '../src/shared/time';

const config = {
  enabled: true,
  turnUsd: '0.01',
  conversationUsd: '0.02',
  dailyUsd: '1.00',
  totalUsd: '10.00',
};

describe('预算提醒', () => {
  it('达到或超过各层级上限时产生提醒', () => {
    const alerts = evaluateBudget(config, {
      turnUsd: '0.02',
      conversationUsd: '0.5',
      dailyUsd: '1.5',
      totalUsd: '12',
    });
    expect(alerts.map((alert) => alert.scope)).toEqual(['turn', 'conversation', 'daily', 'total']);
    expect(alerts[0].note).toContain('本地估算');
  });

  it('未超过上限时不提醒', () => {
    const alerts = evaluateBudget(config, {
      turnUsd: '0.001',
      conversationUsd: '0.005',
      dailyUsd: '0.1',
      totalUsd: '1',
    });
    expect(alerts).toHaveLength(0);
  });

  it('关闭预算提醒后不产生任何提醒', () => {
    const alerts = evaluateBudget(
      { ...config, enabled: false },
      { turnUsd: '99', conversationUsd: '99', dailyUsd: '99', totalUsd: '99' },
    );
    expect(alerts).toHaveLength(0);
  });

  it('未设置的上限被忽略', () => {
    const alerts = evaluateBudget(
      { enabled: true, turnUsd: null, conversationUsd: null, dailyUsd: null, totalUsd: null },
      { turnUsd: '99', conversationUsd: '99', dailyUsd: '99', totalUsd: '99' },
    );
    expect(alerts).toHaveLength(0);
  });
});

describe('统计时间范围', () => {
  const now = new Date('2026-11-04T12:00:00+08:00'); // 周三

  it('今日范围覆盖本机整日', () => {
    const range = computePresetRange('today', now);
    expect(range.from).toBe(new Date(2026, 10, 4, 0, 0, 0, 0).toISOString());
    expect(range.to).toBe(new Date(2026, 10, 5, 0, 0, 0, 0).toISOString());
  });

  it('本周从周一开始', () => {
    const range = computePresetRange('week', now);
    expect(range.from).toBe(new Date(2026, 10, 2, 0, 0, 0, 0).toISOString());
  });

  it('本月从 1 号开始', () => {
    const range = computePresetRange('month', now);
    expect(range.from).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
  });

  it('全部范围没有边界', () => {
    const range = computePresetRange('all', now);
    expect(range.from).toBeNull();
    expect(range.to).toBeNull();
  });

  it('自定义范围包含结束日期全天', () => {
    const range = computeCustomRange('2026-11-01', '2026-11-03');
    expect(range.from).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
    expect(range.to).toBe(new Date(2026, 10, 4, 0, 0, 0, 0).toISOString());
  });

  it('自定义范围起止颠倒时自动交换', () => {
    const range = computeCustomRange('2026-11-03', '2026-11-01');
    expect(range.from).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
  });

  it('本地日界线辅助函数正确', () => {
    const date = new Date(2026, 10, 4, 15, 30);
    expect(localDayStart(date).getHours()).toBe(0);
    expect(localDayEnd(date).getDate()).toBe(5);
  });

  it('日期输入值格式化', () => {
    expect(toDateInputValue(new Date(2026, 10, 4, 15, 30).toISOString())).toBe('2026-11-04');
    expect(toDateInputValue(null)).toBe('');
  });
});
