// CLI 入口：import / inspect / utc / local / transitions / diff / export / serve / demo

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { TzDb } from "./db.js";
import { diffImports } from "./diff.js";
import { startServer } from "./api.js";
import { daysFromCivil } from "./civil.js";
import { buildTzifV2 } from "./tzifgen.js";

const args = process.argv.slice(2);
const cmd = args[0];

function opt(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

function parseTs(raw: string): number {
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!m) throw new Error(`无法解析时间: ${raw}`);
  return daysFromCivil(+m[1], +m[2], +m[3]) * 86400 + (+m[4]) * 3600 + (+m[5]) * 60 + (m[6] ? +m[6] : 0);
}

const dataDir = opt("data", path.join(process.cwd(), "data"))!;
const db = new TzDb(dataDir);
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));

function genDemoFiles(dir: string): { us: string; au: string } {
  mkdirSync(dir, { recursive: true });
  // 类美国东部：EST -5 / EDT -4，2021 年两次显式转换 + POSIX 尾部
  const us = buildTzifV2({
    types: [
      { gmtoff: -18000, isdst: false, abbrev: "EST" },
      { gmtoff: -14400, isdst: true, abbrev: "EDT" },
    ],
    transitions: [
      { time: 1615705200, abbrev: "EDT" }, // 2021-03-14 07:00:00 UTC
      { time: 1636264800, abbrev: "EST" }, // 2021-11-07 06:00:00 UTC
    ],
    footer: "EST5EDT,M3.2.0/2,M11.1.0/2",
  });
  // 类澳大利亚东部：AEST +10 / AEDT +11，南半球跨年 DST
  const au = buildTzifV2({
    types: [
      { gmtoff: 36000, isdst: false, abbrev: "AEST" },
      { gmtoff: 39600, isdst: true, abbrev: "AEDT" },
    ],
    transitions: [
      { time: 1633190400, abbrev: "AEDT" }, // 2021-10-02 16:00:00 UTC（当地 10-03 02:00 AEST）
      { time: 1648915200, abbrev: "AEST" }, // 2022-04-02 16:00:00 UTC（当地 04-03 03:00 AEDT）
    ],
    footer: "AEST-10AEDT,M10.1.0/2,M4.1.0/3",
  });
  const usPath = path.join(dir, "demo-us.tzif");
  const auPath = path.join(dir, "demo-au.tzif");
  writeFileSync(usPath, us);
  writeFileSync(auPath, au);
  return { us: usPath, au: auPath };
}

try {
  switch (cmd) {
    case "import": {
      show(db.importFile(args[1]));
      break;
    }
    case "list": {
      show(db.listImports());
      break;
    }
    case "inspect": {
      const id = +args[1];
      const meta = db.getImport(id);
      if (!meta) throw new Error(`导入记录 ${id} 不存在`);
      const rules = db.rulesFor(id);
      show({
        meta,
        types: rules.parsed.types,
        transitions: rules.parsed.transitions.slice(0, 20),
        coverageEnd: rules.coverageEnd,
        footer: rules.parsed.footer,
      });
      break;
    }
    case "utc": {
      const id = +args[1];
      const ts = parseTs(args[2]);
      const r = db.rulesFor(id).utcToLocal(ts);
      db.snapshot(id, "utcToLocal", { ts }, r);
      show(r);
      break;
    }
    case "local": {
      const id = +args[1];
      const ts = parseTs(args[2]);
      const policy = opt("policy", "reject")! as "earlier" | "later" | "reject";
      const r = db.rulesFor(id).resolveWall(ts, policy);
      db.snapshot(id, "localToUtc", { ts, policy }, r);
      show(r);
      break;
    }
    case "transitions": {
      const id = +args[1];
      show(db.rulesFor(id).transitionsBetween(parseTs(args[2]), parseTs(args[3])));
      break;
    }
    case "diff": {
      show(diffImports(db, +args[1], +args[2]));
      break;
    }
    case "export": {
      const id = +args[1];
      show({ meta: db.getImport(id), rules: db.rulesFor(id).parsed });
      break;
    }
    case "snapshots": {
      show(db.snapshots(+args[1]));
      break;
    }
    case "serve": {
      const port = +(opt("port", process.env.PORT ?? "8737")!);
      startServer(db, port);
      break;
    }
    case "demo": {
      const dir = path.join(dataDir, "demo");
      const { us } = genDemoFiles(dir);
      const imp = db.importFile(us);
      console.log(`已导入演示文件 ${us}，导入 ID = ${imp.id}\n`);
      const rules = db.rulesFor(imp.id);
      console.log("== 1) 回拨重叠：本地 2021-11-07T01:30:00 对应两个 UTC 候选 ==");
      show(rules.resolveWall(parseTs("2021-11-07T01:30:00")));
      console.log("\n== 2) 跳时空档：本地 2021-03-14T02:30:00 不存在 ==");
      show(rules.resolveWall(parseTs("2021-03-14T02:30:00")));
      console.log("\n== 3) UTC -> 本地（转换前后一秒，转换时刻本身用新规则） ==");
      show(rules.utcToLocal(1615705199));
      show(rules.utcToLocal(1615705200));
      console.log("\n== 4) 重启后从 SQLite 读取原规则（独立新连接） ==");
      const db2 = new TzDb(dataDir);
      show(db2.rulesFor(imp.id).utcToLocal(1636264800));
      db2.close();
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令> [参数]
  import <file>                 导入 TZif 文件
  list                          列出导入记录
  inspect <id>                  结构检查
  utc <id> <ts|YYYY-MM-DDTHH:mm:ss>   UTC 转本地
  local <id> <ts> [--policy earlier|later|reject]   本地墙上时间反查 UTC
  transitions <id> <from> <to>  转换点查询
  diff <idA> <idB>              规则版本对比
  export <id>                   JSON 导出
  snapshots <id>                查询快照
  serve [--port N]              启动 HTTP API（默认 8737，或环境变量 PORT）
  demo                          运行演示
通用选项: --data <目录>（默认 ./data）`);
  }
} catch (e) {
  console.error(`错误: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (cmd !== "serve") db.close();
}
