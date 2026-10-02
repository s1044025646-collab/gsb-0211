// TZif v2/v3 二进制解析器（RFC 8536），自行实现，不依赖任何现成解析器。
// 限定 POSIX 秒时间轴：含闰秒记录（leapcnt > 0）的文件明确拒绝。

import { assertSafeTs } from "./civil.js";

export class TzifError extends Error {}

export interface TtType {
  gmtoff: number;   // 秒，UTC 以东为正
  isdst: boolean;
  abbrev: string;
}

export interface Transition {
  time: number;      // POSIX 秒（64 位有符号，已校验为安全整数）
  typeIndex: number;
}

export interface ParsedTzif {
  version: 2 | 3;
  types: TtType[];
  transitions: Transition[];
  footer: string | null; // POSIX TZ 字符串（无换行符）
}

interface Header {
  version: number;
  isutcnt: number;
  isstdcnt: number;
  leapcnt: number;
  timecnt: number;
  typecnt: number;
  charcnt: number;
}

const HEADER_LEN = 44;
// 防御性上限：单个计数绝不超过此值（远超任何真实时区文件），
// 且任何计数在用于切片前都会先与文件实际长度核对，不会按计数分配内存。
const MAX_COUNT = 1_000_000;

function readHeader(buf: Buffer, off: number): Header {
  if (buf.length < off + HEADER_LEN) throw new TzifError("文件截断：头部不足 44 字节");
  if (buf.toString("latin1", off, off + 4) !== "TZif") {
    throw new TzifError("魔数错误：不是 TZif 文件");
  }
  const v = buf.readUInt8(off + 4);
  if (v !== 0x32 && v !== 0x33) {
    throw new TzifError(`不支持的版本字节 0x${v.toString(16)}（仅支持 v2/v3）`);
  }
  const u32 = (i: number) => buf.readUInt32BE(off + 20 + i * 4);
  const h: Header = {
    version: v - 0x30,
    isutcnt: u32(0),
    isstdcnt: u32(1),
    leapcnt: u32(2),
    timecnt: u32(3),
    typecnt: u32(4),
    charcnt: u32(5),
  };
  for (const [name, c] of Object.entries({
    isutcnt: h.isutcnt, isstdcnt: h.isstdcnt, leapcnt: h.leapcnt,
    timecnt: h.timecnt, typecnt: h.typecnt, charcnt: h.charcnt,
  })) {
    if (c > MAX_COUNT) throw new TzifError(`计数 ${name}=${c} 超出安全上限 ${MAX_COUNT}，拒绝解析`);
  }
  if (h.leapcnt > 0) {
    throw new TzifError(`文件含 ${h.leapcnt} 条闰秒记录：本服务限定 POSIX 秒时间轴，明确拒绝`);
  }
  if (h.typecnt === 0) throw new TzifError("typecnt 为 0：文件没有任何本地时间类型");
  if (h.isstdcnt > h.typecnt || h.isutcnt > h.typecnt) {
    throw new TzifError("isstdcnt/isutcnt 超过 typecnt，文件不一致");
  }
  return h;
}

// 数据块长度（v1: 32 位时间；v2+: 64 位时间）
function blockLen(h: Header, wide: boolean): number {
  const tsize = wide ? 9 : 5; // 每条转换：时间（8/4 字节）+ 1 字节类型索引
  const lsize = wide ? 12 : 8;
  return h.timecnt * tsize + h.typecnt * 6 + h.charcnt +
    h.leapcnt * lsize + h.isstdcnt + h.isutcnt;
}

export function parseTzif(buf: Buffer): ParsedTzif {
  const h1 = readHeader(buf, 0);
  // 跳过 v1 数据块，定位第二头部
  const off2 = HEADER_LEN + blockLen(h1, false);
  if (buf.length < off2 + HEADER_LEN) {
    throw new TzifError("文件截断：缺少 v2/v3 第二数据块头部");
  }
  const h2 = readHeader(buf, off2);
  const dataOff = off2 + HEADER_LEN;
  const need = blockLen(h2, true);
  if (buf.length < dataOff + need) {
    throw new TzifError(`文件截断：第二数据块需要 ${need} 字节，实际仅 ${buf.length - dataOff} 字节`);
  }

  // 转换时刻（有符号 64 位大端），必须严格递增
  const transitions: Transition[] = [];
  let p = dataOff;
  let prev: number | null = null;
  for (let i = 0; i < h2.timecnt; i++) {
    const t = Number(buf.readBigInt64BE(p)); p += 8;
    assertSafeTs(t, `第 ${i} 条转换时刻`);
    if (prev !== null && t <= prev) {
      throw new TzifError(`转换时刻未严格递增：第 ${i} 条 ${t} <= 前一条 ${prev}`);
    }
    prev = t;
    transitions.push({ time: t, typeIndex: -1 });
  }
  for (let i = 0; i < h2.timecnt; i++) {
    const idx = buf.readUInt8(p); p += 1;
    if (idx >= h2.typecnt) {
      throw new TzifError(`第 ${i} 条转换的类型索引 ${idx} 越界（typecnt=${h2.typecnt}）`);
    }
    transitions[i].typeIndex = idx;
  }

  // 本地时间类型
  const rawTypes: { gmtoff: number; isdst: boolean; abbrOff: number }[] = [];
  for (let i = 0; i < h2.typecnt; i++) {
    const gmtoff = buf.readInt32BE(p);
    const isdst = buf.readUInt8(p + 4);
    const abbrOff = buf.readUInt8(p + 5);
    p += 6;
    if (isdst > 1) throw new TzifError(`类型 ${i} 的 isdst 标志非法：${isdst}`);
    if (abbrOff >= h2.charcnt) {
      throw new TzifError(`类型 ${i} 的缩写偏移 ${abbrOff} 越界（charcnt=${h2.charcnt}）`);
    }
    rawTypes.push({ gmtoff, isdst: isdst === 1, abbrOff });
  }

  // 缩写字符串池
  const chars = buf.toString("latin1", p, p + h2.charcnt);
  p += h2.charcnt;
  const types: TtType[] = rawTypes.map((t, i) => {
    const end = chars.indexOf("\0", t.abbrOff);
    if (end === -1) throw new TzifError(`类型 ${i} 的缩写未在字符池内以 NUL 结尾`);
    return { gmtoff: t.gmtoff, isdst: t.isdst, abbrev: chars.slice(t.abbrOff, end) };
  });

  // 跳过 isstd/isgmt 指示符（已校验计数一致）
  p += h2.isstdcnt + h2.isutcnt;

  // POSIX 尾部：\nTZ\n
  let footer: string | null = null;
  if (p < buf.length) {
    if (buf.readUInt8(p) !== 0x0a) throw new TzifError("数据块后存在无法识别的附加字节");
    const nl = buf.indexOf(0x0a, p + 1);
    if (nl === -1) throw new TzifError("POSIX 尾部缺少结束换行");
    footer = buf.toString("latin1", p + 1, nl);
    if (footer.length === 0) footer = null;
  }

  return { version: h2.version as 2 | 3, types, transitions, footer };
}
