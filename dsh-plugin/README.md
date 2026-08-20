# DSH Cordis 插件：dsh-mahjong-runtime-live-card

本目录是 DSH 动态插件 `mjai-1` 最终版本（pkg-3）的完整源码，从会话日志
`session-f3e3ac58` 的 `cordis_define` 调用中原样提取。换电脑接手时按下面步骤重新注册即可恢复
"对话内麻将卡片"能力。

## 文件

- `host.js` —— 插件 Host 半区（Node.js 侧）：用 `ctx.subprocess` 常驻拉起
  `harness.worker`（JSONL stdio 协议），注册 4 个工具
  （`mahjong_start` / `mahjong_status` / `mahjong_cancel` / `mahjong_export`），
  API key 通过 DSH `credentials` 服务解析，绝不进入前端/日志/导出。
- `client.js` —— 插件 Client 半区（浏览器侧，无 JSX）：注册
  `tool.call.toolview` 槽位 key `mahjong_start`，渲染紧凑对话卡片
  （状态/四家分数/最近事件/事件计数/“展开牌桌”与“导出 MJAI”按钮），
  1.2s 轮询刷新；详情面板展示 session 状态与最近 60 条事件。
- `define-meta.json` —— 当时 `cordis_define` 的元信息（pluginId / name / purpose）。

## ⚠️ 换电脑必改：硬编码路径

`host.js` 第 1–2 行：

```js
const WORKSPACE = 'C:/Users/Administrator/WorkBuddy/2026-08-18-15-00-32/mahjong-harness';
const PYTHON = WORKSPACE + '/Mortal/.venv/Scripts/python.exe';
```

新电脑上必须把 `WORKSPACE` 改成本仓库 clone 后的绝对路径，且
`Mortal/.venv`（装好 libriichi 的 Python 虚拟环境）必须先就位，否则 worker 拉不起来。

## 重新注册步骤（新电脑）

1. 准备依赖：clone 本仓库 + `git submodule update --init`（Mortal/libriichi），
   并在 `Mortal/` 下建好含 libriichi 的 `.venv`。
2. 修改 `host.js` 的 `WORKSPACE` 路径。
3. 在 DSH 会话中执行 `cordis_define`，参数结构（源码读自本目录两个文件）：

```json
{
  "plugin": { "kind": "existing", "pluginId": "mjai-1" },
  "name": "dsh-mahjong-runtime-live-card",
  "purpose": "保留麻将 worker 与工具 Host 能力，并提供可实时关联 session 的紧凑卡片和显式 MJAI 导出。",
  "code": { "host": "<host.js 全文>", "client": "<client.js 全文>" }
}
```

   （若 `mjai-1` 插件不存在，`plugin` 改为 `{ "kind": "new" }` 或按 DSH 当时语法创建。）
4. 运行：`cordis_run`，参数 `{ "pluginId": "mjai-1", "mode": "update" }`。
5. 验证：工具列表出现 4 个 mahjong 工具；发起 `mahjong_start` 后对话内出现卡片并可轮询刷新。

## 架构备忘（与 handoff 卡一致）

- Host 与 Client 是**同一 Package 的两半**，`cordis_update` 会同时替换两半；
  只传 client 会把 Host 冲掉（pkg-2 的教训，工具全部消失）。
- worker 协议：单常驻 Python 进程，stdin 每行一个 JSON 请求（带唯一 `id`），
  stdout 每行一个 JSON 帧；`event: "session" | "mjai" | "decision"` 广播帧无 `id`，
  按帧内 `sessionId` 归属到对应会话。
- worker 退出时 Host 把所有未结束 session 标记 `failed + '麻将 worker 已退出'`。

## 未完成事项（接手后继续）

- “展开牌桌”完整回放：计划把 `Mortal/log-viewer`（SVG 牌面回放器，已在本仓库
  submodule 分支 `dsh-log-viewer` 中版本化）经 `webServer.register()` 前缀路由接入
  详情层 —— 原 pkg-4 方案未实施。
- 真实 LLM（SiliconFlow）全流程对局验证、worker 崩溃恢复测试、
  接手卡 §8 验收清单逐项过。
