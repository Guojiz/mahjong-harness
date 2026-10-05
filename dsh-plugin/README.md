# DSH Cordis 插件：dsh-mahjong-runtime-live-card

本目录是「对话内麻将卡片」的完整源码：Host 半区管 worker 与四个工具，Client 半区管对话卡片。
两条接入路径共用同一份 `host.js` / `client.js`：

| 路径 | 用途 | 生命周期 |
| --- | --- | --- |
| 动态会话插件（`cordis_define` + `cordis_run`） | 对话内卡片 + 四个工具 | 随 DSH 进程/会话，重启后需重新定义 |
| profile 插件包（`package.json` + `cordis.patch.yml`） | 四个工具（无对话卡片，无 Client RPC 桥） | 持久，随 profile 启动 |

## 文件

- `host.js` —— Host 半区。**它是 DSH 动态包沙箱里一个 async 函数体**（末尾 `return {…}`），因此只能用
  `console` / `harness.{defineTool,registerTool,handle}` / 编码原语；`require`、`process`、`fs`、`path`、
  `setTimeout`、`fetch` 在沙箱里会被 trap 抛错。职责：解析 workspace、拉起 `harness.worker`（JSONL 长连接）与
  `harness.serve_logs`（loopback 回放服务）、注册四个工具、把 `mahjong.status/export/cancel` 暴露给
  Client 的 `host.call`，并在 `ctx.effect` 里做子进程回收。
- `client.js` —— Client 半区。同样是一个函数体；注册到 `tool.call.toolview` 槽（key = `mahjong_start`）。
  首屏只有紧凑卡片，用户点「展开牌桌」后才渲染详情层与 `viewerUrl` 的 iframe。
- `index.cjs` —— profile 安装入口。把 `host.js` 当作函数体编译成真正的 cordis 插件，供 Loader 加载。
- `cordis.patch.yml` —— profile bundle 的 Loader 行（`id: mahjong-harness`）。
- `print-register.mjs` —— 生成 `cordis_define` 的完整 JSON 载荷（4 万字符，手抄必错）。
- `test_plugin.js` —— 静态结构 + 沙箱禁令检查。
- `test_host_contract.js` —— 宿主级集成测试（见下）。
- `test_client_card.js` —— 卡片渲染测试（真实 React SSR）。
- `log-viewer/` —— 完整 MJAI 回放器；`window.MJAIStudio.loadEvents(events)`。

## 契约要点（踩过的坑）

DSH 动态包沙箱比 Node 窄得多，旧版实现有四处必然失败：

1. `require('path')` 在沙箱第一行就会抛错 → 现在路径拼接自带 `joinPath()`。
2. `ctx.tools.register(裸对象)` 会被 `ToolRuntime.register` 拒绝（必须有 `output: { schema, render }`），
   且动态工具必须由 `harness.defineTool` 产出（有内部 marker）→ 现在走完整 DSL。
3. `credentials.resolve(ref)` 返回 `{ value, source } | undefined`，不是字符串 → 现在做了解包。
4. `subprocess.spawn()` 返回的 `SubprocessHandle` **没有 `.on('exit')`**；退出是 `handle.done`
   （`Promise<{ exitCode, signal }>`）→ 现在用 `handle.done.then(...)`。
5. `process.env` 不可用 → 子进程 env 只传 `PYTHONPATH` / `PYTHONDONTWRITEBYTECODE`，
   PATH 由 subprocess 服务自己的 scrubbed parent env 提供。
6. `setTimeout` 被 trap → 请求超时改用 `ctx.timeout`（需要 `inject: ['timer']`）。
7. `ctx.tools` 必须先 `inject: ['tools']`，否则 cordis 直接拒绝属性访问。
8. workspace 无法再靠 `process.env` / `__dirname` 探测，**且动态路径的 `cordis_run` 不传 config**
   （`ctx.plugin(guardedPlugin(plugin))` 无第二参数）→ `mahjong_start.workspace` 参数 → profile `config.workspace`
   → `exec.agent.session.header.cwd` → `workspaceRegistry`。
9. 工具/桥接处理器的返回值会被沙箱做「无损 JSON」校验，`undefined` 成员直接报错 → 出口统一过 `plain()`。
   （真实运行器测试抓到的；回放替身现已同步强制该规则。）

## 注册

```bash
# 打印可直接粘贴的 cordis_define 载荷（含契约自检）
node dsh-plugin/print-register.mjs --summary
node dsh-plugin/print-register.mjs --out /tmp/mahjong-plugin.json
```

```
cordis_define  kind="new" idPrefix="mjai"
               name="dsh-mahjong-runtime-live-card"
               code.host   ← dsh-plugin/host.js
               code.client ← dsh-plugin/client.js

cordis_run     pluginId=<上一步返回的 id>      # 不需要也不支持传 config

mahjong_start  seed=7 mock=true                # 在仓库目录启动 DSH 时无需 workspace
mahjong_start  workspace="/绝对路径/mahjong-harness" seed=7 mock=true   # 会话 cwd 不在仓库时
```

`mahjong_start` 可选参数：`seed`、`mock`、`budget`、`model`、`workspace`、`python`、`viewerPort`。profile 路径另支持 `config.{workspace,python,viewerHost,viewerPort,baseUrl,model}`。

## profile 持久安装

```bash
dsh plugin --profile <name> add <本目录>
# 再把 mahjong-harness-dsh-plugin 加进该 profile package.json 的 dsh.profile.bundles，
# 并在 profile 的 cordis.patch.yml 里给 id: mahjong-harness 补上 workspace。
```

## 测试

```bash
node dsh-plugin/test_plugin.js         # 静态结构 + 沙箱禁令
node dsh-plugin/test_client_card.js    # 真实 React SSR：首屏紧凑卡、iframe 按需
node dsh-plugin/test_host_contract.js  # 真实 cordis + ToolRuntime + worker + viewer（沙箱替身）
node dsh-plugin/test_dynamic_runner.js # 真实 DynamicCordisRunnerService：define → run → stop
```

`test_host_contract.js` 需要机器上已安装 DSH 运行时；它按 `/opt/homebrew`、`/usr/local`、
`~/.npm-global` 顺序探测，可用 `DSH_MAHJONG_DSH_ROOT` 覆盖。`SKIP_PARITY=1` 跳过与真实
`@deepseek-ai/dsh-subprocess-local` 的句柄契约对照。

## 工具行为

- `mahjong_start` → 对话卡片；session id 由 **tool-call id** 推导（`mj-<callId>`），Client 用同一个
  callId 推导出同一个 id，因此卡片一渲染就能轮询到对局。
- API key 仅经 DSH `credentials`（namespace `mahjong` / name `LLM_API_KEY`）注入 worker，且不写入任何快照或导出。
- 卡片不自动全屏、不切路由；「展开牌桌」是用户显式操作。

## 许可

`log-viewer` 与 Mortal/libriichi 相关代码受 **AGPL-3.0-or-later** 约束。对外分发前请完成许可证审查。
