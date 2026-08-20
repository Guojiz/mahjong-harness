# 新电脑接手说明（mahjong-harness → DSH）

> 生成时间：本仓库推送时。旧机器已不可用，此文件 + 仓库内容应足以在新机器恢复全部工作。
> 上游需求与验收标准见 `DSH_日本麻将内嵌开发接手卡.md`（仓库根目录，勿删除）。

## 1. 仓库内容速览

```text
harness/worker.py                 ★ 新增：长期 JSONL worker（协议见接手卡 §4.2）
harness/engines.py                mjai-log 引擎接口与规则陪练（原有）
harness/llm_engine.py             OpenAI-compatible 客户端、动作解析、规则校验、兜底（原有）
harness/run_game.py               单局/批量对局 CLI（原有）
harness/eval.py                   固定 seed benchmark（原有）
harness/smoke_llm.py              单次真实 LLM 冒烟（原有，读取 ~/.dsh/.credentials.yaml）
harness/test_worker_protocol.py   ★ 新增：worker 协议单元测试（不启动 Rust arena）
harness/run_test.py               纯规则引擎冒烟（原有）
Mortal/                           libriichi 规则引擎源码 + log-viewer 回放器（AGPL-3.0）
Mortal/mortal/libriichi.pyd       Windows 规则引擎扩展（本地构建，未入库）
Mortal/log-viewer/                独立 MJAI 回放器（window.MJAIStudio.loadEvents(events)）
handoff/plugin-host.js            ★ 新增：DSH 动态插件 Host half 源码（pkg-3）
handoff/plugin-client.js          ★ 新增：DSH 动态插件 Client half 源码（pkg-3）
output/                           桌面/移动端 UI 验收截图
DSH_日本麻将内嵌开发接手卡.md      需求、协议、硬约束、验收标准
```

## 2. 本地环境准备（新电脑）

1. 安装 Python 3.10+ 并创建虚拟环境：
   ```powershell
   cd <repo>
   python -m venv Mortal\.venv
   Mortal\.venv\Scripts\python.exe -m pip install -r Mortal\environment.yml  # 或按 Mortal 文档
   ```
2. 构建/获取 `libriichi.pyd` 到 `Mortal/mortal/`：
   - 本机构建见 `Mortal/docs/src/user/build.md`；
   - 或从旧机器复制编译产物（未入库，需手动）。
3. 配置凭据（worker 不读 .env，插件从 DSH `credentials` 服务解析）：
   - DSH 凭据：`credentials.resolve({ namespace: 'mahjong', name: 'LLM_API_KEY' })`
   - 或根目录 `.env`：`LLM_API_KEY=...`（`run_game.py` 会读取；`.env` 不入库）
   - 默认模型 `deepseek-ai/DeepSeek-V4-Flash`，Base URL `https://api.siliconflow.cn/v1`
4. 验证：
   ```powershell
   $env:PYTHONDONTWRITEBYTECODE='1'
   .\Mortal\.venv\Scripts\python.exe -m unittest harness.test_worker_protocol -v
   .\Mortal\.venv\Scripts\python.exe -m harness.run_game --seed 7 --count 1 --mock --budget 0
   .\Mortal\.venv\Scripts\python.exe -m harness.eval --seeds 7,8,9 --mock --log-dir logs
   ```

## 3. DSH 动态插件（重要：进程重启后需重新定义）

`mjai-1/pkg-3`（dsh-mahjong-runtime-live-card）是**会话内动态 Cordis 插件**：
定义与运行状态**不持久**，DSH 进程重启后需在新会话中重新 `cordis_define` + `cordis_run`。

- Host 源码：`handoff/plugin-host.js`（内含常量 `WORKSPACE`/`PYTHON`，按新机器路径修改）
- Client 源码：`handoff/plugin-client.js`

重新接入步骤（任一会话中，使用 cordis 工具）：
1. `cordis_define` kind=new，idPrefix=`mjai`，name=`dsh-mahjong-runtime`，code.host 取 `plugin-host.js`，code.client 取 `plugin-client.js`
2. `cordis_run` 激活 → 等待用户批准
3. 确认 `Tool.listTools` 出现 `mahjong_start / mahjong_status / mahjong_cancel / mahjong_export`

工具行为：
- `mahjong_start` 返回卡片状态；Client 以 `callId → mj-<callId>` 关联 session 并轮询 `host.call('mahjong.status')`
- 卡片为对话区内紧凑卡片，不自动全屏/切路由；"展开牌桌" 为卡片内详情，未接入完整 log-viewer
- API key 只经 DSH `credentials` 注入 worker，不进前端/牌谱/stdout

## 4. 当前进度（推送时）

已完成并验证：
- 长期 JSONL worker（start/status/cancel/export + mjai/decision/session 事件 + seq）
- 四个 dsh 工具注册 + 紧凑卡片 + 运行中 session 关联 + 显式导出
- 固定 seed 可复现：seeds 7,8,9 → 12 半庄，顺位 3/3/3/3，违规 0，两次一致
- 非法动作拦截：mock noise=1.0 → 840/840 被 `validate_reaction()` 拦截并兜底
- 协议单测 3/3 通过；牌面 40 SVG、无旧素材引用、30×40 / 90° / 660px 约束在案

未完成（接手卡验收项）：
- 完整 `Mortal/log-viewer` 详情层接入 DSH（受详情 Slot 约束，需确认宿主提供独立容器）
- 真实 SiliconFlow LLM 对局（需凭据 + budget）
- DSH 真实长驻 worker 事件流 / 取消中的网络请求 / worker 崩溃恢复
- AGPL 许可与发布审查

## 5. 禁止事项

- 不提交 `.env`、API key、用户私有对局日志（.gitignore 已覆盖）
- `legacy-assets/mj-king-images/` 不进入发布包（本仓库已忽略）
- 不修改 DSH 安装目录下的 `agent-presets/`（升级会覆盖）
