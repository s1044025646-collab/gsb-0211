// SQLite 持久化（Node 内置 node:sqlite，无原生依赖）。
// 保存导入文件摘要、解析结果与查询快照；重复导入同一文件生成新记录，旧报告不变。

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseTzif, ParsedTzif } from "./tzif.js";
import { parsePosixTz, PosixTz } from "./posix.js";
import { TzRules } from "./resolve.js";

export interface ImportRow {
  id: number;
  sha256: string;
  filename: string;
  version: number;
  timecnt: number;
  typecnt: number;
  footer: string | null;
  imported_at: string;
}

export class TzDb {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "tzif.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL,
        filename TEXT NOT NULL,
        version INTEGER NOT NULL,
        timecnt INTEGER NOT NULL,
        typecnt INTEGER NOT NULL,
        footer TEXT,
        parsed_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        import_id INTEGER NOT NULL REFERENCES imports(id),
        kind TEXT NOT NULL,
        query TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  importFile(filePath: string): ImportRow {
    const buf = readFileSync(filePath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const parsed = parseTzif(buf);
    // 尾部语法在导入时即校验，不支持的语法立刻报错而不是忽略
    if (parsed.footer) parsePosixTz(parsed.footer);
    const stmt = this.db.prepare(
      `INSERT INTO imports (sha256, filename, version, timecnt, typecnt, footer, parsed_json, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      sha256, path.basename(filePath), parsed.version,
      parsed.transitions.length, parsed.types.length, parsed.footer,
      JSON.stringify(parsed), new Date().toISOString(),
    );
    return this.getImport(Number(info.lastInsertRowid))!;
  }

  getImport(id: number): ImportRow | null {
    const r = this.db.prepare(
      `SELECT id, sha256, filename, version, timecnt, typecnt, footer, imported_at FROM imports WHERE id = ?`,
    ).get(id) as ImportRow | undefined;
    return r ?? null;
  }

  listImports(): ImportRow[] {
    return this.db.prepare(
      `SELECT id, sha256, filename, version, timecnt, typecnt, footer, imported_at FROM imports ORDER BY id`,
    ).all() as unknown as ImportRow[];
  }

  rulesFor(id: number): TzRules {
    const r = this.db.prepare(`SELECT parsed_json FROM imports WHERE id = ?`).get(id) as
      | { parsed_json: string } | undefined;
    if (!r) throw new Error(`导入记录 ${id} 不存在`);
    const parsed = JSON.parse(r.parsed_json) as ParsedTzif;
    const posix: PosixTz | null = parsed.footer ? parsePosixTz(parsed.footer) : null;
    return new TzRules(parsed, posix);
  }

  snapshot(importId: number, kind: string, query: unknown, result: unknown): void {
    this.db.prepare(
      `INSERT INTO snapshots (import_id, kind, query, result, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(importId, kind, JSON.stringify(query), JSON.stringify(result), new Date().toISOString());
  }

  snapshots(importId: number) {
    return this.db.prepare(
      `SELECT id, kind, query, result, created_at FROM snapshots WHERE import_id = ? ORDER BY id`,
    ).all(importId);
  }
}
