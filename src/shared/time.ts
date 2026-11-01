export type RangePreset = 'today' | 'week' | 'month' | 'all' | 'custom';

export interface TimeRange {
  from: string | null;
  to: string | null;
  preset: RangePreset;
  label: string;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() + 1);
  return copy;
}

function startOfWeek(date: Date): Date {
  const copy = startOfDay(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day; // 周一为一周起点
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function formatRangeLabel(from: Date, toExclusive: Date): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
  const end = new Date(toExclusive.getTime() - 86_400_000);
  return `${fmt.format(from)} – ${fmt.format(end)}`;
}

export function computePresetRange(preset: RangePreset, now = new Date()): TimeRange {
  if (preset === 'all') {
    return { from: null, to: null, preset, label: '历史全部' };
  }
  if (preset === 'today') {
    return {
      from: startOfDay(now).toISOString(),
      to: endOfDay(now).toISOString(),
      preset,
      label: '今日',
    };
  }
  if (preset === 'week') {
    const from = startOfWeek(now);
    return {
      from: from.toISOString(),
      to: endOfDay(now).toISOString(),
      preset,
      label: formatRangeLabel(from, endOfDay(now)),
    };
  }
  if (preset === 'month') {
    const from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    return {
      from: from.toISOString(),
      to: endOfDay(now).toISOString(),
      preset,
      label: formatRangeLabel(from, endOfDay(now)),
    };
  }
  return { from: null, to: null, preset: 'custom', label: '自定义' };
}

export function computeCustomRange(fromDate: string, toDate: string): TimeRange {
  const fromParts = fromDate.split('-').map(Number);
  const toParts = toDate.split('-').map(Number);
  if (fromParts.length !== 3 || toParts.length !== 3 || fromParts.some(Number.isNaN) || toParts.some(Number.isNaN)) {
    return { from: null, to: null, preset: 'custom', label: '自定义' };
  }
  const from = new Date(fromParts[0], fromParts[1] - 1, fromParts[2], 0, 0, 0, 0);
  const toEnd = new Date(toParts[0], toParts[1] - 1, toParts[2], 0, 0, 0, 0);
  if (toEnd < from) return computeCustomRange(toDate, fromDate);
  return {
    from: from.toISOString(),
    to: endOfDay(toEnd).toISOString(),
    preset: 'custom',
    label: formatRangeLabel(from, endOfDay(toEnd)),
  };
}

export function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}
