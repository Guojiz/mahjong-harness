# mahjong-harness

DeepSeek Harness 内嵌日本麻将运行时：对话内实时卡片、MJAI 导出，以及 Mortal/libriichi worker。

<p align="center">
  <a href="https://guojiz.github.io/"><img alt="官网" src="https://img.shields.io/badge/官网-guojiz.github.io-111111?style=flat-square"></a>
  <a href="https://github.com/Guojiz/Sponsors"><img alt="赞助" src="https://img.shields.io/badge/赞助-支持-111111?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://guojiz.github.io/"><strong>作者官网</strong></a>
  · <a href="https://x.com/guojizh">X</a>
  · <a href="https://space.bilibili.com/3493114115263006">哔哩哔哩</a>
  · <a href="https://youtube.com/@guojizh">YouTube</a>
  · <a href="https://github.com/Guojiz/Sponsors">赞助</a>
</p>

本仓库目前没有独立产品站。源码、DSH 插件和接手说明都在 GitHub。

- 插件源码：[dsh-plugin/README.md](dsh-plugin/README.md)
- 回放器：`dsh-plugin/log-viewer/`（及 submodule `Mortal/log-viewer`）
- 接手卡：`DSH_日本麻将内嵌开发接手卡.md`
- 子模块：`Mortal`（需 `git submodule update --init`）

## 工具

插件注册四个工具：`mahjong_start` / `mahjong_status` / `mahjong_cancel` / `mahjong_export`。

DSH 动态包沙箱里没有 `process` / `fs` / `path`，且 `cordis_run` 不向插件传任何 config，所以仓库路径按此顺序解析：

1. `mahjong_start` 的显式 `workspace` 参数；
2. profile 安装路径的 `config.workspace`；
3. 调用会话的 cwd（`exec.agent.session.header.cwd`）——**在仓库目录里启动 DSH 就什么都不用配**；
4. 第一个已注册 workspace。

会话 cwd 不在仓库时：`mahjong_start workspace="/绝对路径/mahjong-harness" seed=7 mock=true`。

同时准备好 `Mortal/mortal/libriichi.so`（macOS/Linux）或 `libriichi.pyd`（Windows）——`bash setup.sh` 会构建它。
`python` / `viewerPort` / `model` 同样可作为 `mahjong_start` 参数；`viewerHost` / `baseUrl` 仅 profile config（刻意不让对话改写）。

## 快速安装（macOS / Linux）

```bash
# 一键构建 libriichi + 验证环境
bash setup.sh

# 运行全部验证测试
bash verify.sh
```

### 手动步骤

1. 构建 libriichi：
   ```bash
   cd Mortal && cargo build -p libriichi --lib --release
   cp target/release/libriichi.dylib mortal/libriichi.so   # macOS
   # cp target/release/libriichi.so mortal/libriichi.so     # Linux
   ```

2. 设置 PYTHONPATH：
   ```bash
   export PYTHONPATH="$(pwd)/Mortal/mortal:$(pwd)"
   ```

3. 运行测试：
   ```bash
   python3 -m unittest harness.test_worker_protocol harness.test_worker_crash \
     harness.test_serve_logs harness.test_llm_client -v
   python3 -m harness.run_game --seed 7 --count 1 --mock
   python3 -m harness.eval --seeds 7,8,9 --mock
   ```

## 当前测试状态

| 测试项 | 状态 | 说明 |
|--------|------|------|
| libriichi 构建 (macOS arm64) | ✓ 通过 | Rust 1.97.1, Python 3.14.6 |
| 协议、回放与流式客户端单测 (14/14) | ✓ 通过 | worker 隔离、取消、状态文件、SSE、超时与注入防护 |
| 规则引擎冒烟 | ✓ 通过 | OneVsThree arena |
| Mock 固定 seed (seeds 7,8,9) | ✓ 通过 | 12 半庄, 顺位 3/3/3/3, 违规 0 |
| 非法动作拦截 (noise=1.0) | ✓ 通过 | 840/840 被 validate_reaction() 拦截 |
| DSH 插件语法 + 沙箱禁令 | ✓ 通过 | host.js + client.js 语法，且不引用 `require`/`process`/`setTimeout`/`fetch` |
| DSH 客户端卡片 (真实 React SSR) | ✓ 通过 | 11/11：首屏仅紧凑卡、iframe 按需加载、`argsRaw`/运行态/失败态 slot props |
| DSH 宿主级集成 | ✓ 通过 | 17/17：真实 cordis + ToolRuntime 四工具注册、卡片载荷、viewer iframe/事件 API、取消时延、卸载清理 |
| CC0 牌面素材 | ✓ 通过 | 40 SVG, 无旧素材引用 |
| SiliconFlow 真实冒烟 | ✓ 历史实测 | DeepSeek-V4-Flash 合法动作通过 `validate_reaction()`；默认验收不重复调用付费/限速 API |
| 真实 DSH 会话内注册 | ○ 需人工 | 在 DSH 会话里 `cordis_define` + `cordis_run` 并肉眼确认卡片（注册步骤见 `dsh-plugin/REGISTER.md`） |

### DSH 插件测试

```bash
node dsh-plugin/test_plugin.js         # 静态结构 + 沙箱禁用 API
node dsh-plugin/test_client_card.js    # 真实 React SSR：紧凑卡 / 展开 iframe / slot props
node dsh-plugin/test_host_contract.js  # 真实 cordis + ToolRuntime + subprocess-local + worker + viewer
```

`test_host_contract.js` 需要机器上装有 DSH 运行时（自动探测 `/opt/homebrew`、`/usr/local`、`~/.npm-global`，
可用 `DSH_MAHJONG_DSH_ROOT` 覆盖；`SKIP_PARITY=1` 跳过与真实 `subprocess-local` 的句柄契约对照）。

生成 `cordis_define` 载荷：

```bash
node dsh-plugin/print-register.mjs --summary   # 大小 + 契约自检
node dsh-plugin/print-register.mjs --out /tmp/mahjong-plugin.json
```

实时 API 冒烟为显式启用项：

```bash
RUN_SILICONFLOW_SMOKE=1 bash verify.sh
```

这会从 DSH 凭据文件读取配置并产生一次真实 SiliconFlow 调用；密钥不会写入输出、日志或导出文件。


## 官网与其它推广

这个仓库可以没有独立产品站。对外入口是作者官网、本 GitHub 仓库，以及下面这些项目。

| | |
| --- | --- |
| **作者官网** | https://guojiz.github.io/ |
| **X** | https://x.com/guojizh |
| **哔哩哔哩** | https://space.bilibili.com/3493114115263006 |
| **YouTube** | https://youtube.com/@guojizh |
| **赞助** | https://github.com/Guojiz/Sponsors |

### 其它开源项目

- [GitLearnOS](https://guojiz.github.io/gitlearnos/) — 学习者拥有的 Git 记忆
- [Word Snap](https://guojiz.github.io/word-snap/) — 双语单词匹配
- [AI Subtitle Extractor](https://github.com/Guojiz/ai-subtitle-extractor)
- [Design Master](https://github.com/Guojiz/design-master)
- [AI Video Studio](https://github.com/Guojiz/comfyui-minimax-h3-studio)
- [llm-provider-compat](https://github.com/Guojiz/llm-provider-compat)
- [Claude Desktop Tweak Models](https://github.com/Guojiz/claude-desktop-tweak-models)
- 全部项目：[github.com/Guojiz](https://github.com/Guojiz)
