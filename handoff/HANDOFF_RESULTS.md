# 接手结果报告

> 更新：2026-10-04 · macOS arm64 · Python 3.14.6 · Node 26.7.0

## 当前验收

以下结果来自本机当前工作树，命令均以真实退出码判定，失败不会被 `|| true` 吞掉：

- `git diff --check`：通过
- host/client JavaScript 语法与 shell 语法：通过
- Python 协议、崩溃、状态、回放安全和流式客户端：14/14 通过
- DSH 插件静态结构 + 沙箱禁用 API 检查：通过
- DSH 客户端卡片（真实 React 18 SSR）：11/11 通过
- DSH 宿主级集成（真实 cordis + ToolRuntime + subprocess-local + worker + viewer）：17/17 通过
- `bash verify.sh`：20 通过、0 失败、1 跳过，exit 0；跳过项是默认关闭的实时 API 请求

## 已完成

- macOS/Linux `setup.sh`：构建 libriichi 并验证环境；编译产物留在私有 Mortal 子模块工作区，不伪装成父仓库文件。
- 长驻 Python worker：会话隔离、状态查询、取消、导出、崩溃状态和无密钥快照。
- **Host 半区按 DSH 动态包沙箱的真实契约重写**（这是本次的主要修复，见下）。
- 对话卡：紧凑牌桌、比分/动作/统计、轮询、主动展开完整回放，不自动抢占全屏。
- 本地回放服务：仅 loopback 绑定、合法 session id、事件和状态文件、HTML 注入防护、增量轮询。
- LLM 客户端：SiliconFlow/OpenAI-compatible SSE、推理块过滤、总时限、短读超时和取消事件。
- 对局展示流只发布第一桌完整 MJAI，包含 `end_kyoku` / `end_game`，避免四桌事件混流。
- profile 插件包形态（`package.json` + `index.cjs` + `cordis.patch.yml`）与 `cordis_define` 载荷生成器。

## 本次修复：host.js / client.js 与真实 DSH 契约不一致

旧版 `host.js` 从未在 DSH 里真正跑起来过——`HANDOFF_RESULTS.md` 上一版把这归为「尚待宿主验收」，
实际是代码与契约不符。逐条对照 DSH 0.2.0-rc.2 的 `@deepseek-ai/dsh-cordis-host-runner` 源码后确认：

| # | 旧实现 | 真实契约 | 处理 |
| --- | --- | --- | --- |
| 1 | 第 5 行 `require('path')` / `require('fs')` | 沙箱 trap 掉 `require`，第一行即抛错 | 自带 `joinPath()` / `pathListSeparator()` |
| 2 | `process.env` 构造子进程 env | 沙箱无 `process` | 只传 `PYTHONPATH` / `PYTHONDONTWRITEBYTECODE`，PATH 由 subprocess 服务提供 |
| 3 | `setTimeout` 做请求超时 | 沙箱 trap 掉，需 `inject:['timer']` + `ctx.timeout` | 改用 `ctx.timeout`（fiber 作用域，随运行回收） |
| 4 | `ctx.harness` 兜底 + 裸工具对象 | 沙箱提供**全局** `harness`，且 `harness.registerTool` 只接受 `harness.defineTool` 带 marker 的产物 | 走 `harness.defineTool` + `harness.registerTool` |
| 5 | 工具缺 `output:{schema,render}` | `ToolRuntime.register` 直接 `TypeError` | 补 `output`，render 返回内容块数组 |
| 6 | `inject:['subprocess']`，直接读 `ctx.tools` | cordis 拒绝未注入的属性访问；`tools` 必须注入 | `inject:['subprocess','timer','tools']` |
| 7 | `credentials.resolve()` 当字符串用 | 返回 `{ value, source } \| undefined` | 解包 `.value` |
| 8 | `proc.on('exit', …)` | `SubprocessHandle` 没有 `.on`，退出是 `handle.done` | 改用 `handle.done.then(...)` |
| 9 | workspace 靠 `__dirname` / 环境变量探测 | 沙箱里两者都不存在 | `cordis_run` 的 `config.workspace` 优先，回退 `exec.agent.cwd` / `workspaceRegistry` |
| 10 | session id = 时间戳+随机数 | — | 改为 `mj-<callId>`，与 Client 的 `derivedSessionId(callId)` 对齐 |
| 11 | client 从 `props.block` 直接当入参对象 | 真实 slot props：`block` 是调用节点，入参在 `argsRaw`（JSON 字符串）；结束态在 `block.call.argsRaw` | 新增 `parseArgs()` + `callStatus()` |

## SiliconFlow 真实记录

DSH 会话历史中已有两项真实实测记录：

| 测试 | 结果 |
| --- | --- |
| 单次局面决策 | DeepSeek-V4-Flash 在 44.5s 返回 `dahai 8m`，解析成功并通过 `validate_reaction()` |
| 最小真实对局 | seed=7、budget=1，1 次真实 LLM 调用，103.8s，0 违规；其余决策由规则引擎兜底 |

这些是历史端到端 API 证据，不等同于本次默认 `verify.sh` 又执行了一次实时请求。若要刷新证据：

```bash
RUN_SILICONFLOW_SMOKE=1 bash verify.sh
```

## 自动化验收覆盖了什么

`node dsh-plugin/test_host_contract.js` 用**真实的** `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`
（`ToolRuntime` + `defineTool`）和 `@deepseek-ai/dsh-subprocess-local` 挂载 `host.js`，用 DSH 自己的
vm 沙箱形态（全局 `harness` + 禁用 API 陷阱）执行它，然后：

1. 断言真实 `ToolRuntime` 里出现且只出现四个工具，参数是合法 JSON Schema，`output.render` 返回内容块数组；
2. 断言裸工具（未经 `harness.defineTool`）会被拒绝；
3. `mahjong_start(mock, seed=7)` 返回紧凑卡片载荷：session id = `mj-<callId>`、四家分数合计 100000、无密钥字段；
4. 轮询到 `viewerUrl` 后真实 HTTP GET：`/view/<id>` 返回 200 HTML 且带 `__INJECTED_EVENTS__`，
   `/api/events/<id>` 返回事件数组；
5. `mahjong_cancel` 延迟 < 5s；
6. 卸载后 worker/viewer 子进程全部退出、回放端口拒绝连接。

`node dsh-plugin/test_client_card.js` 用真实 React 18 + `react-dom/server` 渲染卡片，断言
首屏只有紧凑卡片（无 `.mj-detail`、无 `<iframe>`），显式展开后才出现 iframe 与统计，并覆盖
`argsRaw` / 运行态 vs 结束态 / 失败态的 slot props 契约。

## 仍需人工确认（不能由自动化代替）

1. 在真实 DSH 会话里执行 `cordis_define` + `cordis_run`，用 `Tool.listTools` 看到四个工具。
   自动化只能证明 host/client 在同等契约下工作，证明不了「本机 DSH 会话的操作路径」。
2. 肉眼确认首个 `mahjong_start` 后聊天仍可输入、卡片不抢全屏。
3. 在浏览器里点「展开牌桌」，确认 iframe 真加载出回放器，关闭后回到原对话位置。
4. 真机检查插件卸载（Cordis 面板 stop）后的端口占用提示与取消时延观感。

注册步骤见 `dsh-plugin/REGISTER.md`；生成载荷用 `node dsh-plugin/print-register.mjs`。

## 新机器

```bash
git clone --recurse-submodules https://github.com/Guojiz/mahjong-harness.git
cd mahjong-harness
bash setup.sh
bash verify.sh
```

父仓库只记录 Mortal 子模块提交。`Mortal/mortal/libriichi.so` 和 `Mortal/target/` 不会随父仓库提交；新机器必须运行 `setup.sh` 构建。
