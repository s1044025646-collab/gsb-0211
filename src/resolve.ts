// 基于解析结果的查询层：UTC->本地、本地墙上时间->UTC 候选集、转换点查询。

import { ParsedTzif, TtType } from "./tzif.js";
import { PosixTz, posixOffsetAt } from "./posix.js";
import { assertSafeTs, splitUtc } from "./civil.js";

export type RuleSource = "explicit" | "posix" | "initial" | "explicit-last";

export interface LocalTime {
  utc: number;
  offset: number;      // 秒，东为正
  isdst: boolean;
  abbrev: string;
  source: RuleSource;
  local: string;       // ISO 风格本地时间
}

export type WallStatus = "unique" | "ambiguous" | "nonexistent";

export interface WallCandidate {
  utc: number;
  offset: number;
  isdst: boolean;
  abbrev: string;
  source: RuleSource;
}

export interface WallResult {
  status: WallStatus;
  candidates: WallCandidate[];
  // policy 解析结果（status=unique 时即唯一候选）
  resolved?: WallCandidate;
}

export class TzRules {
  constructor(
    public readonly parsed: ParsedTzif,
    public readonly posix: PosixTz | null,
  ) {}

  get coverageEnd(): number | null {
    const t = this.parsed.transitions;
    return t.length ? t[t.length - 1].time : null;
  }

  // TZif 规定的初始类型：首个非 DST 类型，否则类型 0
  private initialType(): TtType {
    const t = this.parsed.types.find((x) => !x.isdst);
    return t ?? this.parsed.types[0];
  }

  private typeAt(utc: number): { ty: TtType; source: RuleSource } {
    const tr = this.parsed.transitions;
    if (tr.length === 0) {
      if (this.posix) {
        const r = posixOffsetAt(this.posix, utc);
        return { ty: { gmtoff: r.offset, isdst: r.isdst, abbrev: r.abbrev }, source: "posix" };
      }
      return { ty: this.initialType(), source: "initial" };
    }
    if (utc < tr[0].time) return { ty: this.initialType(), source: "initial" };
    if (utc > tr[tr.length - 1].time) {
      if (this.posix) {
        const r = posixOffsetAt(this.posix, utc);
        return { ty: { gmtoff: r.offset, isdst: r.isdst, abbrev: r.abbrev }, source: "posix" };
      }
      // 无有效尾部：超出显式规则覆盖区间，沿用最后一个类型并明确标注
      return { ty: this.parsed.types[tr[tr.length - 1].typeIndex], source: "explicit-last" };
    }
    // 二分查找：最后一个 time <= utc 的转换（转换时刻本身使用新规则）
    let lo = 0, hi = tr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tr[mid].time <= utc) lo = mid; else hi = mid - 1;
    }
    return { ty: this.parsed.types[tr[lo].typeIndex], source: "explicit" };
  }

  utcToLocal(utc: number): LocalTime {
    assertSafeTs(utc, "UTC 时间戳");
    const { ty, source } = this.typeAt(utc);
    const localSec = utc + ty.gmtoff;
    assertSafeTs(localSec, "本地时间");
    const c = splitUtc(localSec);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return {
      utc, offset: ty.gmtoff, isdst: ty.isdst, abbrev: ty.abbrev, source,
      local: `${c.y}-${pad(c.m)}-${pad(c.d)}T${pad(c.hh)}:${pad(c.mm)}:${pad(c.ss)}`,
    };
  }

  // 本地墙上秒（按 UTC 时间轴计数的 naive 秒）反查 UTC 候选集
  localToUtc(localSec: number): WallResult {
    assertSafeTs(localSec, "本地墙上时间");
    const offsets = new Set<number>();
    for (const t of this.parsed.types) offsets.add(t.gmtoff);
    if (this.posix) {
      offsets.add(this.posix.stdOffset);
      if (this.posix.dstOffset !== null) offsets.add(this.posix.dstOffset);
    }
    const candidates: WallCandidate[] = [];
    for (const off of offsets) {
      const utc = localSec - off;
      const r = this.typeAt(utc);
      if (r.ty.gmtoff === off) {
        candidates.push({ utc, offset: off, isdst: r.ty.isdst, abbrev: r.ty.abbrev, source: r.source });
      }
    }
    candidates.sort((a, b) => a.utc - b.utc);
    const status: WallStatus =
      candidates.length === 0 ? "nonexistent" : candidates.length === 1 ? "unique" : "ambiguous";
    return { status, candidates };
  }

  resolveWall(localSec: number, policy: "earlier" | "later" | "reject" = "reject"): WallResult {
    const r = this.localToUtc(localSec);
    if (r.status === "unique") r.resolved = r.candidates[0];
    else if (r.status === "ambiguous" && policy === "earlier") r.resolved = r.candidates[0];
    else if (r.status === "ambiguous" && policy === "later") r.resolved = r.candidates[r.candidates.length - 1];
    return r;
  }

  transitionsBetween(from: number, to: number) {
    assertSafeTs(from, "起始"); assertSafeTs(to, "结束");
    return this.parsed.transitions
      .filter((t) => t.time >= from && t.time <= to)
      .map((t) => {
        const ty = this.parsed.types[t.typeIndex];
        return { time: t.time, offset: ty.gmtoff, isdst: ty.isdst, abbrev: ty.abbrev };
      });
  }
}
