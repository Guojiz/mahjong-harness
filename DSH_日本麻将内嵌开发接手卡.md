# DSH 日本麻将插件接手卡

> 交付目标：将现有 `mahjong-harness` 的规则引擎、LLM 桥和 MJAI UI 作为 **dsh 插件**接入。保留现有前端与 Python 代码的有效部分；首次开始对局时只在 dsh 对话区显示紧凑牌桌卡片，**不得自动抢占全屏或跳转独立页面**。
>
> 当前状态：规则/LLM/评测和独立 MJAI 回放 UI 已存在；尚未接入 dsh。临时编写的 `harness/web.py`、`harness/play.html` 和 URL 自动加载已撤销，不能以它们作为接手基础。

## 1. 最终用户体验

用户在 dsh 对话中提出“开始一局日本麻将”后：

1. 插件启动一局固定 seed 或用户指定 seed 的对局。
2. 对话流中出现一个紧凑的“日本麻将对局”卡片，尺寸与普通工具结果/对话内容相称。
3. 卡片显示当前局、比分、最近动作、运行状态和一个不缩放的紧凑牌桌预览。
4. **首次启动不自动全屏、不自动切换工作台路由、不覆盖对话历史。**
5. 用户主动点击“展开牌桌”后，才允许打开 dsh 现有的侧栏、抽屉、详情页或全屏工作区，具体选择服从 dsh 已有 UI 范式。
6. 对局完成后，卡片给出结果、违规/兜底统计，以及“查看完整牌谱”“导出 MJAI”的显式操作。

产品原则：先保留对话的连续性，再提供沉浸式回放。牌桌详情是用户主动进入的第二层，不是第一次 Tool 调用的默认界面。

## 2. 现有代码资产

项目根目录：

```text
C:/Users/Administrator/WorkBuddy/2026-08-18-15-00-32/mahjong-harness/
```

```text
harness/engines.py                 mjai-log 引擎接口与规则陪练
harness/render.py                  安全地把 mjai 状态渲染为 LLM 可读局面
harness/llm_engine.py              OpenAI-compatible 客户端、动作解析、规则校验、兜底
harness/run_game.py                可运行的单局/批量对局 CLI
harness/eval.py                    固定 seed benchmark
Mortal/mortal/libriichi.pyd        Windows Python 规则引擎扩展
Mortal/log-viewer/index.html       独立 MJAI 回放器页面原型
Mortal/log-viewer/app.js           mjai reducer、回放、牌面映射
Mortal/log-viewer/app.css          牌桌几何、方向和响应式约束
Mortal/log-viewer/files/tiles/     Public Domain/CC0 SVG 牌面与许可证
legacy-assets/mj-king-images/      旧素材备份，禁止进入插件发布包
output/                            桌面和移动端的 UI 验收截图
```

现有 UI 提供：

```js
window.MJAIStudio.loadEvents(events)
```

插件可将其用于 WebView/iframe 内的完整牌谱详情页；对话区卡片不应每次加载完整静态回放器，而应复用同一 reducer 或以精简的 MJAI 状态投影渲染预览。

## 3. 规则与对局事实

- `libriichi` 是唯一权威规则层，负责合法动作、立直、振听、鸣牌、和牌与算分。
- `LLMEngine` 经 `MjaiLogBatchAgent` 接收局面与事件，返回 mjai JSON 动作。
- 每个 LLM 动作都必须通过 `state.validate_reaction()`；非法动作不能进入牌局。
- 模型超时、断连、无效 JSON 或预算耗尽时使用规则引擎兜底，并记录原因。
- `run_game.py` 已支持固定 seed、mock、调用预算、超时、重试，以及 SiliconFlow OpenAI-compatible API。
- 默认模型：`deepseek-ai/DeepSeek-V4-Flash`。
- 默认 SiliconFlow Base URL：`https://api.siliconflow.cn/v1`。
- 不调用 `state.brief_info()`，它在部分局面可能触发 Rust panic；继续使用 `harness/render.py` 的安全读取方式。

## 4. dsh 插件架构

```text
dsh 对话 / Tool 调用
  │
  ├─ 紧凑对话卡片：状态、比分、最近事件、简化牌桌、展开按钮
  ├─ 可选完整详情：侧栏/抽屉/路由/全屏（用户主动触发）
  │
  ▼
Mahjong Cordis 插件 / service
  ├─ 注册 Tool 与 UI 卡片
  ├─ 读取 dsh secret/config
  ├─ 管理 Python worker 生命周期
  ├─ 推送 mjai、decision、session 状态事件
  └─ 保存、导出和恢复牌局
  │
  ▼
长期 Python worker
  ├─ libriichi authoritative rules
  ├─ LLMEngine / RuleEngine
  ├─ session 状态与 mjai 日志
  └─ fixed-seed benchmark
  │
  ▼
SiliconFlow OpenAI-compatible API
```

### 4.1 插件职责

1. 使用 dsh 已有 Cordis/service 注册方式提供麻将能力。
2. 按 dsh 已有子进程监管模式启动一个长期 Python worker，不要每一步都重启 Python。
3. 从 dsh secret/config 注入 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`，不把 API key 写进前端、日志、牌谱或 stdout。
4. 每局使用 `sessionId` 隔离状态、日志和取消令牌。
5. 将 worker 事件转成 dsh 前端可消费的增量状态；对话卡只接收当前状态投影，完整详情接收或拉取完整 mjai 事件。
6. 插件停用、dsh 退出或 worker 崩溃时清理 session，提供明确失败状态与 stderr 摘要。

### 4.2 Python worker 协议

以一行一个 JSON 的 stdio 协议通信。stdout 只能写协议 JSON，调试日志写 stderr。

请求：

```json
{"id":"req-1","method":"session.start","params":{"sessionId":"s1","seed":7,"model":"deepseek-ai/DeepSeek-V4-Flash"}}
{"id":"req-2","method":"session.continue","params":{"sessionId":"s1"}}
{"id":"req-3","method":"session.cancel","params":{"sessionId":"s1"}}
```

主动事件：

```json
{"event":"mjai","sessionId":"s1","seq":42,"data":{"type":"dahai","actor":0,"pai":"5m","tsumogiri":false}}
{"event":"decision","sessionId":"s1","seq":43,"data":{"status":"accepted","latencyMs":12340}}
{"event":"session","sessionId":"s1","data":{"status":"ended","scores":[...],"logRef":"..."}}
```

协议要求：

- 每个请求有唯一 `id`，每局有唯一 `sessionId`。
- mjai 事件必须有单调递增 `seq`，前端可去重和断线恢复。
- 取消必须中断后续对局推进和可中断的模型请求。
- API key、完整 prompt 与密钥配置不得出现在任何事件中。

## 5. 对话区卡片硬约束

1. 首次 `mahjong.start` 只渲染在对话流中的紧凑卡片，默认高度约为 360–520px；宽度跟随 dsh 对话内容列，不扩张为浏览器全屏。
2. 卡片需要稳定的内部布局：顶部状态/操作栏，中部紧凑牌桌，底部比分/最近动作/“展开牌桌”。
3. 不要在卡片内强塞完整 660px 牌桌。紧凑预览允许使用专门的固定比例布局，但**不能把单张牌以非等比方式压扁**。
4. 对话卡牌面与文字不可相互覆盖；玩家姓名和分数必须始终正向阅读。
5. 普通牌、立直牌和被鸣牌方向必须符合已有 `0/-90/180/90deg` 座位方向体系；横牌只额外旋转 `90deg`。
6. “展开牌桌”是用户明确操作。展开后才加载完整 `Mortal/log-viewer`，可使用 dsh 支持的详情容器或由插件拥有的本地 WebView/iframe。
7. 用户关闭详情后，返回原对话位置和卡片状态，不中断对局。
8. 移动端对话卡保持可读；完整牌桌在详情层内横向滚动，绝不为了塞进屏幕缩麻将牌。

## 6. UI 与素材硬约束

完整详情页复用 `Mortal/log-viewer/` 时，不得回退以下已验收行为：

1. 牌面只使用 `Mortal/log-viewer/files/tiles/` 中的 Public Domain/CC0 SVG。
2. 正常牌固定 `30×40px`，保持 SVG 原始 3:4 比例；不能因发牌、摸牌或视口改变尺寸。
3. 横牌使用固定槽承载并额外旋转 90°，不能拉伸图片。
4. 四家 HUD 独立于旋转牌区，始终正向，且不遮挡牌河、手牌或副露。
5. 牌河每行最多六张；副露中被鸣牌位置由 `target` 决定。
6. 移动端完整牌桌固定 660px，并在详情容器内横向滚动，页面本身不产生横向溢出。
7. 不重新引入 `legacy-assets/mj-king-images/`。

已验证的完整牌桌复杂局面指标：

```text
hudHits=[]
centerHits=[]
outside=[]
tileCount=75
brokenImages=0
tileSizes={30x40, 40x30}
oldSourceCount=0
```

所有牌面资源：34 种标准牌 + 3 种赤五 + 牌背，共 38/38 返回 SVG HTTP 200。

## 7. 推荐实施顺序

1. 在 dsh 仓库定位 Cordis plugin/service、Tool、对话卡片、详情面板、secret/config 与子进程监管的现有范例。
2. 新建 Python `harness/worker.py`，从 `run_game.py` 提取 session 生命周期，不使用 CLI 拼接作为插件协议。
3. 先通过 Tool 完成 `session.start`、`session.status`、`session.cancel` 和单个 `mjai` 事件的端到端传输。
4. 实现对话区紧凑卡片：先显示状态、比分、最近动作和“展开牌桌”，验证不影响普通聊天布局。
5. 接入紧凑牌桌预览与实时事件更新。
6. 把现有 `Mortal/log-viewer` 接入详情层，加载同一个 session 的完整事件流。
7. 增加固定 seed、模型、预算和日志导出操作。
8. 最后运行真实 SiliconFlow 对局，并补齐异常、取消、重连和 worker 崩溃测试。

## 8. 验收标准

### 对话体验

- [ ] 用户从 dsh 对话发起对局后，首屏只出现对话区内麻将卡，不跳全屏、不抢占工作台、不清空或遮盖对话历史。
- [ ] 卡片高度、宽度稳定；聊天滚动、继续输入和其他 Tool 不受影响。
- [ ] 卡片有运行状态、比分、最近动作和“展开牌桌”。
- [ ] 只有点击“展开牌桌”后才打开完整详情视图。
- [ ] 关闭详情后回到原对话卡，牌局继续或结果仍可见。

### 引擎与安全

- [ ] dsh Tool 可创建、查询、取消并导出 `sessionId` 对应的牌局。
- [ ] Python worker 生命周期由插件监管，崩溃后有可见失败状态。
- [ ] `state.validate_reaction()` 实际生效，非法 LLM 动作无法进入牌局。
- [ ] 固定 seed 可复现；模型失败时有规则兜底和可见统计。
- [ ] API key 不出现在前端、日志、牌谱、stdout 或导出文件中。

### 完整牌桌

- [ ] 38 种 CC0 牌面均可加载，且没有旧素材引用。
- [ ] 桌面复杂局面 HUD、中心、手牌、牌河和副露零重叠。
- [ ] 正常牌尺寸固定 `30×40`，旋转座位只出现 `40×30`，无变形。
- [ ] 390px 移动视口下完整牌桌容器可横向滚动，页面本身无横向溢出。

## 9. 许可与发布边界

- Mortal/libriichi 使用 AGPL-3.0-or-later。对外分发插件前必须完成许可证与源码义务审查；不要假设 Python 子进程自动规避 AGPL。
- 牌面 SVG 为 Public Domain/CC0，许可证位于 `Mortal/log-viewer/files/tiles/LICENSE.md`。
- 旧 `legacy-assets/mj-king-images/` 不进入插件发布包。
- 不提交 `.env`、API key、调试牌谱或用户私有对局日志。

## 10. 完成定义

只有以下全部达成，才能称为 dsh 日本麻将插件成品：

- [ ] dsh 中存在正式插件入口与对话区麻将卡。
- [ ] 首次开始对局不自动全屏，只占据对话内容区。
- [ ] 用户可主动展开完整牌桌，并返回对话继续操作。
- [ ] Python/libriichi/LLMEngine 的真实规则与决策链路可运行。
- [ ] mock、固定 seed 与有限 budget 的真实 LLM 对局都已验证。
- [ ] 非法动作、超时、取消、worker 崩溃和恢复都有测试。
- [ ] 完整 UI 保持固定牌尺寸、方向、HUD 和移动端约束。
- [ ] 许可证、素材与密钥处理通过发布审查。
