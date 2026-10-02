// 合成 TZif v2 文件生成器：用于测试与演示，输出完全符合 RFC 8536 的双数据块结构。

export interface GenType { gmtoff: number; isdst: boolean; abbrev: string }
export interface GenTransition { time: number | bigint; abbrev: string }

export function buildTzifV2(opts: {
  version?: 2 | 3;
  types: GenType[];
  transitions: GenTransition[];
  footer?: string | null;
}): Buffer {
  const version = opts.version ?? 2;
  // 缩写字符串池去重
  const pool: string[] = [];
  const abbrOff = new Map<string, number>();
  let poolLen = 0;
  for (const t of opts.types) {
    if (!abbrOff.has(t.abbrev)) {
      abbrOff.set(t.abbrev, poolLen);
      pool.push(t.abbrev);
      poolLen += t.abbrev.length + 1;
    }
  }
  const charcnt = poolLen;
  const typecnt = opts.types.length;
  const timecnt = opts.transitions.length;
  const typeIndexOf = (abbr: string) =>
    opts.types.findIndex((t) => t.abbrev === abbr);

  const header = (tc: number) => {
    const h = Buffer.alloc(44);
    h.write("TZif", 0, "latin1");
    h.writeUInt8(0x30 + version, 4);
    h.writeUInt32BE(0, 20); // isutcnt
    h.writeUInt32BE(0, 24); // isstdcnt
    h.writeUInt32BE(0, 28); // leapcnt = 0（POSIX 秒）
    h.writeUInt32BE(tc, 32);
    h.writeUInt32BE(typecnt, 36);
    h.writeUInt32BE(charcnt, 40);
    return h;
  };

  const typeBlock = () => {
    const b = Buffer.alloc(typecnt * 6);
    opts.types.forEach((t, i) => {
      b.writeInt32BE(t.gmtoff, i * 6);
      b.writeUInt8(t.isdst ? 1 : 0, i * 6 + 4);
      b.writeUInt8(abbrOff.get(t.abbrev)!, i * 6 + 5);
    });
    return b;
  };
  const poolBuf = Buffer.from(pool.map((s) => s + "\0").join(""), "latin1");

  // v1 块：仅容纳 32 位范围内的转换；超范围的在 v1 中省略（真实 tz 文件亦如此裁剪）
  const v1Trans = opts.transitions.filter(
    (t) => BigInt(t.time) >= -2147483648n && BigInt(t.time) <= 2147483647n,
  );
  const v1 = Buffer.concat([
    header(v1Trans.length),
    Buffer.concat(
      v1Trans.map((t) => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(Number(t.time), 0);
        return b;
      }),
    ),
    Buffer.from(v1Trans.map((t) => typeIndexOf(t.abbrev))),
    typeBlock(),
    poolBuf,
  ]);

  const v2 = Buffer.concat([
    header(timecnt),
    Buffer.concat(
      opts.transitions.map((t) => {
        const b = Buffer.alloc(8);
        b.writeBigInt64BE(BigInt(t.time), 0);
        return b;
      }),
    ),
    Buffer.from(opts.transitions.map((t) => typeIndexOf(t.abbrev))),
    typeBlock(),
    poolBuf,
  ]);

  const footer = opts.footer ? Buffer.from(`\n${opts.footer}\n`, "latin1") : Buffer.alloc(0);
  return Buffer.concat([v1, v2, footer]);
}
