// 测试：所有期望值均为独立手算的转换表/时间戳，不用解析器结果验证解析器。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTzif, TzifError } from "../src/tzif.js";
import { parsePosixTz } from "../src/posix.js";
import { TzRules } from "../src/resolve.js";
import { buildTzifV2 } from "../src/tzifgen.js";
import { TzDb } from "../src/db.js";
import { daysFromCivil } from "../src/civil.js";

// ---- 手算常量 ----
// 1950-01-01T00:00:00Z / 1960-01-01T00:00:00Z / 2100-01-01T00:00:00Z
const T1 = -631152000, T2 = -315619200, T3 = 4102444800;
const OFF_A = 19800;  // +05:30
const OFF_B = 23400;  // +06:30

// 合成时区 A：半小时偏移、跨 1970 前与 2038 后、无 POSIX 尾部
function zoneA(): Buffer {
  return buildTzifV2({
    types: [
      { gmtoff: OFF_A, isdst: false, abbrev: "AAA" },
      { gmtoff: OFF_B, isdst: true, abbrev: "BBB" },
    ],
    transitions: [
      { time: T1, abbrev: "BBB" },
      { time: T2, abbrev: "AAA" },
      { time: T3, abbrev: "BBB" },
    ],
    footer: null,
  });
}

function rulesOf(buf: Buffer): TzRules {
  const p = parseTzif(buf);
  return new TzRules(p, p.footer ? parsePosixTz(p.footer) : null);
}

test("解析：双数据块、64 位时间、类型与缩写", () => {
  const p = parseTzif(zoneA());
  assert.equal(p.version, 2);
  assert.equal(p.transitions.length, 3);
  assert.equal(p.transitions[2].time, T3); // 超出 32 位，来自第二块
  assert.deepEqual(p.types.map((t) => t.abbrev), ["AAA", "BBB"]);
  assert.equal(p.types[0].gmtoff, OFF_A);
});

test("v3 版本可解析", () => {
  const buf = buildTzifV2({
    version: 3,
    types: [{ gmtoff: 0, isdst: false, abbrev: "UTC" }],
    transitions: [],
    footer: "UTC0",
  });
  assert.equal(parseTzif(buf).version, 3);
});

test("UTC->本地：1970 前、2038 后、转换前后一秒、转换时刻用新规则", () => {
  const r = rulesOf(zoneA());
  // 首次转换之前：初始类型（首个非 DST = AAA）
  let x = r.utcToLocal(T1 - 1);
  assert.equal(x.offset, OFF_A);
  assert.equal(x.source, "initial");
  assert.equal(x.local, "1950-01-01T05:29:59"); // 手算：T1-1+19800
  // 转换时刻本身使用新规则
  x = r.utcToLocal(T1);
  assert.equal(x.offset, OFF_B);
  assert.equal(x.isdst, true);
  assert.equal(x.source, "explicit");
  assert.equal(x.local, "1950-01-01T06:30:00");
  // 2038 后（64 位）
  x = r.utcToLocal(T3 - 1);
  assert.equal(x.offset, OFF_A);
  assert.equal(x.local, "2100-01-01T05:29:59");
  x = r.utcToLocal(T3);
  assert.equal(x.offset, OFF_B);
  assert.equal(x.local, "2100-01-01T06:30:00");
  // 无尾部：超出覆盖区间明确标注 explicit-last
  x = r.utcToLocal(T3 + 100);
  assert.equal(x.source, "explicit-last");
});

test("空转换表 + 负时间戳", () => {
  const buf = buildTzifV2({
    types: [{ gmtoff: -3600, isdst: false, abbrev: "NEG" }],
    transitions: [],
    footer: null,
  });
  const r = rulesOf(buf);
  const x = r.utcToLocal(-2208988800); // 1900-01-01T00:00:00Z
  assert.equal(x.offset, -3600);
  assert.equal(x.local, "1899-12-31T23:00:00");
  assert.equal(x.source, "initial");
});

test("墙上时间反查：回拨重叠产生两个候选（手算 UTC）", () => {
  const r = rulesOf(zoneA());
  // T2 处 23400 -> 19800（回拨 1 小时），重叠本地区间 [T2+19800, T2+23400)
  const local = T2 + 19800 + 1800; // 重叠开始后 30 分钟
  const res = r.localToUtc(local);
  assert.equal(res.status, "ambiguous");
  assert.equal(res.candidates.length, 2);
  assert.equal(res.candidates[0].utc, T2 - 1800); // 较早 UTC，仍处夏令时
  assert.equal(res.candidates[0].offset, OFF_B);
  assert.equal(res.candidates[1].utc, T2 + 1800); // 较晚 UTC，标准时
  assert.equal(res.candidates[1].offset, OFF_A);
  // 往返核对：两个候选各自转回应得同一墙上时间
  for (const c of res.candidates) {
    assert.equal(r.utcToLocal(c.utc).utc + r.utcToLocal(c.utc).offset, local);
  }
  // policy
  assert.equal(r.resolveWall(local, "earlier").resolved!.utc, T2 - 1800);
  assert.equal(r.resolveWall(local, "later").resolved!.utc, T2 + 1800);
  assert.equal(r.resolveWall(local, "reject").resolved, undefined);
});

test("墙上时间反查：跳时空档拒绝，不悄悄套用偏移", () => {
  const r = rulesOf(zoneA());
  // T1 处 19800 -> 23400（跳前 1 小时），空档 [T1+19800, T1+23400)
  const local = T1 + 19800 + 1800;
  const res = r.localToUtc(local);
  assert.equal(res.status, "nonexistent");
  assert.equal(res.candidates.length, 0);
});

test("墙上时间反查：唯一候选", () => {
  const r = rulesOf(zoneA());
  const local = T2 + 19800 + 86400 * 30; // 远离任何转换
  const res = r.localToUtc(local);
  assert.equal(res.status, "unique");
  assert.equal(res.candidates[0].offset, OFF_A);
});

// ---- POSIX 尾部 ----

test("POSIX：固定偏移与符号（西为正）", () => {
  const p = parsePosixTz("<+0530>-5:30");
  assert.equal(p.stdOffset, 19800); // 东为正存储
  assert.equal(p.dstName, null);
  const q = parsePosixTz("EST5");
  assert.equal(q.stdOffset, -18000);
});

test("POSIX：不支持的语法明确拒绝", () => {
  assert.throws(() => parsePosixTz("EST5EDT,J60,J300"), /拒绝/);
  assert.throws(() => parsePosixTz("EST5EDT,80,300"), /拒绝/);
});

// 类美东时区：2021 显式转换 + POSIX 尾部推算 2022+
const US_EDT_ON = 1615705200;  // 2021-03-14T07:00:00Z
const US_EST_ON = 1636264800;  // 2021-11-07T06:00:00Z
function zoneUS(): Buffer {
  return buildTzifV2({
    types: [
      { gmtoff: -18000, isdst: false, abbrev: "EST" },
      { gmtoff: -14400, isdst: true, abbrev: "EDT" },
    ],
    transitions: [
      { time: US_EDT_ON, abbrev: "EDT" },
      { time: US_EST_ON, abbrev: "EST" },
    ],
    footer: "EST5EDT,M3.2.0/2,M11.1.0/2",
  });
}

test("POSIX M 规则：2022 年转换点手算核对（默认 02:00）", () => {
  const r = rulesOf(zoneUS());
  // 手算：2022-03-13 02:00 EST = 2022-03-13T07:00:00Z = 1647154800
  assert.equal(r.utcToLocal(1647154799).offset, -18000);
  assert.equal(r.utcToLocal(1647154799).source, "posix");
  assert.equal(r.utcToLocal(1647154800).offset, -14400);
  assert.equal(r.utcToLocal(1647154800).abbrev, "EDT");
  // 手算：2022-11-06 02:00 EDT = 2022-11-06T06:00:00Z = 1667714400
  assert.equal(r.utcToLocal(1667714399).offset, -14400);
  assert.equal(r.utcToLocal(1667714400).offset, -18000);
});

test("POSIX 推算区间的重叠与空档", () => {
  const r = rulesOf(zoneUS());
  // 2022-11-06T01:30:00 本地（回拨重叠）
  const local = daysFromCivil(2022, 11, 6) * 86400 + 5400;
  const res = r.localToUtc(local);
  assert.equal(res.status, "ambiguous");
  assert.deepEqual(res.candidates.map((c) => c.offset), [-14400, -18000]);
  // 2022-03-13T02:30:00 本地（跳时空档）
  const gap = daysFromCivil(2022, 3, 13) * 86400 + 9000;
  assert.equal(r.localToUtc(gap).status, "nonexistent");
});

test("南半球跨年 DST（类澳大利亚）", () => {
  const buf = buildTzifV2({
    types: [
      { gmtoff: 36000, isdst: false, abbrev: "AEST" },
      { gmtoff: 39600, isdst: true, abbrev: "AEDT" },
    ],
    transitions: [
      { time: 1633190400, abbrev: "AEDT" }, // 2021-10-02T16:00:00Z
      { time: 1648915200, abbrev: "AEST" }, // 2022-04-02T16:00:00Z
    ],
    footer: "AEST-10AEDT,M10.1.0/2,M4.1.0/3",
  });
  const r = rulesOf(buf);
  // 手算：2023-01-15 处于跨年 DST 中段
  const jan = daysFromCivil(2023, 1, 15) * 86400;
  assert.equal(r.utcToLocal(jan).offset, 39600);
  assert.equal(r.utcToLocal(jan).isdst, true);
  // 2023-07-15 为标准时
  const jul = daysFromCivil(2023, 7, 15) * 86400;
  assert.equal(r.utcToLocal(jul).offset, 36000);
  // 手算转换点：2022-10-02 02:00 AEST = 2022-10-01T16:00:00Z = 1664640000
  assert.equal(r.utcToLocal(1664639999).offset, 36000);
  assert.equal(r.utcToLocal(1664640000).offset, 39600);
});

// ---- 畸形输入 ----

test("畸形：魔数、版本、闰秒、巨大计数、截断", () => {
  const good = zoneA();
  assert.throws(() => parseTzif(Buffer.from("NOPE" as unknown as string)), TzifError);

  const badMagic = Buffer.from(good); badMagic.write("XXXX", 0, "latin1");
  assert.throws(() => parseTzif(badMagic), /魔数/);

  const v1 = Buffer.from(good); v1.writeUInt8(0x31, 4);
  assert.throws(() => parseTzif(v1), /版本/);

  const leap = Buffer.from(good); leap.writeUInt32BE(1, 28); // leapcnt=1
  assert.throws(() => parseTzif(leap), /闰秒/);

  const huge = Buffer.from(good); huge.writeUInt32BE(0xffffffff, 32); // timecnt 巨大
  assert.throws(() => parseTzif(huge), /上限/);

  assert.throws(() => parseTzif(good.subarray(0, 100)), /截断/);
  assert.throws(() => parseTzif(good.subarray(0, 30)), /截断/);
});

test("畸形：转换时刻非严格递增", () => {
  const buf = buildTzifV2({
    types: [{ gmtoff: 0, isdst: false, abbrev: "UTC" }],
    transitions: [
      { time: 100, abbrev: "UTC" },
      { time: 100, abbrev: "UTC" },
    ],
    footer: null,
  });
  assert.throws(() => parseTzif(buf), /严格递增/);
});

test("畸形：类型索引与缩写边界", () => {
  const buf = Buffer.from(zoneA());
  // zoneA 结构：v1 块 = 2*5 + 2*6 + 8 = 30；第二头 @74；数据 @118
  // v2: 时间 3*8 @118..142，索引 3B @142..145，类型 12B @145..157
  const badIdx = Buffer.from(buf); badIdx.writeUInt8(7, 142);
  assert.throws(() => parseTzif(badIdx), /类型索引/);

  const badAbbr = Buffer.from(buf); badAbbr.writeUInt8(99, 145 + 5);
  assert.throws(() => parseTzif(badAbbr), /缩写/);
});

test("畸形：超出安全整数范围的 64 位转换时刻", () => {
  const buf = buildTzifV2({
    types: [{ gmtoff: 0, isdst: false, abbrev: "UTC" }],
    transitions: [{ time: 2n ** 60n, abbrev: "UTC" }],
    footer: null,
  });
  assert.throws(() => parseTzif(buf), /超出支持范围/);
});

// ---- SQLite 持久化 ----

test("SQLite：导入、重启后读取原规则、快照、文件更新不改旧报告", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tzif-"));
  const f = path.join(dir, "a.tzif");
  writeFileSync(f, zoneUS());

  const db = new TzDb(dir);
  const imp1 = db.importFile(f);
  const r1 = db.rulesFor(imp1.id).utcToLocal(US_EDT_ON);
  db.snapshot(imp1.id, "utcToLocal", { ts: US_EDT_ON }, r1);

  // 模拟重启：新连接读取同一数据目录
  const db2 = new TzDb(dir);
  const again = db2.rulesFor(imp1.id).utcToLocal(US_EDT_ON);
  assert.deepEqual(again, r1);
  assert.equal(db2.snapshots(imp1.id).length, 1);

  // 文件更新后重新导入：旧记录与旧快照不变
  writeFileSync(f, zoneA());
  const imp2 = db2.importFile(f);
  assert.notEqual(imp1.id, imp2.id);
  assert.notEqual(imp1.sha256, imp2.sha256);
  assert.deepEqual(db2.rulesFor(imp1.id).utcToLocal(US_EDT_ON), r1);
  db2.close();
});
