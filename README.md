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

换电脑时优先设置环境变量 `DSH_MAHJONG_WORKSPACE`（可选），`host.js` 会自动探测含 `harness/worker.py` 的目录；并准备好 `Mortal/.venv` + `libriichi.pyd`。


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
