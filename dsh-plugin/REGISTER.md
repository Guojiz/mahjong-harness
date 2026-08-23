# DSH 插件注册与运行说明

## 自动安装

```bash
# 在仓库根目录运行
bash setup.sh
```

这会构建 libriichi、验证 Python 环境并运行协议测试。

## 在 DSH 中注册插件

DSH 插件是**会话内动态插件**，DSH 进程重启后需重新注册。

### 步骤 1：定义插件

使用 DSH 的 `cordis_define` 工具（在任意 DSH 会话中）：

```
cordis_define
  kind: new
  idPrefix: mjai
  name: dsh-mahjong-runtime-live-card
  code.host: 粘贴 dsh-plugin/host.js 的完整内容
  code.client: 粘贴 dsh-plugin/client.js 的完整内容
```

> **重要**：`host.js` 会自动探测 workspace 和 Python 路径。如果需要覆盖，在 DSH 环境中设置环境变量：
> - `DSH_MAHJONG_WORKSPACE`：指向包含 `harness/worker.py` 的仓库根目录
> - `DSH_MAHJONG_PYTHON`：指向 Python 可执行文件（默认自动探测 `Mortal/.venv/bin/python` 或系统 `python3`）
> - `DSH_MAHJONG_BASE_URL`：管理员级 provider 覆盖；默认固定为 `https://api.siliconflow.cn/v1`，对话工具不能改写

### 步骤 2：激活插件

```
cordis_run pluginId=mjai-1
```

需要用户批准后激活。

### 步骤 3：验证工具

```
Tool.listTools
```

应出现四个工具：
- `mahjong_start` — 开始一局日本麻将
- `mahjong_status` — 查询对局状态
- `mahjong_cancel` — 取消运行中的对局
- `mahjong_export` — 导出 MJAI 事件和统计

## 快速测试

注册后，在 DSH 对话中输入：

```
开始一局日本麻将
```

或直接调用：

```
mahjong_start seed=7 mock=true
```

预期结果：
- 对话区出现紧凑麻将卡片（不自动全屏）
- 卡片显示状态、比分、最近动作
- 点击「展开牌桌」查看详情（内联紧凑牌桌 + 事件列表）
- 对局完成后可「导出 MJAI」

## 独立回放器

完整 660px 牌桌回放器：
1. 启动日志服务器：`python3 -m harness.serve_logs`
2. 浏览器打开 `http://localhost:8765/index.html`
3. 拖放导出的 `.mjai` 文件或访问 `http://localhost:8765/view/<sessionId>`

或直接浏览器打开：`dsh-plugin/log-viewer/index.html`

## 故障排查

| 问题 | 检查 |
|------|------|
| worker 启动失败 | `host.js` 日志中的 workspace/python 路径；确认 `Mortal/mortal/libriichi.so` 存在 |
| libriichi 导入失败 | `PYTHONPATH` 未包含 `Mortal/mortal/`；运行 `bash setup.sh` 重新构建 |
| 工具不出现 | 确认 `cordis_run` 已执行且批准；检查 `cordis_define` 的 idPrefix |
| 卡片不更新 | worker 是否崩溃？检查 `host.js` 最多自动重启 5 次 |
| 真实 LLM 不工作 | DSH credentials 中需有 `namespace=mahjong, name=LLM_API_KEY` 或环境变量 `LLM_API_KEY` |

## 凭据配置

API key 可通过以下任一方式提供（优先级从高到低）：
1. DSH `credentials.resolve({ namespace: 'mahjong', name: 'LLM_API_KEY' })`
2. 环境变量 `LLM_API_KEY`

默认模型：`deepseek-ai/DeepSeek-V4-Flash`
默认 Base URL：`https://api.siliconflow.cn/v1`
