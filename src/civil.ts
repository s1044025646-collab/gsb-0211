// 公历日期 <-> 天数换算（Howard Hinnant 算法），纯整数运算，不依赖 Date/Intl。
// 支持范围：|秒| <= 2^53 - 1（约 ±2.85 亿年），超出范围明确报错，不截断、不丢精度。

export const MAX_SAFE_TS = Number.MAX_SAFE_INTEGER;
export const MIN_SAFE_TS = -Number.MAX_SAFE_INTEGER;

export function assertSafeTs(ts: number, what: string): void {
  if (!Number.isSafeInteger(ts)) {
    throw new RangeError(`${what} 超出支持范围（须为安全整数秒，|t| <= 2^53-1）: ${ts}`);
  }
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// 自 1970-01-01 起的天数（可负）
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

export function daysInMonth(y: number, m: number): number {
  const t = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return t[m - 1];
}

// 某年某月第 n 个星期 w（n=5 表示最后一个），w: 0=周日
export function nthWeekdayOfMonth(y: number, m: number, n: number, w: number): number {
  const first = daysFromCivil(y, m, 1);
  const firstW = (((first + 4) % 7) + 7) % 7; // 1970-01-01 是周四(4)
  let day = 1 + ((w - firstW + 7) % 7) + (n - 1) * 7;
  if (day > daysInMonth(y, m)) day -= 7;
  return daysFromCivil(y, m, day);
}

export function splitUtc(ts: number): { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number } {
  const days = Math.floor(ts / 86400);
  let rem = ts - days * 86400;
  const { y, m, d } = civilFromDays(days);
  const hh = Math.floor(rem / 3600); rem -= hh * 3600;
  const mm = Math.floor(rem / 60); rem -= mm * 60;
  const weekday = (((days + 4) % 7) + 7) % 7;
  return { y, m, d, hh, mm, ss: rem, weekday };
}
