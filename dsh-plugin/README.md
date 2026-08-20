# DSH Cordis 插件：dsh-mahjong-runtime-live-card

本目录是 DSH 动态插件 `mjai-1` 的完整源码。换电脑接手时按下面步骤重新注册即可恢复「对话内麻将卡片」能力。

## 文件

- `host.js` —— Host 半区：自动探测 `WORKSPACE` / Python venv，拉起 `harness.worker`（JSONL），注册 4 个工具，worker 崩溃后最多自动重启 5 次并把进行中 session 标为 `failed`。
- `client.js` —— Client 半区：对话内紧凑卡片（约 360–520px），1.2s 轮询；「展开牌桌」打开详情层（事件列表 + 660px 横滑提示），**不自动全屏**。
- `log-viewer/` —— 完整 MJAI 回放器（与 `Mortal/log-viewer` 同步），本地打开 `index.html` 或由详情容器加载；`window.MJAIStudio.loadEvents(events)`。
- `define-meta.json` —— 当时 `cordis_define` 的元信息。

## 路径探测（无需再手改死路径）

`host.js` 按顺序探测：

1. 环境变量 `DSH_MAHJONG_WORKSPACE` / `DSH_MAHJONG_PYTHON`
2. `process.cwd()`、插件相对上级目录
3. 旧机器硬编码路径（兼容）

只要目录下存在 `harness/worker.py` 即视为有效 workspace。仍可用环境变量强制指定。

## 重新接入

1. `cordis_define`：code.host ← `host.js`，code.client ← `client.js`
2. `cordis_run` → 用户批准
3. `Tool.listTools` 应出现 `mahjong_start / mahjong_status / mahjong_cancel / mahjong_export`

## 工具行为

- `mahjong_start` → 对话卡片；Client 以 callId 关联 session，轮询 `mahjong.status`
- 卡片不自动全屏/切路由；「展开牌桌」为用户显式操作
- API key 仅经 DSH `credentials`（namespace `mahjong` / name `LLM_API_KEY`）注入 worker

## 许可

`log-viewer` 与 Mortal/libriichi 相关代码受 **AGPL-3.0-or-later** 约束。对外分发前请完成许可证审查。
