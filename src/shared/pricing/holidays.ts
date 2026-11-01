/**
 * DeepSeek 峰谷时段规则与节假日日历。
 *
 * 官方规则（2026-11-01 核对）：
 * 北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00 为高峰时段；
 * 其余时段（含周末、法定节假日全天）为空闲时段，空闲时段价格为高峰价的 50%。
 *
 * 节假日数据来自国务院办公厅 2026 年节假日安排通知，并允许用户在设置中增删。
 * 若请求时间超出日历覆盖范围，绝不静默套用工作日规则：
 * 默认返回 unknown，由用户显式允许后才按“估算”处理。
 */

export const DEEPSEEK_TARIFF_TIMEZONE = 'Asia/Shanghai';

export const HOLIDAY_COVERAGE_START = '2025-01-01';
export const HOLIDAY_COVERAGE_END = '2026-12-31';
export const HOLIDAY_SOURCE_URL =
  'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm';

export interface HolidayEntry {
  date: string;
  name: string;
}

/** 法定节假日（仅收录落在工作日的放假日期；周末本身已是低谷）。 */
export const BUILTIN_HOLIDAYS: HolidayEntry[] = [
  { date: '2025-01-01', name: '元旦' },
  { date: '2025-01-28', name: '春节' },
  { date: '2025-01-29', name: '春节' },
  { date: '2025-01-30', name: '春节' },
  { date: '2025-01-31', name: '春节' },
  { date: '2025-02-03', name: '春节' },
  { date: '2025-02-04', name: '春节' },
  { date: '2025-04-04', name: '清明节' },
  { date: '2025-05-01', name: '劳动节' },
  { date: '2025-05-02', name: '劳动节' },
  { date: '2025-05-05', name: '劳动节' },
  { date: '2025-06-02', name: '端午节' },
  { date: '2025-10-01', name: '国庆节' },
  { date: '2025-10-02', name: '国庆节' },
  { date: '2025-10-03', name: '国庆节' },
  { date: '2025-10-06', name: '中秋节' },
  { date: '2025-10-07', name: '国庆节' },
  { date: '2025-10-08', name: '国庆节' },
  { date: '2026-01-01', name: '元旦' },
  { date: '2026-01-02', name: '元旦' },
  { date: '2026-02-16', name: '春节' },
  { date: '2026-02-17', name: '春节' },
  { date: '2026-02-18', name: '春节' },
  { date: '2026-02-19', name: '春节' },
  { date: '2026-02-20', name: '春节' },
  { date: '2026-02-23', name: '春节' },
  { date: '2026-04-06', name: '清明节' },
  { date: '2026-05-01', name: '劳动节' },
  { date: '2026-05-04', name: '劳动节' },
  { date: '2026-05-05', name: '劳动节' },
  { date: '2026-06-19', name: '端午节' },
  { date: '2026-09-25', name: '中秋节' },
  { date: '2026-10-01', name: '国庆节' },
  { date: '2026-10-02', name: '国庆节' },
  { date: '2026-10-05', name: '国庆节' },
  { date: '2026-10-06', name: '国庆节' },
  { date: '2026-10-07', name: '国庆节' },
];

export interface HolidayOverride {
  date: string;
  name: string;
  action: 'add' | 'remove';
}

export interface HolidayConfig {
  holidays: HolidayEntry[];
  overrides: HolidayOverride[];
  coverageStart: string;
  coverageEnd: string;
}

/**
 * 组装节假日配置。
 *
 * coverageEnd 是一个显式设置：用户必须确认已核对某一年度的官方安排后才能延长，
 * 不能因为手工添加了某一天的节假日就自动把整个区间视为已覆盖。
 */
export function buildHolidayConfig(
  overrides: HolidayOverride[] = [],
  coverageEnd: string = HOLIDAY_COVERAGE_END,
): HolidayConfig {
  const map = new Map<string, string>();
  for (const entry of BUILTIN_HOLIDAYS) map.set(entry.date, entry.name);
  for (const override of overrides) {
    if (override.action === 'add') map.set(override.date, override.name || '自定义节假日');
    else map.delete(override.date);
  }
  return {
    holidays: [...map.entries()]
      .map(([date, name]) => ({ date, name }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    overrides,
    coverageStart: HOLIDAY_COVERAGE_START,
    coverageEnd,
  };
}

export interface ShanghaiTime {
  date: string;
  minutes: number;
  weekday: number; // 0 = 周日
}

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function toShanghaiTime(instant: Date): ShanghaiTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DEEPSEEK_TARIFF_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    date: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAY[get('weekday')] ?? 0,
  };
}

export interface TariffSelection {
  tier: 'peak' | 'offpeak' | 'unknown';
  covered: boolean;
  reason: string;
  shanghaiDate: string;
  shanghaiTime: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName: string | null;
}

export interface TariffOptions {
  /** 日历未覆盖时，是否允许按“工作日/周末”规则估算（用户显式开启）。 */
  allowUncoveredEstimate?: boolean;
}

export function selectDeepSeekTariff(
  instant: Date,
  config: HolidayConfig,
  options: TariffOptions = {},
): TariffSelection {
  const sh = toShanghaiTime(instant);
  const holidayMap = new Map(config.holidays.map((entry) => [entry.date, entry.name]));
  const isWeekend = sh.weekday === 0 || sh.weekday === 6;
  const holidayName = holidayMap.get(sh.date) ?? null;
  const isHoliday = holidayName !== null;
  const covered = sh.date >= config.coverageStart && sh.date <= config.coverageEnd;
  const hhmm = `${String(Math.floor(sh.minutes / 60)).padStart(2, '0')}:${String(sh.minutes % 60).padStart(2, '0')}`;
  const inPeakWindow =
    (sh.minutes >= 9 * 60 && sh.minutes < 12 * 60) ||
    (sh.minutes >= 14 * 60 && sh.minutes < 18 * 60);
  const peak = !isWeekend && !isHoliday && inPeakWindow;

  if (!covered) {
    if (!options.allowUncoveredEstimate) {
      return {
        tier: 'unknown',
        covered: false,
        reason: `请求时间 ${sh.date} ${hhmm}（北京时间）超出节假日日历覆盖范围（${config.coverageStart} 至 ${config.coverageEnd}），无法确定峰谷价格。请在设置中更新节假日日历或显式允许估算。`,
        shanghaiDate: sh.date,
        shanghaiTime: hhmm,
        isWeekend,
        isHoliday,
        holidayName,
      };
    }
    return {
      tier: peak ? 'peak' : 'offpeak',
      covered: false,
      reason: `节假日日历未覆盖 ${sh.date}，按“工作日/周末”规则估算为${peak ? '高峰' : '空闲'}时段（估算，未经节假日日历确认）。`,
      shanghaiDate: sh.date,
      shanghaiTime: hhmm,
      isWeekend,
      isHoliday,
      holidayName,
    };
  }

  return {
    tier: peak ? 'peak' : 'offpeak',
    covered: true,
    reason: peak
      ? `北京时间 ${sh.date} ${hhmm}，工作日高峰时段（09:00–12:00 / 14:00–18:00）`
      : isHoliday
        ? `北京时间 ${sh.date} ${hhmm}，法定节假日（${holidayName}）全天为空闲时段`
        : isWeekend
          ? `北京时间 ${sh.date} ${hhmm}，周末为空闲时段`
          : `北京时间 ${sh.date} ${hhmm}，非高峰时段为空闲时段`,
    shanghaiDate: sh.date,
    shanghaiTime: hhmm,
    isWeekend,
    isHoliday,
    holidayName,
  };
}

export function holidayCoverageWarning(
  config: HolidayConfig,
  now: Date,
): string | null {
  const sh = toShanghaiTime(now);
  if (sh.date > config.coverageEnd) {
    return `节假日日历仅覆盖至 ${config.coverageEnd}，之后发起 DeepSeek 请求时费用将标记为“未知”，除非在设置中更新日历或允许估算。`;
  }
  return null;
}
