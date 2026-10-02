// POSIX TZ 尾部规则解析与求值。
// 支持：固定偏移（如 <-03>3、UTC0）、std+dst 带 M月.周.星期 转换规则
// （如 EST5EDT,M3.2.0/2,M11.1.0/2）。Jn /  Julian 日等其他语法明确拒绝。
// 注意 POSIX 偏移符号与常识相反：EST5 表示 UTC 以西 5 小时（东为正存储时取负）。

import { daysFromCivil, nthWeekdayOfMonth, splitUtc } from "./civil.js";

export class PosixError extends Error {}

export interface MRule {
  month: number;   // 1-12
  week: number;    // 1-5，5=最后一个
  weekday: number; // 0=周日
  timeSec: number; // 当天转换时刻（秒，默认 7200）
}

export interface PosixTz {
  stdName: string;
  stdOffset: number; // 秒，东为正（已从 POSIX 符号取反）
  dstName: string | null;
  dstOffset: number | null;
  start: MRule | null; // 进入 DST 的规则（按 std 墙上时间解释）
  end: MRule | null;   // 离开 DST 的规则（按 dst 墙上时间解释）
}

function parseName(s: string, i: number): [string, number] {
  if (s[i] === "<") {
    const j = s.indexOf(">", i);
    if (j === -1) throw new PosixError("POSIX 尾部：尖括号名称未闭合");
    return [s.slice(i + 1, j), j + 1];
  }
  const m = /^[A-Za-z]{3,}/.exec(s.slice(i));
  if (!m) throw new PosixError(`POSIX 尾部：无效的名称（位置 ${i}）`);
  return [m[0], i + m[0].length];
}

// 解析 [+-]hh[:mm[:ss]]，返回 POSIX 语义值（西为正），调用方负责取反
function parseOffset(s: string, i: number): [number, number] {
  const m = /^[+-]?\d{1,3}(:\d{1,2}(:\d{1,2})?)?/.exec(s.slice(i));
  if (!m) throw new PosixError(`POSIX 尾部：无效的偏移（位置 ${i}）`);
  const parts = m[0].split(":");
  const sign = parts[0].startsWith("-") ? -1 : 1;
  const h = parseInt(parts[0].replace(/^[+-]/, ""), 10);
  const mm = parts[1] ? parseInt(parts[1], 10) : 0;
  const ss = parts[2] ? parseInt(parts[2], 10) : 0;
  if (mm > 59 || ss > 59 || h > 167) throw new PosixError("POSIX 尾部：偏移分量越界");
  return [sign * (h * 3600 + mm * 60 + ss), i + m[0].length];
}

function parseRule(s: string, i: number): [MRule, number] {
  if (s[i] === "J" || /^\d/.test(s[i])) {
    throw new PosixError("POSIX 尾部：仅支持 M月.周.星期 规则，Jn/n 语法明确拒绝");
  }
  const m = /^M(\d{1,2})\.(\d)\.(\d)/.exec(s.slice(i));
  if (!m) throw new PosixError(`POSIX 尾部：无效的转换规则（位置 ${i}）`);
  const month = parseInt(m[1], 10), week = parseInt(m[2], 10), weekday = parseInt(m[3], 10);
  if (month < 1 || month > 12 || week < 1 || week > 5 || weekday > 6) {
    throw new PosixError("POSIX 尾部：M 规则分量越界");
  }
  let j = i + m[0].length;
  let timeSec = 7200; // 默认 02:00
  if (s[j] === "/") {
    const [t, k] = parseOffset(s, j + 1);
    timeSec = t; // 转换时刻的符号与 POSIX 一致（此处为本地时钟读数，直接用带符号值）
    j = k;
  }
  return [{ month, week, weekday, timeSec }, j];
}

export function parsePosixTz(tz: string): PosixTz {
  let i = 0;
  const [stdName, a] = parseName(tz, i); i = a;
  const [stdOffPosix, b] = parseOffset(tz, i); i = b;
  const stdOffset = -stdOffPosix; // POSIX 西为正 -> 东为正
  if (i >= tz.length) {
    return { stdName, stdOffset, dstName: null, dstOffset: null, start: null, end: null };
  }
  const [dstName, c] = parseName(tz, i); i = c;
  let dstOffset = stdOffset + 3600; // 默认比标准时快 1 小时
  const offMatch = /^[+-]?\d/.exec(tz.slice(i));
  if (offMatch && tz[i] !== ",") {
    const [d, e] = parseOffset(tz, i);
    dstOffset = -d; i = e;
  }
  let start: MRule | null = null, end: MRule | null = null;
  if (i < tz.length) {
    if (tz[i] !== ",") throw new PosixError(`POSIX 尾部：位置 ${i} 应为逗号`);
    const [s1, f] = parseRule(tz, i + 1); i = f;
    if (tz[i] !== ",") throw new PosixError("POSIX 尾部：缺少结束规则");
    const [s2, g] = parseRule(tz, i + 1); i = g;
    start = s1; end = s2;
  } else {
    throw new PosixError("POSIX 尾部：声明了 DST 名称但缺少转换规则，拒绝隐式假设");
  }
  if (i !== tz.length) throw new PosixError(`POSIX 尾部：位置 ${i} 后存在多余内容`);
  return { stdName, stdOffset, dstName, dstOffset, start, end };
}

// 计算某公历年进入/离开 DST 的 UTC 时刻（秒）
function ruleInstantUtc(year: number, r: MRule, offsetBefore: number): number {
  const day = nthWeekdayOfMonth(year, r.month, r.week, r.weekday);
  return day * 86400 + r.timeSec - offsetBefore;
}

export interface PosixEvent { utc: number; toDst: boolean }

// 生成覆盖指定 UTC 时刻所需的转换事件（前后各扩一年，兼容南半球跨年 DST）
export function posixEventsAround(tz: PosixTz, utcSec: number): PosixEvent[] {
  if (!tz.start || !tz.end || tz.dstOffset === null) return [];
  const approxYear = splitUtc(utcSec).y;
  const events: PosixEvent[] = [];
  for (let y = approxYear - 2; y <= approxYear + 2; y++) {
    events.push({ utc: ruleInstantUtc(y, tz.start, tz.stdOffset), toDst: true });
    events.push({ utc: ruleInstantUtc(y, tz.end, tz.dstOffset), toDst: false });
  }
  events.sort((a, b) => a.utc - b.utc);
  return events;
}

// 求 utcSec 时刻按 POSIX 规则应采用的偏移
export function posixOffsetAt(tz: PosixTz, utcSec: number): { offset: number; isdst: boolean; abbrev: string } {
  if (tz.dstOffset === null || !tz.start || !tz.end) {
    return { offset: tz.stdOffset, isdst: false, abbrev: tz.stdName };
  }
  const events = posixEventsAround(tz, utcSec);
  let dst = false;
  // 找最后一个 <= utcSec 的事件；若全部在未来，则取“上一周期”状态：
  // 事件序列按年交替，南半球时年初处于 DST，由排序后首事件类型自然决定。
  let seen = false;
  for (const e of events) {
    if (e.utc <= utcSec) { dst = e.toDst; seen = true; } else break;
  }
  if (!seen) {
    // utcSec 在窗口首个事件之前：首个事件若是“进入 DST”，说明当前处于标准时，
    // 否则（首个事件是离开 DST）说明跨年 DST 仍在生效。
    dst = !events[0].toDst;
  }
  return dst
    ? { offset: tz.dstOffset, isdst: true, abbrev: tz.dstName! }
    : { offset: tz.stdOffset, isdst: false, abbrev: tz.stdName };
}
