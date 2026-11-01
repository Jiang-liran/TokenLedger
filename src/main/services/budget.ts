import Decimal from 'decimal.js';
import type { BudgetAlert, BudgetConfig } from '../../shared/types';

export function localDayStart(date = new Date()): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function localDayEnd(date = new Date()): Date {
  const copy = localDayStart(date);
  copy.setDate(copy.getDate() + 1);
  return copy;
}

export interface BudgetSnapshot {
  turnUsd: string;
  conversationUsd: string;
  dailyUsd: string;
  totalUsd: string;
}

function exceeds(actual: string, limit: string | null): boolean {
  if (!limit) return false;
  try {
    return new Decimal(actual).greaterThanOrEqualTo(limit);
  } catch {
    return false;
  }
}

/**
 * 本地预算提醒：仅基于已记录的估算费用，可能与服务商最终扣费不同。
 * 未返回 usage 的请求无法计入，提醒具有不确定性。
 */
export function evaluateBudget(
  config: BudgetConfig,
  actual: BudgetSnapshot,
  context: { conversationId?: string; turnId?: string } = {},
): BudgetAlert[] {
  if (!config.enabled) return [];
  const alerts: BudgetAlert[] = [];
  const note = '本地估算，可能低于服务商最终扣费；使用量未知的请求未计入。';
  if (exceeds(actual.turnUsd, config.turnUsd)) {
    alerts.push({
      scope: 'turn',
      limitUsd: config.turnUsd!,
      actualUsd: actual.turnUsd,
      conversationId: context.conversationId,
      turnId: context.turnId,
      note,
    });
  }
  if (exceeds(actual.conversationUsd, config.conversationUsd)) {
    alerts.push({
      scope: 'conversation',
      limitUsd: config.conversationUsd!,
      actualUsd: actual.conversationUsd,
      conversationId: context.conversationId,
      note,
    });
  }
  if (exceeds(actual.dailyUsd, config.dailyUsd)) {
    alerts.push({
      scope: 'daily',
      limitUsd: config.dailyUsd!,
      actualUsd: actual.dailyUsd,
      note,
    });
  }
  if (exceeds(actual.totalUsd, config.totalUsd)) {
    alerts.push({
      scope: 'total',
      limitUsd: config.totalUsd!,
      actualUsd: actual.totalUsd,
      note,
    });
  }
  return alerts;
}
