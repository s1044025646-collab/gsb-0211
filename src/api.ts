// HTTP API（node:http，无外部依赖）。端口通过 --port 或环境变量 PORT 配置。

import http from "node:http";
import { TzDb } from "./db.js";
import { diffImports } from "./diff.js";
import { daysFromCivil } from "./civil.js";

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

// 支持 ?ts=unix秒 或 ?ts=YYYY-MM-DDTHH:mm:ss（本地墙上时间查询用）
function parseTs(raw: string | null): number {
  if (raw === null) throw new Error("缺少 ts 参数");
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!m) throw new Error(`无法解析时间: ${raw}`);
  return daysFromCivil(+m[1], +m[2], +m[3]) * 86400 + (+m[4]) * 3600 + (+m[5]) * 60 + (m[6] ? +m[6] : 0);
}

export function startServer(db: TzDb, port: number): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean);

        if (req.method === "POST" && url.pathname === "/imports") {
          let body = "";
          for await (const c of req) body += c;
          const { path } = JSON.parse(body || "{}");
          if (!path) return json(res, 400, { error: "缺少 path 字段" });
          return json(res, 201, db.importFile(path));
        }
        if (req.method === "GET" && url.pathname === "/imports") {
          return json(res, 200, db.listImports());
        }
        if (req.method === "GET" && parts[0] === "imports" && parts.length === 2) {
          const r = db.getImport(+parts[1]);
          return r ? json(res, 200, r) : json(res, 404, { error: "不存在" });
        }
        if (req.method === "GET" && parts[0] === "imports" && parts.length === 3) {
          const id = +parts[1];
          const rules = db.rulesFor(id);
          const sub = parts[2];
          if (sub === "utc") {
            const ts = parseTs(url.searchParams.get("ts"));
            const r = rules.utcToLocal(ts);
            db.snapshot(id, "utcToLocal", { ts }, r);
            return json(res, 200, r);
          }
          if (sub === "local") {
            const ts = parseTs(url.searchParams.get("ts"));
            const policy = (url.searchParams.get("policy") ?? "reject") as "earlier" | "later" | "reject";
            const r = rules.resolveWall(ts, policy);
            db.snapshot(id, "localToUtc", { ts, policy }, r);
            return json(res, 200, r);
          }
          if (sub === "transitions") {
            const from = parseTs(url.searchParams.get("from"));
            const to = parseTs(url.searchParams.get("to"));
            return json(res, 200, rules.transitionsBetween(from, to));
          }
          if (sub === "export") {
            return json(res, 200, { meta: db.getImport(id), rules: rules.parsed });
          }
          if (sub === "snapshots") {
            return json(res, 200, db.snapshots(id));
          }
        }
        if (req.method === "GET" && url.pathname === "/diff") {
          const a = +(url.searchParams.get("a") ?? "NaN");
          const b = +(url.searchParams.get("b") ?? "NaN");
          return json(res, 200, diffImports(db, a, b));
        }
        json(res, 404, { error: "未知路由" });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
    })();
  });
  server.listen(port, () => console.log(`TZif 服务已启动: http://127.0.0.1:${port}`));
  return server;
}
