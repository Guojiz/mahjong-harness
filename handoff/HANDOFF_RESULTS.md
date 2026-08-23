# 接手结果报告

> 更新：2026-08-23 · macOS arm64 · Python 3.14.6 · Node 26.7.0

## 当前验收

以下结果来自本机当前工作树，命令均以真实退出码判定，失败不会被 `|| true` 吞掉：

- `git diff --check`：通过
- host/client JavaScript 语法与 shell 语法：通过
- Python 协议、崩溃、状态、回放安全和流式客户端：14/14 通过
- DSH 插件静态结构检查：通过
- `bash verify.sh`：16 通过、0 失败、1 跳过，exit 0；跳过项是默认关闭的实时 API 请求

`verify.sh` 覆盖 libriichi 导入、规则引擎、固定 seed mock 对局、三组 seed 评测、非法动作拦截、插件结构、牌面素材和快照安全。SiliconFlow 冒烟必须显式设置 `RUN_SILICONFLOW_SMOKE=1`，以免普通验收意外产生真实调用。

## 已完成

- macOS/Linux `setup.sh`：构建 libriichi 并验证环境；编译产物留在私有 Mortal 子模块工作区，不伪装成父仓库文件。
- 长驻 Python worker：会话隔离、状态查询、取消、导出、崩溃状态和无密钥快照。
- 对话卡：紧凑牌桌、比分/动作/统计、轮询、主动展开完整回放，不自动抢占全屏。
- 本地回放服务：仅 loopback 绑定、合法 session id、事件和状态文件、HTML 注入防护、增量轮询。
- LLM 客户端：SiliconFlow/OpenAI-compatible SSE、推理块过滤、总时限、短读超时和取消事件。
- 对局展示流只发布第一桌完整 MJAI，包含 `end_kyoku` / `end_game`，避免四桌事件混流。

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

## 尚待 DSH 宿主验收

以下不能用静态检查代替，发布时不得宣称已完成：

1. 在 DSH 会话内执行 `cordis_define`、`cordis_run`，并由 `Tool.listTools` 确认四个工具。
2. 实际调用 `mahjong_start`，确认首屏只出现紧凑卡片、聊天仍可输入。
3. 用户点击“展开牌桌”后确认 iframe 可加载，关闭后回到原对话位置。
4. 真机检查插件卸载后的 worker/viewer 清理、端口占用提示和取消时延。

注册步骤见 `dsh-plugin/REGISTER.md`。

## 新机器

```bash
git clone --recurse-submodules https://github.com/Guojiz/mahjong-harness.git
cd mahjong-harness
bash setup.sh
bash verify.sh
```

父仓库只记录 Mortal 子模块提交。`Mortal/mortal/libriichi.so` 和 `Mortal/target/` 不会随父仓库提交；新机器必须运行 `setup.sh` 构建。
