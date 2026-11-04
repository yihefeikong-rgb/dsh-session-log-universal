# dsh-session-log-universal

[English](README_EN.md) · [架构说明](docs/architecture.md) · [更新日志](CHANGELOG.md)

把**每一个** DeepSeek Harness 会话的日志上传到官方 OTLP 收集端——不管这轮对话是哪个模型 provider 驱动的。

> **数据去向先说清楚。** 本插件会把会话事件发送到 DeepSeek 官方收集端 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`，内容包括你的提问、模型的回复、工具调用与工具返回、时间戳和会话标识。不接受这一点就不要安装，或者按[彻底关闭](#彻底关闭与删除)一节把它删干净。

---

## 这是什么

一个 DSH（DeepSeek Harness）插件，一条 Cordis 行，两个半边：

- **Host 半边**（`lib/index.js`，Node ESM）挂在会话事件总线上，把每个会话事件编码成 OTLP/HTTP JSON、gzip 压缩后 POST 给收集端，并在收到 2xx 之后才推进本地上传水位线。
- **Client 半边**（`lib/client.js`，浏览器 bundle）贡献两处界面：设置→通用里的总开关，以及设置→内置插件里新增的「上传状态」标签页。

## 为什么需要它

DSH 自带的那一行 `@deepseek-ai/dsh-session-log-deepseek` 走的是**请求侧**：它通过 `deepseekLlmApiExtensions` 往发往官方 DeepSeek 模型 API 的请求里塞一个 `dsh_session_log` 字段。于是：

- 用官方模型 API 的对话 → 日志随请求上传，收集端看得到。
- 换成任何别的 provider（第三方 OpenAI 兼容端点、自建/本地模型、代理）→ 这轮对话根本不经过官方 API，**一个字段也带不出去**，收集端完全没有这个会话。

本插件把同一份规范化后的会话事件台账**直接**发给官方 OTLP 端点，绕开了“请求侧”。所以：不论 provider 是什么、不论是主会话还是子会话，只要发生在装了本插件的 profile 里，都会上传。

内置开关和官方那一行是并列的：两个都开时，用官方 API 的对话会被两边各记一份（官方行按请求、本插件按事件），这是有意为之——本插件的目的是覆盖面，不是替代品。

## 安装

前置条件：DSH 桌面版（web profile，0.2.x）。插件需要能被 Node 从 profile 目录解析到，所以有下面两种放法，任选其一。

### 方式 A：装成 profile 依赖（推荐，可升级）

1. 在 profile 的 `package.json` 里加一条依赖（路径换成你 clone 的位置；Windows 下用正斜杠）：

```json
{
  "dependencies": {
    "dsh-session-log-universal": "link:D:/dev/dsh-session-log-universal"
  }
}
```

2. 在 profile 目录里安装（该 profile 用 pnpm）：

```bash
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm install
```

### 方式 B：直接放进 harness home（本仓库开发时用的就是这种）

把仓库目录复制成 `%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal\`（里面需要 `lib/` 与 `package.json`）。profile 目录在它下面，Node 向上查找就能解析到；不需要动 profile 的依赖清单。

之后每次改完代码，用仓库自带的同步脚本把改动推到这份运行副本：

```bash
npm run sync                 # 复制 lib/*.js 与 package.json，幂等
node scripts/sync-dev.mjs --dry-run   # 只看计划，不写盘
node scripts/sync-dev.mjs --check     # 有漂移就退出码 1，适合放进预提交钩子
```

脚本只写运行副本的 `package.json` 和 `lib/*.js`，别的什么都不动；`lib/` 里已经不存在的旧 `.js` 会被删掉，免得加载器按路径导入到废弃代码。可用 `--target <dir>` 或环境变量 `DSH_RUNTIME_DIR` 指定别的副本。

### 然后：在 profile 的 cordis.patch.yml 里插一行

编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（这是用户自己的 tweak 层，应用在所有 bundle 层之后）：

```yaml
- insert:
    - id: dsh-session-log-universal
      name: 'dsh-session-log-universal'
      config:
        enabled: true
```

`id` 必须保持 `dsh-session-log-universal`：`dsh-settings` 用它给客户端的配置命名空间取键，改名会让设置开关和状态页找不到 Host 配置。

`config` 整块可以省略（默认值就是开箱可用的）；要改端口、批量大小等再按下面[配置项](#配置项)写。patch 层支持热重载（`patchReload: live`），保存后一般不用重启应用。

安装完成的迹象：DSH 日志里出现一行

```text
session-log-universal: uploading every session log to https://dsh-otel-collector.deepseeksvc.com/v1/logs (enabled=true, scope=dsh-session-log-universal)
```

并且“设置→通用”里，官方那行上传开关下面多了一行「上传全部会话日志（插件提供）」。

## 设置项

**位置：设置 → 通用 → 「上传全部会话日志（插件提供） / Upload Session Log for every conversation」**

就在官方那行「上传会话日志」下面。这是一个 `enabled` 总开关，改的是 Host 的 `volatile` 字段，**立刻生效、不用重启**：关掉之后不再捕获新事件（已经排队待发的记录会继续发完），重新打开时会把开关期间漏掉的那一段从会话日志里读回来补上，而不是默默跳过。

开关写入被拒绝或传输失败时，界面显示的是“已接受的值”加一条失败提示，不会乐观地把开关画成已打开。

## 上传状态页

**位置：设置 → 内置插件 → 「上传状态 / Upload status」标签页**

这一页是本插件注册进内置插件设置页（`settings.plugins.tab` 这个根级 list slot）的独立标签页（id `upload-status`，order 20，排在只读的“插件列表”之后），不需要改任何官方包。

页面顶部是统计卡——**会话总数 / 已上传 / 部分上传 / 未上传 / 已上传事件**（「部分上传」只在确实存在这种会话时才出现，所以通常是 4 张、需要时 5 张）——加数据生成时间、当前采集端地址和一个「刷新」按钮；下面是搜索框（按标题、会话 ID 或目录过滤）与逐会话的列表：

- 每行标题取会话自己的 `session/title`，没有标题时退回第一条人类提问；
- 第二行是 cwd，子代理会话会标注出来；
- 事实行显示事件数（`事件 N`）与上游确认进度（`已上传 acked/total 条`，`acked` 是确认到的条数，即已确认 seq + 1）；
- 右侧是状态徽标：**绿色 = 已上传**（收集端 2xx 已覆盖整段日志）、**浅灰 = 未上传或部分上传**（一次都没被确认，或只确认到更早的前缀）；
- 徽标下面是上游证据：这次确认的 HTTP 状态码、距现在多久，以及收集端返回里的 `partialSuccess` 说明（被拒了几条记录、为什么），所以“没网”“401”“收集端说收了一部分”在页面上是能区分开的。
- 一个事件都没有的空会话默认不占列表（几百条空会话会把真正有信息的行埋掉），页面用一行提示“已隐藏 N 个空会话（无任何事件）”；这些会话仍然计入合计。

判定标准是**本地记录的“上游已收录”证据**，不是“我们把它交给传输层了”：

| 徽标 | 判定 | 含义 |
|---|---|---|
| 已上传（绿） | `ackedSeq + 1 >= localEvents` | 收集端确认的范围覆盖了整个本地日志 |
| 部分上传（浅灰） | 有 ack，但只覆盖前缀 | 前面传上去了，尾巴还欠着（通常是刚结束一轮、还没到 flush 点） |
| 未上传（浅灰） | 没有任何 ack 记录 | 一条都还没被确认，或这个会话还没轮到 |

### 数据从哪来

这一页的数据来自 Host 注册的一个**只读路由**：

```text
GET /plugin/session-log-universal/report
```

| 项 | 行为 |
|---|---|
| 方法 | 只接受 GET；其它方法返回 `405`（带 `allow: GET`） |
| 访问范围 | 只服务回环地址（`127.0.0.1` / `localhost` / `::1` 及其端口写法）；其它 `host` 返回 `403` —— 响应里带会话标题和目录，不该出本机 |
| 缓存 | 响应头 `cache-control: no-store`；Host 侧约 5 秒重建一次（没人看时不重建，空闲 cadence 60 秒） |
| 行数 | 最多 500 行；超出时 `truncated: true`，合计仍按**全部**会话统计，页面提示“仅列出最近的会话” |
| 失败 | 报告构建失败返回 `500` 和诊断信息，而不是一张空表 |

审计时有两种读法：

- 浏览器直接打开 `http://127.0.0.1:<webserver 端口>/plugin/session-log-universal/report`，就是原始的 JSON；
- 桌面应用里页面本身是自定义 scheme，所以客户端不用 `fetch` 的相对路径，而是经 shell 提供的 `__DSH_TRANSPORT__.fetch` 取同一路径的**文档相对形式**（`plugin/session-log-universal/report`，没有前导斜杠）——同一个路由，两种到达方式。

开关关掉时页面顶部会显示一条“上传开关已关闭，新事件不会再上传”的提示。

> **为什么不用 `configForms`：** 我们最初确实想走“volatile 配置字段镜像到客户端”这条路，但它不成立——`describe` 只在插件**原始 config 发生变化**时重新读取 volatile 字段，而水位线是 Host 自己写的，原始 config 永远不会因此变化，值就永远推不出去。所以最终拆成两半：开关仍然走 `configForms`（它由用户操作触发，天然会触发那次重读），报告走这条只读路由。同时这也避免了把一张几百行的表塞进设置文档里，让其它界面一起付渲染和序列化成本。维护时请保持这个分工。

## 水位线与可靠投递

水位线文件：**`%USERPROFILE%\.dsh\profiles\desktop\data\session-log-universal.json`**

```json
{
  "version": 1,
  "rows": {
    "<session-id>": {
      "seq": 42,
      "at": 1762200000000,
      "code": 200,
      "note": null,
      "failCode": null,
      "failAt": null,
      "failNote": null
    }
  }
}
```

- `seq`：该会话**已被收集端 2xx 确认**的最高事件序号，逐会话、只增不减。
- `at`：确认时间（epoch 毫秒）。
- `code`：这次确认收到的 HTTP 状态码（例如 `200`、`202`）。老文件没有这个字段时按 `200` 读——只有 2xx 才会推进 `seq`，所以“缺状态”本身就等于“它被一次 2xx 推进过”。
- `note`：上游响应里的说明，主要是 `partialSuccess`（收了一部分、拒了几条）一类的提示，没有就是 `null`。`code` + `note` 合起来就是状态页上那条“上游证据”。
- `failCode`/`failAt`/`failNote`：**最近一次被拒/失败的尝试**（含网络层失败，此时 `failCode` 为 `null`）。被拒**不推进 `seq`**，只把失败证据记下来，所以一行可以同时显示“上游确认到了哪”和“最近为什么发不出去”。
- **向后兼容**：老文件里缺少的字段一律按 `null` 读（`code` 按 `200`），只写了 `{seq, at}` 的历史行不需要迁移、也不会被误判成失败；下一次确认会补齐收据字段。
- 写入走临时文件 + 原子 rename，并且合并到最多每秒一次；写盘失败时以内存为准，下次变更再试。

可靠性语义可以一句话概括：**水位线只会落后于现实，永远不会超前。** 具体是：

- 只有 2xx 才 `advance`；网络错误、超时、5xx、429 都只重试，确认不前进。
- 队列有上限（`maxQueueRecords`）。满了以后**拒绝新记录而不是挤掉旧记录**，这样每个会话在队列里始终是连续前缀，确认也可以是前缀，水位线不可能跨过收集端没收到的那一条。被拒绝的记录算“仍然欠着”：等收集端恢复后，重放会从会话日志里把它读回来再发。
- 落地时机：插件挂载时扫一遍活动会话、每轮结束的 `session/flush`、会话销毁、以及插件卸载时各推一次。
- 进程崩溃、断网、收集端宕机都只会让水位线停在原地，下次从存档点续传，不会丢中段，也不会把没发出去的当成已发送。

## 手动补传：`/uploadlog`

```text
/uploadlog            # 补传当前会话欠的那一段
/uploadlog <session-id>   # 补传指定会话（存档里的也行）
```

这个命令给你三个出口：收集端恢复后不用等下一轮就补发；队列溢出丢过一段时手工补齐；以及**给装了插件之前的旧会话补传**（见下面的诚实声明）。它按水位线重读，不是按内存里“已排队”的标记，所以能把已经算过排队、实际没发出去的那段救回来。

成功时返回形如：

```text
session-log-universal: uploaded 12 record(s) of "<session-id>"; checkpoint: seq 137; still queued: 0
```

## 审计

想自己确认“到底发出去了什么、上游收了没”，有四条路：

1. **看水位线**：上面的 JSON 每个会话一行，`at` 就是上游确认的时间戳；把它和会话里最后的事件序号比较，差距就是还欠的量。
2. **看状态页**：设置→内置插件→上传状态，绿/灰一眼看完；想要原始 JSON 就直接读它的数据源：

```bash
curl -s http://127.0.0.1:<GUI 端口>/plugin/session-log-universal/report
```

   返回 `totals` 与 `rows`（`state` 为 `uploaded`/`partial`/`never`，`upstream` 里是那次确认的 `code`/`at`/`note`）。
3. **看日志**：正常情况有安装时那行 `uploading every session log to …`；异常时会 warn `collector returned HTTP <status>`、`upload queue is full`、`record … exceeds maxRequestBytes`。
4. **端到端抓一遍**：把 `config.url` 临时指到本机，例如

```bash
node -e "require('http').createServer((q,s)=>{let n=0;q.on('data',c=>n+=c.length);q.on('end',()=>{console.log(q.method,q.url,q.headers['content-encoding'],n,'bytes');s.writeHead(200).end()})}).listen(8787)"
```

然后在 patch 里把 `url` 设成 `http://127.0.0.1:8787/v1/logs`、`/uploadlog` 一次，就能看到真实的请求头、gzip 体积和 2xx 通路；验完记得把 `url` 改回默认值。

## 彻底关闭与删除

按顺序做，前两步就能止住上传，后面是清理痕迹：

1. **关开关**：设置 → 通用 → 「上传全部会话日志（插件提供）」关掉。立刻停发，不用重启。
2. **删 patch 行**：在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里删掉 `- insert:` 那三行（`id: dsh-session-log-universal` 那条）。patch 层热重载，或重启 DSH 生效。
3. **删运行副本**：

```bat
rmdir /s /q "%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal"
```

（如果你走的是方式 A，则删掉 profile `package.json` 里那条依赖，再 `pnpm install`。）

4. **删水位线**（可选，删掉等于忘记“哪些已经传过”）：

```bat
del "%USERPROFILE%\.dsh\profiles\desktop\data\session-log-universal.json"
```

5. 重启 DSH，确认设置→通用 里那一行消失、日志里不再出现 `session-log-universal:` 开头的行。

需要说明的是：**已经上传的数据无法撤回**。上面删的都是本地文件和执行路径，收集端已经收录的内容由 DeepSeek 侧按它自己的策略处理。

## 配置项

写在 patch 行的 `config:` 下，字段校验来自 Host 的 `Config`（`@deepseek-ai/schemastery`）。除 `enabled` 外都是加载时读一次，改动需要重载插件（patch 热重载即可）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关，`volatile`，设置→通用 里可实时改。 |
| `url` | string | `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | OTLP/HTTP logs 端点。 |
| `includeHistory` | boolean | `true` | 打开时，尚无水位线的**活动**会话从 seq 0 开始补；关闭时只从当前时刻起算。不影响磁盘上的旧会话。 |
| `scopeName` | string | `dsh-session-log-universal` | OTLP scope 名，同时用作 user agent 前缀。 |
| `flushDelayMillis` | number | `5000` | 攒批延迟（100–60000 ms）。 |
| `maxRequestBytes` | number | `4000000` | 单次请求字节上限；单条记录本身超过它就无法上传（warn 并跳过）。 |
| `maxBatchRecords` | number | `512` | 单次请求最多几条记录（1–2048）。 |
| `maxQueueRecords` | number | `4096` | 内存队列上限（64–100000），满了拒绝新记录、等重放。 |
| `retries` | number | `3` | 5xx/429 与网络错误的重试次数（0–10），指数退避。 |
| `requestTimeoutMillis` | number | `20000` | 单次请求超时（1000–120000 ms）。 |

## 目录结构

```text
dsh-session-log-universal/
├─ lib/
│  ├─ index.js          # Host 半边：捕获、编码、队列、上传、水位线、/uploadlog
│  ├─ report.js         # Host 半边：上传状态报告与只读路由 GET /plugin/session-log-universal/report
│  └─ client.js         # Client 半边：模块加载器包装的浏览器 bundle（零构建）
├─ scripts/
│  └─ sync-dev.mjs      # 把仓库同步到运行副本（幂等，--dry-run / --check / --target）
├─ tests/
│  ├─ index.js          # `node --test tests/` 的入口，导入下面两个套件
│  ├─ report.test.mjs   # 报告/路由：自包含，随时可跑
│  └─ watermark.test.mjs# 水位线：需要 harness 运行环境，否则自动 skip
├─ docs/
│  └─ architecture.md   # Host / Client 两侧的流程与契约
├─ package.json         # 包元数据、dsh.client 声明、sync / test / check 脚本
├─ CHANGELOG.md
├─ LICENSE              # MIT
├─ README.md
└─ README_EN.md
```

## 开发

零构建：`lib/index.js` 与 `lib/report.js` 是普通 ESM 模块，`lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 包装的浏览器 bundle——全部手写，没有打包器，也没有构建脚本。

两半的生效成本不一样，务必分清：

| 半边 | 改完怎么生效 |
|---|---|
| Client（`lib/client.js`） | client-hmr 轮询运行副本的 bundle，**保存即热更新**；页面会重新挂载，React 状态（搜索词、滚动位置、刷新时间）随之重置，这是预期行为 |
| Host（`lib/index.js`、`lib/report.js`） | **没有热更新**：进程里已导入的旧模块不会重新加载，改完必须重启一次桌面应用。重启前会看到这样的错位现象——客户端已经拿着新 bundle 去请求 `/plugin/session-log-universal/report`，而旧 Host 没注册这条路由，于是状态页显示读取失败 |

日常循环：

```bash
npm run sync      # 仓库 → 运行副本（lib/*.js + package.json），幂等
npm test          # node --test "tests/*.test.mjs"
npm run check     # 三个 lib 文件的语法检查
```

测试有三种等价跑法，结果一样：`npm test`、`node --test tests/`（目录入口是 `tests/index.js`）、`node tests/report.test.mjs`（单文件）。

- `node scripts/sync-dev.mjs --dry-run` 只打印计划；`--check` 有漂移就退出码 1（适合放进预提交钩子）；`--target <dir>` 或环境变量 `DSH_RUNTIME_DIR` 可指向别的副本。
- `tests/report.test.mjs` 完全自包含（内存 stub、无 fixture 文件、不联网、不读 harness home）：状态判定、上游证据、标题抽取、报告聚合与截断、路由的 200/405/403/500 与响应头。
- `tests/watermark.test.mjs` 覆盖水位线（单调推进、收据、失败证据、原子落盘与重载、老文件兼容、损坏文件自愈）。它需要 `@deepseek-ai/schemastery`，而这个 peer 只存在于 harness 运行环境里，所以在纯 checkout 里会自动 skip；指向已安装的副本就能真跑：

```bash
DSH_SLU_HOST_MODULE="%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal\lib\index.js" node tests/watermark.test.mjs
```

## 协议端点

| 项 | 值 |
|---|---|
| 方法/路径 | `POST https://dsh-otel-collector.deepseeksvc.com/v1/logs` |
| 请求头 | `content-type: application/json`、`content-encoding: gzip`、`user-agent: <scopeName>/<harness 版本>` |
| 报文 | OTLP/HTTP JSON（`resourceLogs` → `scopeLogs` → `logRecords`），与 `@opentelemetry/otlp-transformer` 的 `JsonLogsSerializer` 对同一批记录逐字节一致 |
| 一条记录 | 一个会话事件：`eventName = session-log`，`body = "session-log"`，属性含 `session.id`、`event.type`、`event.seq`、`session.cwd`、`session.parent_id`、`session.seed_length`，以及 `content` = 事件完整 JSON |
| 资源属性 | `service.name = deepseek-harness`、`service.version` = harness 版本、`user.id` = `<DSH_HOME>/.anonymous-user-id` 里的匿名 uuid（与官方 helper 共用同一个） |
| 成功判定 | HTTP 2xx |
| 状态页数据 | `GET /plugin/session-log-universal/report`（Host 本地只读路由，仅回环地址，`no-store`） |

## 已知限制

- **不会补传安装之前的历史会话。** 只有插件加载之后发生的事件会被捕获；`includeHistory` 说的“从 seq 0 开始”只针对插件挂载时**仍在内存里**的活动会话。磁盘上那些旧会话要用 `/uploadlog <session-id>` 手工补，或者干脆不补。
- **数据会离开本机。** 见开头那段：内容发往 DeepSeek 官方收集端，匿名 `user.id` 不是账号身份，但会话内容就是会话内容。
- 队列上限（默认 4096 条）在长时间断网后又一次性恢复时可能被顶满，表现为状态页有灰点、水位线落后；等收集端可达或者手动 `/uploadlog` 即可追平，不会静默丢数据。
- 单条事件超过 `maxRequestBytes`（默认 4 MB）时无法分片，只能跳过并在日志里告警。
- 非 2xx 的 4xx（除 429）被当作该批次的永久拒绝：记录保持未确认并等待重放，所以 `url` 写错会一直重试、一直有 warn。
- 状态页最多列最近 500 个会话（合计仍按全部会话统计），超出时页面提示“仅列出最近的会话”。
- 状态页依赖 Host 的 web 服务器：没有 `webServer` 的组合（headless/ACP）上传照旧，但那条只读路由不存在，页面会显示读取失败。
- 只对 web profile 有意义（`dsh.client.platform: web`）；headless/ACP 等没有设置界面，只剩 Host 侧上传。

## 许可

[MIT](LICENSE) © 2026 yihefeikong-rgb
