# TZif 时区规则解析与本地时间歧义裁决后端

离线时区规则服务：导入 TZif v2/v3 二进制文件，自行解析转换时刻、UTC 偏移、夏令时标志、缩写与 POSIX 尾部规则，提供 UTC→本地、本地墙上时间→UTC 候选裁决、转换点查询、规则版本对比与 JSON 导出。仅后端（HTTP API + CLI），TypeScript + Node.js + SQLite，Windows 本地运行，无 Docker/WSL/外部服务依赖。

## 环境要求

- Node.js ≥ 22.5（SQLite 使用内置 `node:sqlite`，无原生编译依赖；启动时有一条 ExperimentalWarning 属正常现象）
- 仅开发依赖 TypeScript（`npm install` 即可）

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试（17 个）
npm start         # 启动 HTTP API（默认端口 8737，PORT 环境变量或 --port 可改）
npm run demo      # 运行演示（生成合成 TZif、导入、演示歧义裁决与重启持久化）
```

数据目录默认为项目内 `./data`（SQLite 库与演示文件），可用 `--data <目录>` 更改。

## CLI

```text
node dist/src/cli.js <命令> [参数] [--data 目录]
  import <file>                导入 TZif 文件（校验失败则拒绝并说明原因）
  list                         列出全部导入记录（含 SHA-256 摘要、解析版本）
  inspect <id>                 结构检查（类型、转换、覆盖区间、尾部）
  utc <id> <ts>                UTC 转本地（ts 为 Unix 秒或 YYYY-MM-DDTHH:mm:ss）
  local <id> <ts> [--policy earlier|later|reject]
                               本地墙上时间反查 UTC 候选集
  transitions <id> <from> <to> 转换点查询
  diff <idA> <idB>             两个导入版本的规则对比
  export <id>                  JSON 导出完整解析结果
  snapshots <id>               查看该导入的查询快照
  serve [--port N]             启动 HTTP API
  demo                         演示
```

## HTTP API

- `POST /imports`，body `{"path": "C:/.../file.tzif"}`：导入文件
- `GET /imports`、`GET /imports/:id`：导入记录列表 / 详情
- `GET /imports/:id/utc?ts=<unix|ISO>`：UTC→本地（含 offset、isdst、abbrev、规则来源）
- `GET /imports/:id/local?ts=<...>&policy=earlier|later|reject`：墙上时间反查候选集
- `GET /imports/:id/transitions?from=&to=`：转换点查询
- `GET /imports/:id/export`：JSON 导出
- `GET /imports/:id/snapshots`：查询快照
- `GET /diff?a=<id>&b=<id>`：规则版本对比

## 语义说明

- **规则来源**（`source` 字段）：`explicit`（显式转换表）、`initial`（首次转换之前，按 TZif 规定取首个非 DST 类型）、`posix`（尾部规则推算）、`explicit-last`（无有效尾部、超出显式覆盖区间，沿用最后类型——即推算边界，调用方应知悉）。
- **转换时刻本身使用新规则**（`time <= utc` 取该转换）。
- **墙上时间反查**返回三种状态：`unique`（唯一）、`ambiguous`（回拨重叠，两个候选分别列出各自偏移，按 UTC 升序）、`nonexistent`（跳时空档，明确拒绝，不套用任何偏移）。`--policy earlier|later` 可在重叠时明确选择较早/较晚的 UTC。
- **POSIX 尾部**：支持固定偏移（如 `UTC0`、`<+0530>-5:30`）与 `std dst,M月.周.星期[/时刻],...` 形式（如 `EST5EDT,M3.2.0/2,M11.1.0/2`）。POSIX 偏移符号与常识相反（西为正），内部统一转为“东为正”秒数；默认转换时刻 02:00；南半球跨年夏令时（如 `AEST-10AEDT,M10.1.0/2,M4.1.0/3`）正确处理。`Jn`、纯日数等其他语法**明确拒绝**而不是忽略。

## 校验与限制

- 校验：魔数、版本（仅 v2/v3）、各计数上限（>100 万拒绝）、块长度与文件实际长度核对（截断即拒，绝不按计数预分配内存）、类型索引越界、缩写偏移边界与 NUL 终止、转换时刻严格递增、isdst 标志合法性、isstd/isgmt 计数一致性。
- **限定 POSIX 秒时间轴**：含闰秒记录（leapcnt > 0）的文件明确拒绝。
- **支持范围**：时间戳须为安全整数秒（|t| ≤ 2^53-1，约 ±2.85 亿年），超出范围在解析或查询时明确报错，不截断、不丢精度；支持负时间戳（1970 年前）与 2038 年后（第二块有符号 64 位时间）；偏移支持任意秒级值（不限整数小时）。
- 闰秒、`Jn`/Julian 日 POSIX 语法、v1/v4 文件不在支持范围内。

## SQLite 持久化

`data/tzif.db` 两张表：`imports`（SHA-256 摘要、文件名、解析版本、计数、尾部、完整解析结果 JSON、导入时间）与 `snapshots`（每次 UTC/墙上时间查询的请求与结果）。同一文件再次导入生成新记录，**文件更新不影响旧导入与旧报告**；重启后规则从库中原样恢复（demo 第 4 步演示）。

## 测试

`npm test` 运行 17 个测试。测试用 TZif 文件由 `src/tzifgen.ts` 现场合成（可重建），所有期望值（转换时刻、候选 UTC、本地时间字符串）均为**独立手算常量**，不是解析器与自身序列化器互相验证。覆盖：1970 年前、2038 年后（64 位）、半小时偏移、空转换表、负时间戳、回拨重叠双候选、跳时空档、转换前后一秒、南半球跨年 DST、POSIX 固定偏移、畸形计数/截断/魔数/版本/闰秒/非递增/索引与缩写越界、超安全整数范围、SQLite 重启持久化与旧报告不可变。

## 项目结构

```text
src/tzif.ts     TZif v2/v3 解析器（双数据块、64 位时间、全部校验）
src/posix.ts    POSIX 尾部解析与求值（M 规则、固定偏移、南半球）
src/resolve.ts  查询层（UTC→本地、墙上时间候选集、转换点）
src/civil.ts    公历换算（纯整数，不依赖 Date/Intl/操作系统时区）
src/db.ts       SQLite 持久化（node:sqlite）
src/api.ts      HTTP API
src/cli.ts      CLI 与 demo
src/tzifgen.ts  合成 TZif 生成器（测试/演示用）
test/tzif.test.ts  测试（手算期望值）
```
