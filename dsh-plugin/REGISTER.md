# DSH 插件注册与运行说明

两条接入路径，任选其一：

| 路径 | 得到 | 生命周期 |
| --- | --- | --- |
| A. 动态会话插件 | 对话内麻将卡片 **+** 四个工具 | 随 DSH 进程/会话，重启后需重新 `cordis_define` |
| B. profile 插件包 | **只有**四个工具（没有 Client RPC 桥，因此没有对话卡片） | 持久，随 profile 启动 |

---

## A. 动态会话插件（对话卡片）

### 步骤 0：构建运行时

```bash
bash setup.sh          # 构建 libriichi + 验证环境
node dsh-plugin/test_host_contract.js   # 可选：本机自检
```

### 步骤 1：生成注册载荷

`host.js` 与 `client.js` 合计约 43 KB，手抄必然出错，用生成器：

```bash
node dsh-plugin/print-register.mjs --summary   # 只打印大小与自检结果
node dsh-plugin/print-register.mjs --out /tmp/mahjong-plugin.json
```

生成器会先做沙箱契约自检：`host.js` 必须能作为 async 函数体编译并返回 cordis plugin，
且不得引用 `require` / `process.` / `setTimeout` / `setInterval` / `fetch`，并且必须声明 `tools` 注入。

### 步骤 2：定义插件

在任意 DSH 会话中调用 `cordis_define`：

```
kind:      new
idPrefix:  mjai
name:      dsh-mahjong-runtime-live-card
code.host:   ← dsh-plugin/host.js 的完整内容
code.client: ← dsh-plugin/client.js 的完整内容
```

### 步骤 3：运行

```
cordis_run pluginId=<步骤 2 返回的 pluginId>
```

> **`cordis_run` 不向插件传 config**（运行器内部是 `ctx.plugin(guardedPlugin(plugin))`，无第二参数），
> 沙箱里又没有 `process` / `fs` / `path` / `__dirname`。所以仓库路径按以下顺序解析：
>
> 1. `mahjong_start` 的 `workspace` 参数；
> 2. profile 路径的 `config.workspace`；
> 3. 调用会话的 cwd（`exec.agent.session.header.cwd`）——**在仓库目录里启动 DSH 就不用配**；
> 4. 第一个已注册 workspace。
>
> 都拿不到时工具会报「无法确定仓库路径」并指明 `mahjong_start workspace=…`，而不是静默失败。
> `python`（默认 `python3`，Windows 为 `python`）与 `viewerPort`（默认 `8765`）同样可作为 `mahjong_start` 参数。

### 步骤 4：验证工具

```
Tool.listTools
```

应出现四个工具：

- `mahjong_start` — 开始一局日本麻将
- `mahjong_status` — 查询对局状态
- `mahjong_cancel` — 取消运行中的对局
- `mahjong_export` — 导出 MJAI 事件和统计

### 步骤 5：跑一局

```
mahjong_start seed=7 mock=true
```

预期：对话区出现紧凑麻将卡片（**不自动全屏**）；点「展开牌桌」后详情层内出现
`http://127.0.0.1:<viewerPort>/view/mj-<callId>` 的 iframe；对局结束后可「导出 MJAI」。

> 卡片与 host 用同一个 **tool-call id** 关联 session（`mj-<callId>`），所以首帧渲染即可开始轮询。
> 如果卡片一直停在 `starting`，先确认仓库路径解析正确（见步骤 3）、且 `Mortal/mortal/libriichi.so` 存在。

---

## B. profile 插件包（持久安装，仅工具）

```bash
dsh plugin --profile <profile> add <path-to-dsh-plugin>
```

然后在该 profile 的 `package.json` 里把包名加进 bundle 列表：

```json
{ "dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "mahjong-harness-dsh-plugin"
] } } }
```

并给 `dsh-plugin/cordis.patch.yml` 里的 `id: mahjong-harness` 补上 `workspace`：

```yaml
- insert:
    - id: mahjong-harness
      name: mahjong-harness-dsh-plugin
      config:
        workspace: /absolute/path/to/mahjong-harness
        viewerPort: 8765
```

限制：profile 插件运行在真正的 Node 环境里，没有动态包沙箱，也**没有 Client RPC 桥**，
所以 `client.js` 的对话卡片在这条路径下不可用；`harness.handle` 注册的处理器会挂在
`require('mahjong-harness-dsh-plugin').handlers` 上供宿主直接调用。

---

## 独立回放器

```bash
python3 -m harness.serve_logs          # 默认 127.0.0.1:8765
```

- `http://localhost:8765/index.html` — 拖放导出的 `.mjai`
- `http://localhost:8765/view/<sessionId>` — 直接看某一局
- 也可直接浏览器打开 `dsh-plugin/log-viewer/index.html`

## 故障排查

| 问题 | 检查 |
|------|------|
| `cordis_define` 报语法错 | 用 `node dsh-plugin/print-register.mjs` 的输出去贴，别手抄 |
| `cordis_run` 后工具没出现 | 查看 fiber 是否停在 pending：`inject` 需要 `subprocess` / `timer` / `tools` 三个服务都在 |
| 工具报「无法确定仓库路径」 | 会话 cwd 不在仓库：给 `mahjong_start` 传 `workspace=` |
| worker 启动失败 | `config.python` 是否正确；`Mortal/mortal/libriichi.so` 是否存在；`bash setup.sh` |
| libriichi 导入失败 | `PYTHONPATH` 未含 `Mortal/mortal/`；`host.js` 会自动带上，手动跑时需自行设置 |
| 卡片不更新 | worker 是否崩溃？`host.js` 最多自动重启 5 次；可先 `mahjong_status` 看 `error` |
| 真实 LLM 不工作 | DSH credentials 中需有 `namespace=mahjong, name=LLM_API_KEY`；没有就用 `mock=true` |
| 端口被占 | `config.viewerPort` 换一个；`host.js` 会在 viewer 退出后最多重启 3 次 |

## 凭据配置

优先级：

1. DSH `credentials.resolve({ namespace: 'mahjong', name: 'LLM_API_KEY' })`
   —— 返回 `{ value, source }`，`host.js` 会取 `.value`
2. 都没有则 apiKey 传空字符串，规则引擎兜底

默认模型：`deepseek-ai/DeepSeek-V4-Flash`
默认 Base URL：`https://api.siliconflow.cn/v1`（**不是**工具入参，模型无法改写）

## 自动化验收

| 命令 | 覆盖 |
| --- | --- |
| `node dsh-plugin/test_plugin.js` | 静态结构 + 沙箱禁用 API 检查 |
| `node dsh-plugin/test_client_card.js` | 真实 React SSR：首屏仅紧凑卡、展开才加载 iframe、slot props 契约 |
| `node dsh-plugin/test_dynamic_runner.js` | **真实 `DynamicCordisRunnerService`**：`define` → `run`（真实沙箱 + 声明式 inject 守卫）→ 零 config 开局 → `stop` 后工具注销、子进程回收、端口释放 |
| `node dsh-plugin/test_host_contract.js` | 真实 cordis + `ToolRuntime` + `subprocess-local` + worker + viewer：四工具注册、卡片载荷、iframe/事件 API、取消时延、卸载清理 |
| `bash verify.sh` | 上面全部 + Python 规则引擎/协议/回放安全 |
