// 两个导入版本的规则对比

import { TzDb } from "./db.js";
import { ParsedTzif } from "./tzif.js";

export function diffImports(db: TzDb, aId: number, bId: number) {
  const a = db.rulesFor(aId).parsed;
  const b = db.rulesFor(bId).parsed;
  const metaA = db.getImport(aId)!;
  const metaB = db.getImport(bId)!;

  const key = (p: ParsedTzif) =>
    p.transitions.map((t) => {
      const ty = p.types[t.typeIndex];
      return `${t.time}|${ty.gmtoff}|${ty.isdst ? 1 : 0}|${ty.abbrev}`;
    });
  const setA = new Set(key(a));
  const setB = new Set(key(b));

  return {
    a: { id: aId, sha256: metaA.sha256, version: a.version, transitions: a.transitions.length },
    b: { id: bId, sha256: metaB.sha256, version: b.version, transitions: b.transitions.length },
    sameFile: metaA.sha256 === metaB.sha256,
    footerChanged: a.footer !== b.footer,
    footerA: a.footer,
    footerB: b.footer,
    addedTransitions: [...setB].filter((x) => !setA.has(x)),
    removedTransitions: [...setA].filter((x) => !setB.has(x)),
  };
}
