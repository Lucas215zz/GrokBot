# Grok Bot 项目进度

> 最后更新：2026-10-29
> 用途：新开对话时，先读这一份即可接上进度。

---

## 一、这个项目是什么

目标：做一个类似官方 Grok Bot 的 **多 Bot Agent 平台**——可创建多个机器人，
每个 Bot 有独立工作目录、会话和工具权限，能干真实工作（读写文件、执行命令），
支持技能、MCP、Bot 协作、定时任务。

**执行环境抽象为「计算机」**：现在跑在本机，接口已为云计算机预留。

### 走过的弯路（重要，别再重复）

| 尝试 | 结果 | 教训 |
| --- | --- | --- |
| 1. 把官方 app.asar 换成自建聊天界面 | 失败 | 丢失整个多机器人平台 |
| 2. 只改 Base URL 接路由器 | 失败 | 界面不直接调模型，全走后端 RPC |
| 3. 写本地后端冒充 api2.cursor.sh | 部分成功 | 登录能跳过，但卡在沙箱/付费墙；401 个 RPC + 二进制对话格式，成本过高 |
| 4. **自建独立应用（当前方案）** | 成功 | 完全可控，已跑通 |

**关键结论**：官方原版是 Cursor 内核重打包（`@anysphere/*` + `sand`），
登录/推理/沙箱全在云端，本地无法简单改造成中转站。自建是唯一可行路径。

---

## 二、已完成（全部实测验证）

### 1. 核心 Agent 引擎

- `agent/model-client.js` — Responses API 流式 + function calling
- `agent/loop.js` — Agent 循环：模型 → 工具 → 回传 → 继续（最多 25 步）
- `agent/context.js` — 统一构建运行上下文（技能/MCP/留言过滤）

实测：6 步自主完成「列目录 → 读文件 → 命令行验证 → 修编码 → 给结论」。

### 2. 计算机抽象（为云端预留）

```
computer/
  computer.js          接口契约（抽象基类）
  local-computer.js    本机实现（fs + PowerShell，路径沙箱）
  remote-computer.js   云端实现（HTTP 契约，已完整写好）
  factory.js           按配置切换
```

实测：同一套 Agent 在「本机」和「模拟云端」都跑通。
自检：`node scripts/verify-cloud.js`

### 3. Bot 管理

- 创建/编辑/删除 Bot，各自独立工作目录
- 每个 Bot 独立会话、系统提示词、头像
- 数据：`%APPDATA%\Grok Bot\bots\<id>\`

### 4. 工具系统

12 个工具：

| 工具 | 用途 |
| --- | --- |
| `list_files` / `read_file` / `write_file` | 文件读写（限制在工作目录内） |
| `run_command` | 执行 shell（PowerShell 强制 UTF-8、超时强杀） |
| `search_text` | 全文/正则搜索 |
| `browser_navigate` | 浏览器（云端才有） |
| `list_bots` / `delegate_to_bot` / `message_bot` / `start_group_chat` | 协作 |
| `list_skills` / `use_skill` | 技能 |

### 5. 技能（Skills）

- 存放：`%APPDATA%\Grok Bot\skills\<id>\SKILL.md`（Codex 兼容格式）
- **渐进式加载**：清单注入系统提示 → 命中时 `use_skill` 读正文
- **支持导入**：文件夹 / .zip
- **按 Bot 隔离**：`enabledSkills`（空 = 全部）

实测：`use_skill → run_command → write_file → read_file`，严格按技能产出日报。
另测：无素材时模型**拒绝编造**（技能约束生效）。

### 6. MCP

- `mcp/mcp-client.js` — 支持 stdio + http 两种传输
- `mcp/mcp-manager.js` — 多服务器管理、工具聚合
- 工具命名：`mcp__<服务器>__<工具>`

实测：接入 `add_numbers` 服务器，问「1234 + 5678」→ 模型自主调用 → 6912。

### 7. Bot 协作（三种）

| 工具 | 同步性 | 实测结果 |
| --- | --- | --- |
| `delegate_to_bot` | 阻塞等结果 | 代码助手→文档官→拿回周报 |
| `message_bot` | 不阻塞（收件箱） | 撰稿人下次对话首句即「团队有一条待办…」 |
| `start_group_chat` | 依次发言 | 多 Bot 就话题给出结构化意见 |

数据：`%APPDATA%\Grok Bot\collab\`

### 8. 例程（Routines 定时任务）

- 三种触发：间隔 / 每天 / 每周
- 每 Bot 最多 50 条，每条保留最近 20 条执行记录
- **后台执行**：「立即运行」立刻返回，不阻塞界面；同一条例程不叠跑（手动/定时共用运行表），可随时点「停止」
- **可编辑**：列表里「编辑」按钮把当前值回填进同一个编辑器，改完「保存修改」；改时间表会重算 nextRunAt
- 先推进 nextRunAt 再执行
- 重启重算不补跑（超 6 小时才重算）

实测：创建「每分钟巡检」后**不做任何操作**，1 分钟后自动完成 6 步、
写入 `patrol.log`、记录耗时与摘要。

### 9. 界面

- 侧栏：Bot 列表 + 会话列表 + 技能/MCP/例程/设置入口
- 顶栏：计算机状态徽章 + 模型选择器
- 对话区：流式输出 + 工具调用可视化（可展开）
- 四个管理弹窗：技能 / MCP / 例程 / Bot 设置
- 深浅色主题
- **会话级后台运行**：一段对话在跑时可以直接切走（换对话 / 换 Bot），任务不中断；
  侧栏在该 Bot 和该会话名旁显示运行小圆点，切回来能看到完整实时输出（文本 + 工具轨迹）
- **系统托盘**：关窗口只是收进托盘（例程继续后台跑），托盘右键「退出」才真正结束

### 10. 长期记忆

- `memory/memory-store.js` — 两级作用域（user/bot）× 两层级（profile/log）
- `remember` / `recall` / `forget` 三个工具
- profile 层自动注入系统提示（3000 字符预算），log 层按需检索
- 同 topic 覆盖去重，界面可筛选/搜索/增删

实测：第 1 轮交代「叫我老李」→ 第 2 轮全新会话直接答「记得，老李」。

### 11. 打包与启动

- `scripts/build-app.js` — 复用官方 Electron 运行时打包
- 产物：`dist\app\Grok Bot.exe`（0.2 MB app.asar + 48.9 MB 运行时）
- 启动：双击 `launch.cmd`

### 12. 审批边界

- `approval/policy.js` — 纯静态分类：只读 / 写入 / 执行 / 内联脚本 / 删除 / 联网 / 凭据 / 系统 / 协作 / MCP / 记忆 / **未登记工具**；另有 13 条**永久拒绝**
- `approval/approval-manager.js` — 审批网关：弹窗等待、三级记忆（一次/运行/会话）、超时自动拒绝、停止即收尾
- `approval/audit.js` — 审计日志，`approvals.jsonl`，只记有风险的操作
- 接入点：`executeTool` 执行前统一调用 `ctx.approve`，**四个入口（对话/委派/群聊/例程）全部覆盖**

关键判断：**shell 命令不受路径沙箱约束**，所以 `run_command` 默认要问；
只读命令走白名单（`Get-ChildItem`、`git status`、`npm ls`…），
`python x.py`、`node x.js`、`npm run` 一律按「执行」处理。

默认值不能是「放行」：
- 未登记工具 → `unknown` 档，**要问**。新加工具忘了登记也不会静默失效。
- 文件工具的 `path` 命中 `.env` / `credentials.json` / `.ssh/` / `.aws/` → `secret` 档（否则换个工具就能读密钥）
- `browser_navigate` → `network`；`remember` 写 `profile` 层 → `memory` 档（只在 `strict` 下问，`balanced` 不问，避免日常偏好频繁打扰）

实测：
- 离线自检 **125 项全过**（分类矩阵 / 策略矩阵 / 状态机 / 防绕过 / 审计落盘）
- 端到端 **13 项全过**：拒绝后文件仍在、模型收到「已阻止」；允许后文件真被删；
  只读任务零打扰；例程无人值守自动拒绝
- 界面冒烟 **55 项全过**（真实 Electron + CDP，含窗口重载后恢复待审批、设置里模型下拉、后台运行）

例程默认无人值守 → 危险操作自动拒绝，需在例程里勾「允许危险操作」。

### 13. 模型自动拉取

- 设置面板的「模型」不再是纯文本框：改成 **可输入 input + 点击展开的下拉面板**
  （既能下拉选，也能手填别名/自定义 ID——上游列表常缺这些）
  > 早期用 `<datalist>` 实现，实测在 Electron 里不点小箭头/不敲字就不弹候选，
  > 看着像「没拉到」，已换成自绘 combo 面板（点箭头或点输入框即展开、可筛选）
- `model:list` / `model:test` 支持传入**未保存的** `{ baseUrl, apiKey }`：
  改完地址/密钥（防抖 600ms 或失焦）就自动向上游拉取，不必先保存
- 拉取失败会给明确原因（401 鉴权失败 / 404 地址没含 /v1 / 200 却返回 HTML 也会报 not_json），不静默
- 自动挑默认模型时跳过 embedding / whisper / tts 等非对话模型
- 同一组参数只骚扰上游一次（成功后缓存，失败也记住，可点「从上游拉取」强制重试）
- 顶栏模型选择器与设置面板共用 `S.models`，只有一份数据源

实测：`node scripts/verify-model-fetch.js` **8 项全过**（自动拉取/下拉候选/默认选中/错误密钥/未污染配置）。

### 14. 会话级后台运行

原版 Grok / ChatGPT 的机制是：**生成中可以随时切走，任务在后台继续跑，切回来还在**。
本项目原先用全局单例 `running/runId`，还在导航处硬拦截（弹「正在工作中，请先停止」），
与这个预期不符，已改成**按对话（botId + sessionId）维护运行态**：

- `S.runs: Map<"botId:sessionId", run>` —— 每个对话一份独立运行态
- 导航守卫全部移除：`selectBot` / `selectSession` / `newSession` 都不再阻断
- 一次性订阅 `agent:onEvent`，只按 `runId` 认领自己那段对话的事件
- 实时区按 `run.acc` + `run.items`（工具 / 协作 / 错误流水）**重建**，不是搬 DOM：
  切走时只记数据，切回来 `renderMessages()` 依同一份数据重画，文本与工具轨迹都不丢
- 发送按钮反映**当前这段对话**是否在跑：跑着就是「停止」，点它只停这一段
- 允许多个对话同时后台跑；状态行显示「N 个对话在后台工作中」
- 主进程把流式回复**实时落盘**（1200ms 限流 + 工具调用时强制落盘），
  刷新窗口也能看到已产出内容，而不是一片空白
- 删除会话：若该会话在跑则拒绝并提示；删除 Bot：先把它名下所有运行停掉
- 停止改为「已停止（附已产出内容）」，不再报「出错」
  （Node 中止时流的 `reader.read()` 抛 `TypeError: terminated`，已按 `cause.name === "AbortError"` 识别）

实测：`node scripts/verify-background-run.js` **17 项全过**；界面冒烟中后台运行 8 项全过。

### 15. `@技能名` 直接调用（全局通用）

技能此前只能靠模型自己判断要不要 `use_skill`。现在可以在输入框用 `@技能名`
**显式点名**，跳过判断、强制加载正文并严格照做。

- `agent/mentions.js` — 纯函数解析器：支持 name / id 两种写法、大小写不敏感、
  长名优先（`@a` 不会截断 `@abc`）、连续 `@a@b`、重复去重、缺失进 `missing`；
  只按「前一个字符是 ASCII 字母/数字/下划线/连字符」拦截，所以中文紧贴（`用@写日报`）能识别，
  而邮箱 `abc@qq.com`、URL、路径里的 `@` 不误伤
- `agent/context.js` — 新增 `resolveForcedSkills()`（读正文，含「是否在本 Bot 启用列表」标记）
  与 `renderForcedSkills()`（渲染强制段）。`buildAgentContext` 收到 `extra.text` 就自动解析，
  所以对话 / 委派 / 群聊 / 例程**四个入口一次接通**
- `agent/loop.js` — `runAgent` 新增 `forcedSkills` / `mentionMissing`，把强制段拼进系统提示，
  并先发一条 `skill_loaded` 事件
- 渲染层 — 输入 `@` 弹候选（↑↓ 选择 / Tab·Enter 确认 / Esc 收起 / 点击也可），
  对话流里显示「已加载技能」轨迹

关键取舍：

- **不塞进 `appendToPrompt`**，而是走独立字段 `forcedSkills`，`buildAgentContext` 保持单一职责，好测试
- **用户意图优先**：技能即便不在该 Bot 的「启用的技能」清单里，`@` 了也加载，提示里注明
- **不存在的 `@xxx` 不报错**：忽略并在提示里说明，避免手滑就打不出字

实测：`node scripts/verify-skill-mention.js` **31 项全过**；
界面冒烟新增 9 项（补全/过滤/光标/邮箱不弹/轨迹渲染）全过；
实机 `node scripts/verify-mention-live.js` **6 项全过**（真实 Electron + 真实模型：`@` 弹候选、`@munger` 精确过滤、Tab 填入、发送后出现「已加载技能」轨迹、模型真的按芒格视角回答）。

### 16. Bot 置顶

左栏 Bot 可以置顶，固定在最上方（像微信/ChatGPT 的置顶会话）。

- 数据：`bot.json` 增 `pinned` / `pinnedAt`；`Store.setBotPinned()` 单独处理，
  **不碰 `updatedAt`**（置顶是显示偏好，不该让 Bot 在「最近更新」里插队）
- 排序：`listBots()` 与渲染层 `renderBots()` **同一套规则** —— 置顶的排前面，
  多个置顶按「最近置顶」倒序，其余按 `updatedAt` 倒序
- 交互（两处都可以）：
  - 左栏每个 Bot 右侧有图钉按钮：悬停显示，已置顶常显并高亮；点一下切换
  - Bot 设置弹窗里有「置顶」勾选框
- 新增 IPC：`bots:pin`（`preload` 同步暴露 `bots.pin`）

实测：`node scripts/verify-bot-pin.js` **10 项全过**（默认/排序/多置顶/不改 updatedAt/取消/持久化/updateBot 路径）；
界面冒烟新增 5 项（按钮数量/固定态/排序/样式/active 保持）全过。

### 17. 例程后台执行 + 系统托盘

原来的问题：点「立即运行」界面像卡死（按钮永远停在「运行中…」），关窗口又把任务一起杀了。

**根因**（都实测过）：

1. `runNow` 是同步阻塞的，一条例程要跑十几秒才返回，期间界面被占住
2. `routine:event` 完成时会 `renderRoutineList()` 把按钮节点整个重建，`await` 回来再改的是已脱离 DOM 的旧节点 → 永远卡在禁用态
3. `window-all-closed → app.quit()`，例程跑在主进程里，进程一退任务就没了

**改法**：

- `scheduler.js` 重写：`#launch()` **不 await**，`runNow()` 立即返回 `{started}`，新增
  `stopRoutine()` / `isRunning()` / `runningIds()` / `runningInfo()` / `shutdown()`；
  运行表从 `busy:Set` 换成 `runs:Map<id,{controller,startedAt,trigger}>`，手动/定时共用，天然防叠跑
- `main.js`：`executeRoutine` 接收调度器传入的 `signal`（不再自建 controller）；
  新增 `routines:stop` / `routines:running` IPC；新增 `Tray`，`close` 时 `hide()` 进托盘，
  `before-quit` 置 `isQuitting` 并 `scheduler.shutdown()`；无托盘时回落为正常退出（不留僵尸进程）
- `app.js`：新增 `S.routineRunning` 快照；运行中按钮变红色「停止」+「正在后台执行，可以关窗口」；
  完成后显示「上次 已停止/成功/失败」
- `preload.js` 同步 `routines.stop` / `routines.running`
- `assets/tray.png`：32×32 托盘图标

实测：`node scripts/verify-routine-scheduler.js` **15 项全过**（立即返回/不叠跑/停止生效/定时也走后台）；
`node scripts/verify-routine-background.js` **9 项全过**（1.2s 内按钮变「停止」、关窗口后进程存活、
任务继续跑完 9s 并落盘、可正常退出）。

### 18. 本机浏览器（真实浏览器自动化）

原来 `browser_navigate` 在本机直接报「这台计算机不支持浏览器」，网页上的点选/采集/注入只能靠
用户手动开一个带 `--remote-debugging-port=9333` 的 Chrome。现在 Bot **自带浏览器**：

- `computer/browser.js`：`findBrowserExe()`（Chrome→Edge，可用 `GROKBOT_CHROME` 指定）；
  `LocalBrowser` 有两种模式——**自有模式**（`--user-data-dir=<userData>\browser-profile`
  `--remote-debugging-port=0`，读 `DevToolsActivePort`，登录态持久）与**接管模式**
  （`app.json` 里 `browser.attach` 直接连已有 CDP，不杀用户进程）。
- 方法：`navigate / eval / snapshot / click / type / screenshot / info / status / dispose`。
  `snapshot()` 给可见可交互元素打 `data-gb-uid="gbN"`，返回 `[gbN] <role> 名称 → href`。
- 新工具：`browser_snapshot / browser_click / browser_type / browser_eval / browser_screenshot`
  （`browser_navigate` 保留）；审批策略 click/type→network、eval→script、snapshot/screenshot→safe。
- 设置面板新增「本机浏览器」区（`#openBrowserBtn` / `#browserStatus`），IPC
  `computer:browser-open` / `computer:browser-status`，preload 同步 `computer.openBrowser/browserStatus`。
- 采集脚本 `cdp.mjs` 自动发现端口：`GROKBOT_CDP_PORT` → `9333` → `browser-profile\DevToolsActivePort`。

实测：`node scripts/verify-local-browser.js` **全绿**（启动/读端口/snapshot/type/click/eval/截图/dispose）；
接管 9333 能读到真实 TikTok 页面；自有模式打开 example.com 正常。详见 `docs/browser.md`。

**多标签页（2026-10-29 追加）**：一个浏览器常开着多个标签，默认连列表第一个 page 往往不是目标页
（实测真实浏览器里第一个是「Cookie 商店页」、第二个才是 TikTok 后台）。新增
`browser_tabs`（列出所有标签）与 `browser_tab { hint }`（按标题/网址关键字或 targetId 切换，
切换时关旧连接重连新标签）；`snapshot` 在标签 > 1 时附上标签清单。工具数 21 → **23**。

### 21. 工具轨迹默认折叠（界面）

执行中的工具卡（`run_command` 的命令 + 退出码输出、代码/文件内容）原来一律展开，
长输出会把对话顶得很长。现在：

- 卡片头只留「▸ 工具名 + 一行参数摘要」，正文 `tool-body` 默认 `hidden`；
- 点卡片头（或箭头）才展开，再点收起，箭头 `▸/▾` 同步；
- **出错（state=err）自动展开**，避免失败信息被折叠淹没；
- 流式执行中（还没有输出）不显示空正文体；结果回来时补齐折叠体并保持收起。

实测：`smoke-ui.js` 新增 6 项（默认折叠 / 出错自动展开 / 运行无空体 / 有箭头 / 点开 /
再点收起）全绿。

### 19. 例程结果以 `report_result` 为准（杜绝假成功）

原来 `ok = !error && !aborted` —— 模型只要吐了文字（哪怕内容是「我没能完成」）就记成功，
8 次失败汇报全是 `ok=true`。现在改为以模型显式上报的结果为准：

- 新工具 `report_result { status: success|blocked|failed, summary, details? }`，
  执行器写入 `ctx.reportResult`；`loop.js` 只有**例程**（传了 `report`）才在系统提示加
  「结束前必须调用 report_result」。
- `scheduler.js`：`ok = reportStatus === "success"`；`blocked` 单独标记（界面显示「受阻」）；
  **未上报 = 失败**，摘要写「模型未上报执行结果（未调用 report_result）」。
- `report_result` 归为 `safe`，不弹审批。

实测：`verify-routine-report.js`（5 情形）/ `verify-report-tool.js` 全绿；工具数 15 → **21**（多标签页加入后为 23）。

### 20. 达人样品采集跑通（A）

`tiktok-affiliate-sample-requests` 技能内新增参数化脚本 `scripts/collect_to_review.mjs` + `cdp.mjs`：
自动连接本机浏览器、**遍历「经营市场」下拉里的所有国家**（泰国/马来西亚/菲律宾）逐国翻页，
输出 `out/to_review.json`。关键结论：签名 URL 与市场无关（市场靠页面会话状态切换），可复用同一签名跨市场拉取。

实测：真实 Chrome 上跑出 3 国 **13 条**（泰 5 / 马 1 / 菲 7）；例程 `rt-9ffa169b` 端到端
`ok=true / reportStatus=success / 81s / 5 步`。**注意**：该接口无「申请时间」，只有剩余申请时间。

### 22. 文件工具可读技能目录（路径沙箱读写分离）

**问题**：达人运营会话里 `list_files C:\Users\phlus\AppData\Roaming\Grok Bot\skills\tiktok-affiliate-sample-requests`
报「拒绝访问工作目录之外的路径」。技能明明是 GrokBot 自己的，却被拒。

**根因**：`LocalComputer.resolve()` 把一切路径限制在 Bot 的 workspace（`E:\DATABASE\Grokbot`），
而技能装在 `<userData>\skills`、截图在 `<userData>\screenshots` —— 都不在 workspace，
所以 `list_files` / `read_file` 读技能一律被拒；模型只能绕道 `run_command` 跑
PowerShell `Get-ChildItem` / `Get-Content` 才成功（那个会话里后面一串 run_command 全是绕路）。

**修复（读/写分离）**：

- `LocalComputer` 新增 `readRoots`（自动含 `<userData>\skills`、`<userData>\screenshots`，可再传 `extraReadRoots`）；
  `resolve(relPath, { write })`：读操作额外允许白名单，写操作仍只限 workspace；
  越界错误里**列出所有允许目录**并提示「技能用 use_skill / 脚本用 run_command 绝对路径，不要 list_files 猜路径」。
- `SkillStore.read()` 新增 `files`（技能内文件相对清单）；`use_skill` 直接输出技能目录 +
  每个文件的绝对路径，模型照单读取即可，不再需要 `list_files`。
- `registry`：`list_files` / `read_file` / `write_file` 描述同步新语义。

**顺带修掉同一批会话里暴露的其它坑**（都是「模型撞墙后反复重试」的根源）：

- **图片误读**：`read_file` 读 `.png` 会返回乱码，模型还反复读。现在识别到图片/二进制直接返回
  「这是图片/二进制文件，read_file 只能读文本」，并提示改用 `browser_snapshot` / `browser_eval`。
- **`%APPDATA%` 不展开**：模型常写 `dir "%APPDATA%\..."`，PowerShell 不认 `%VAR%`，路径变成
  `E:\DATABASE\Grokbot\%APPDATA%\...` 找不到。`exec()` 现在统一把命令里的 `%VAR%` 展开成真实值。
- **工具描述纠偏**：`run_command` 说明「要跑技能脚本用 use_skill 给的绝对路径」；
  `browser_tab` 说明「不确定标签先 browser_tabs，别猜」；`browser_eval` 说明「CSP 报 Failed to fetch 时改用 snapshot」。

实测：`verify-path-sandbox.js`（11 项）全绿；`verify-skill-frontmatter.js` 47 项全绿（新增「read() 带文件清单」）。

---

## 三、关键决策

| 决策 | 理由 |
| --- | --- |
| **自建独立应用，不改官方** | 官方是 Cursor 云端架构，逆向成本 > 重写 |
| **执行环境抽象成「计算机」** | 云端接口预留，上层 Agent 不用改（已实测可切换） |
| **模型接本地路由器 8788** | 复用已有的 `codex-model-router`，多模型可选 |
| **技能用渐进式加载** | 全塞进上下文会撑爆；清单+按需读正文 |
| **工具执行全在本地** | 模型只做决策，安全可控 |
| **路径沙箱（读写分离）** | 写只限 workspace；读额外允许技能/截图目录，越界直接拒绝并列出允许目录 |
| **PowerShell 强制 UTF-8** | 否则中文在管道里变 GBK 乱码（踩过坑） |
| **抽出 buildAgentContext** | 交互/委派/群聊/例程四个入口复用同一份上下文 |
| **例程先推进再执行** | 防长任务导致重复触发 |

---

## 四、当前状态

### 环境

| 项 | 值 |
| --- | --- |
| 运行方式 | `dist\app\Grok Bot.exe`（双击 `launch.cmd`） |
| 模型服务 | `https://wbsub2.lusixian.com/v1`（当前实际使用；`deepseek-v4.1-flash`） |
| 数据目录 | `%APPDATA%\Grok Bot\` |
| 官方原版 | 完好无损（`D:\Program Files\grokbot\Grok Bot`，哈希 B3A9D130…） |
| 原版备份 | `work\app.asar`（48.9 MB） |

### 变更日志

| 日期 | 内容 |
| --- | --- |
| 2026-10-28 | 项目立项，确定自建独立应用路线 |
| 2026-10-28 | 完成 Agent 引擎、工具系统、Bot 管理、界面、打包 |
| 2026-10-28 | 加入技能（含导入）、MCP、Bot 协作（三种）、例程（定时任务） |
| 2026-10-28 | 技术债清理：删除 work/ 冗余备份（97.6 MB）、修复打包重复备份、统一 npm 脚本 |
| 2026-10-28 | **完成长期记忆**：两级作用域（user/bot）× 两层级（profile/log），3 个工具，界面可管理 |
| 2026-10-28 | **完成审批边界**：四档风险 + 四档策略 + 弹窗（一次/运行/会话）+ 永久拒绝 + 审计 |
| 2026-10-28 | **审批边界加固**：修掉「未登记工具默认放行」等 7 个绕过口；永久拒绝扩到 13 条；刷新后恢复待审批；自检 89→120 项 |
| 2026-10-28 | **模型自动拉取**：设置面板填好地址+密钥即自动拉上游模型列表（datalist 可下拉可手填），未保存也能拉，失败有明确原因 |
| 2026-10-28 | **修复底部输入框消失**：长回答把页面撑高（`.main`/`#messages` 缺 `min-height:0`），输入框被挤出视口；已修 + 加回归断言 |
| 2026-10-28 | **会话级后台运行**：去掉「正在工作中，请先停止」的导航拦截，运行态按对话隔离，可一边跑一边切对话/切 Bot，切回来还能看实时输出 |
| 2026-10-29 | **`@技能名` 直接调用**：输入框 `@` 自动补全，显式指定即强制加载正文；对话/委派/群聊/例程四入口通用 |
| 2026-10-29 | **Bot 置顶**：左栏图钉 / 设置里勾选，置顶的固定在最上方，多个置顶按最近置顶排 |
| 2026-10-29 | **例程后台执行 + 系统托盘**：修掉「立即运行」按钮永远卡在「运行中…」（节点重建后操作旧 DOM）；runNow 改为后台启动立即返回、可点「停止」；关窗口收进托盘，例程继续跑，只有托盘退出才停 |
| 2026-10-29 | **例程可编辑**：列表新增「编辑」按钮，把已有值回填进同一个编辑器（名称 / Bot / 指令 / 触发方式 / 时刻 / 危险操作），保存走 `routines:update`；改时间表重算 nextRunAt，历史记录保留 |
| 2026-10-29 | **本机浏览器（真实浏览器自动化）**：Bot 自带独立 profile 的 Chrome（或接管 9333），新增 `browser_snapshot/click/type/eval/screenshot`，设置面板加「打开浏览器」；采集脚本可自动发现端口 |
| 2026-10-29 | **例程结果以 report_result 为准**：修掉「模型只吐文字就算成功」的假成功（原来 8 次「没完成」全记 ok=true）；新增 `report_result` 工具，未上报=失败，受阻单独标记 |
| 2026-10-29 | **模型拉取 UX 修正**：拉取成功后若框里是旧的无效模型 ID 自动纠正、并自动展开下拉；实测上游 25 个模型 |
| 2026-10-29 | **达人样品采集跑通**：`collect_to_review.mjs` 参数化进技能，自动遍历经营市场（泰/马/菲）逐国翻页；实测 3 国 13 条，例程端到端 ok=true |
| 2026-10-29 | **工具轨迹默认折叠**：执行中的工具卡正文默认收起，点卡片头才展开，出错自动展开；长命令/代码不再顶长对话 |
| 2026-10-29 | **文件工具可读技能目录**：修掉 `list_files`/`read_file` 读技能目录被拒（读写分离白名单）；`use_skill` 直接给出技能全部文件绝对路径，不再需要 run_command 绕路 |

### 代码规模

```
JS 模块              25 个 / 6928 行（app/src 下的 .js；另有 css 298 行 / html 403 行）
  renderer/app.js   1736 行
  main.js            782 行
  computer/browser.js 420 行（本机浏览器 / CDP / 多标签）
  tools/registry.js  277 行（23 个工具）
  computer/local-computer.js 317 行（读写分离路径沙箱 / 图片识别 / %VAR% 展开）
  skills/skill-store.js 350 行（read 附带文件清单）
  routines/scheduler.js 164 行（后台执行 / 停止 / 运行态 / 结果上报）
  mentions.js        128 行（@ 技能解析）
验证脚本             20 个 / 2848 行（scripts/，不含 `_*.js` 临时脚本；新增 verify-path-sandbox.js）
docs                 8 份 / 662 行（skills.md 补「技能目录读写策略」）
```

### 数据目录结构

```
%APPDATA%\Grok Bot\
  app.json           设置（模型、主题、计算机模式、窗口）
  bots\<id>\bot.json + sessions\*.json
  workspaces\<id>\   Bot 的工作文件
  skills\<id>\SKILL.md
  mcp.json           MCP 服务器配置
  routines.json      例程
  collab\            留言队列 + 群聊记录
  memory\            长期记忆（user.json + <botId>.json）
  browser-profile\   本机浏览器独立 profile（登录态持久，自带模式用）
  screenshots\       browser_screenshot 截图输出
```

---

## 五、未完成待办

### 高优先级

| # | 事项 | 说明 |
| --- | --- | --- |
| ~~1~~ | ~~长期记忆~~ | ✅ 已完成（2026-10-28） |
| ~~1~~ | ~~审批边界~~ | ✅ 已完成（2026-10-28）：四档风险 + 弹窗 + 三级记忆 + 审计 + 例程无人值守 |
| ~~3~~ | ~~本机浏览器~~ | ✅ 已完成（2026-10-29）：自带独立 profile Chrome + 接管模式，snapshot/click/type/eval/screenshot |
| ~~4~~ | ~~例程假成功~~ | ✅ 已完成（2026-10-29）：以 `report_result` 为准，未上报=失败 |
| 2 | **云端服务端** | 写一个 Docker 版实现 `docs/cloud-computer.md` 的契约，实现 24h 无人值守 |
| 3 | **达人采集写飞书（待确认）** | 采集已跑通；写飞书需用户给出 Base/Table/View（见下方「待用户拍板」） |

### ⚠️ 待用户拍板（阻塞，不能猜）

1. **飞书表**：`botare-creator-sample-sheet` 技能里已写明目标表（正式表 `botare.feishu.cn/wiki/YYlYwGxdIi0QjskHRvfcpFFKnOL`，
   测试表 `pcnglaajd3ye.feishu.cn/wiki/TVA0wKWtUiWhxNksRMlc1XaCnid`）与页签（TH/MY/PH/ID），
   但该技能有**误删整表 / 误点 Approve** 的事故史，写飞书属高风险。需用户确认：用哪张表、哪个页签、是否本轮就写入。
2. **「申请时间」口径**：TikTok 接口无申请时间，只有剩余申请时间。`botare-creator-sample-sheet`
   技能的口径是「申请时间 = 到期时间 − 5 天」。需用户确认用哪种。

### 中优先级

| # | 事项 | 说明 |
| --- | --- | --- |
| 4 | 文件改动 diff 预览 + 撤销 | 现在 `write_file` 直接覆盖，无预览无回滚 |
| 5 | 群聊并行化 | 现在是串行（一个说完下一个） |
| 6 | 技能「演示教学」 | 官方有 Teach a task（录屏→生成技能），未做 |
| 7 | 事件触发例程 | 官方支持 Slack/GitHub 事件触发，现在只有时间表 |

### 低优先级

| # | 事项 | 说明 |
| --- | --- | --- |
| 8 | 通知 / 移动端 | 官方有 iOS + 推送，未做 |
| 9 | 语音通话 | 官方有，未做 |
| 10 | 团队/共享 | 官方有团队 Bot 共享，未做 |

### 技术债（已于 2026-10-28 清理完毕）

| # | 问题 | 处理结果 |
| --- | --- | --- |
| A | `start-grokbot.cmd` 指向已删除的 `relay/` | 已删除该废弃文件 |
| B | `package.json` 脚本指向不存在的文件 | 改为 `build` / `build:install` / `verify:cloud` / `clean` |
| C | `.gitignore` 引用 `relay/` | 已重写 |
| D | `app/src/shared/` 空目录 | 已删除 |
| E | `work/` 冗余备份（97.6 MB） | 已删除（官方目录完好 + dist 有备份） |
| F | `build/app.asar` 被占用 | 新增 `scripts/clean.js`（带重试与提示） |
| G | **打包产生两份 48.9 MB 备份** | 已修复：只保留 `official.asar.bak` 一份 |

---

## 六、关键文件索引

| 路径 | 作用 |
| --- | --- |
| `app/src/main/main.js` | 主进程 + 全部 IPC（460 行） |
| `app/src/main/agent/loop.js` | Agent 循环（核心） |
| `app/src/main/agent/model-client.js` | 模型客户端（Responses API） |
| `app/src/main/agent/context.js` | 上下文构建（四处复用） |
| `app/src/main/agent/mentions.js` | `@技能名` 解析（纯函数） |
| `app/src/main/computer/computer.js` | 计算机接口契约 |
| `app/src/main/computer/remote-computer.js` | **云端实现（HTTP 契约）** |
| `app/src/main/computer/browser.js` | **本机浏览器（CDP，自有/接管两模式）** |
| `app/src/main/tools/registry.js` | 工具定义 |
| `app/src/main/tools/executor.js` | 工具执行 |
| `app/src/main/skills/skill-store.js` | 技能读写 + 导入 |
| `app/src/main/mcp/mcp-manager.js` | MCP 管理 |
| `app/src/main/collab/collab-bus.js` | 协作总线 |
| `app/src/main/routines/scheduler.js` | 定时调度 |
| `app/src/renderer/app.js` | 界面逻辑（含会话级运行态 / 实时区重建） |
| `scripts/build-app.js` | 打包 |
| `scripts/verify-cloud.js` | 云计算机契约自检 |
| `docs/cloud-computer.md` | **云计算机接口规格（做云端必读）** |
| `app/src/main/memory/memory-store.js` | 长期记忆 |
| `app/src/main/approval/policy.js` | 风险分类 + 永久拒绝名单 |
| `app/src/main/approval/approval-manager.js` | 审批网关（弹窗 / 三级记忆 / 超时） |
| `app/src/main/approval/audit.js` | 审批审计（JSONL） |
| `scripts/verify-approval.js` | 审批自检（125 项） |
| `scripts/verify-approval-live.js` | 审批端到端（13 项） |
| `scripts/verify-background-run.js` | 后台运行端到端（17 项，需真实模型） |
| `scripts/verify-skill-mention.js` | `@技能` 直接调用自检（31 项） |
| `scripts/verify-bot-pin.js` | Bot 置顶自检（10 项） |
| `scripts/verify-local-browser.js` | 本机浏览器自检（启动/快照/点击/输入/截图/关进程） |
| `scripts/verify-routine-report.js` / `verify-report-tool.js` | 例程结果上报语义（success/blocked/failed/未上报/停止） |
| `docs/skills.md` / `mcp.md` / `collab.md` / `routines.md` / `memory.md` / `approval.md` / `browser.md` | 各模块文档 |

---

## 七、如何继续

### 启动

```powershell
cd E:\github\Grok_Bot
.\launch.cmd
```

### 重新打包（改代码后）

```powershell
npm run build          # 等价于 node scripts/build-app.js
npm run build:install  # 安装到 %LOCALAPPDATA%\Programs\GrokBot
```

### 清理构建残留

```powershell
npm run clean          # 被占用时：node scripts/clean.js --force
```

### 自检云计算机接口

```powershell
npm run verify:cloud   # 等价于 node scripts/verify-cloud.js
```

### 跑全部验证

```powershell
npm run verify:all      # 审批 125 + 审批端到端 13 + 云端契约 + 技能解析 47 + 路径沙箱 11 + @技能 31 + Bot 置顶 10 + 例程调度 15 + 模型拉取 8 + 窗口边界 + 界面冒烟 + 后台运行 17 + 例程后台端到端 9
```

单独跑：`npm run verify:approval` / `verify:approval:e2e` / `verify:mentions` / `verify:skills` / `verify:paths` / `verify:models` / `verify:ui` / `verify:background` / `verify:routines` / `verify:routines:e2e`
（`verify:mentions` 是解析器 31 项；`verify:mentions:e2e` 是真实模型的实机 6 项，需要先关掉正在运行的 Grok Bot）
另有 `verify:pins`（Bot 置顶 10 项，纯数据层，不用起界面）。

> `verify:ui`、`verify:models`、`verify:background`、`verify:routines:e2e` 会启动打包后的 exe 并占用调试端口，
> 跑之前先关掉正在运行的 Grok Bot，否则会「CDP 未就绪」。

### 数据重置

删掉 `%APPDATA%\Grok Bot\bots` 和 `workspaces` 即可（`skills` 可保留）。

---

## 八、给下一个对话的提示

1. **不要试图改官方原版**，方向已确认是错的，代价在「一、走过的弯路」里。
2. **改代码后必须重新打包**（`node scripts/build-app.js`），否则运行的是旧 asar。
3. **改 `main.js` 里 IPC 后**要同步 `preload/preload.js`，否则渲染层拿不到。
4. **测 Agent 行为不要只看回复**，要看工具调用序列（`emit` 的 `tool_call` 事件）。
5. **模型不支持某参数时**（如 Claude 新版弃用 temperature），客户端有自动降级重试。
6. **中文乱码**：PowerShell 已强制 UTF-8，若新增执行路径需同样处理。
7. **长期记忆、审批边界均已完成**。剩余高优先级只有「云端服务端」。
8. **加新工具时想一遍它属于哪档风险**：在 `approval/policy.js` 的 `classifyTool` 加分支，
   否则会掉进 `unknown` 档（会问，但提示写得含糊）。**不会再默认放行** —— 这是 2026-10-28 修掉的坑。
9. **改 `executeTool` 时不要绕过 `ctx.approve`**，否则对话/委派/群聊/例程四个入口的边界会一起失效。
10. **例程默认无人值守**：危险操作会被自动拒绝，测例程时这是预期行为。
11. **永久拒绝是黑名单**（13 条），只覆盖「明显毁系统」的写法。别把它当牢笼：真正的安全靠「有风险就问」。
12. **`approval:pending` 已被界面使用**：`init()` 会调 `restorePendingApprovals()`，窗口刷新不会丢弹窗。
13. **不要打桩 `window.api`**：它是 `contextBridge` 冻结对象，改不动。测试走可注入参数（见 `restorePendingApprovals(fetcher)`）。
14. **运行态是「按对话」的，不是全局单例**：判断某段对话是否在跑用 `currentRun()` / `runFor(botId, sessionId)`，
    不要再用 `S.running` / `S.runId`（已删除）。改这块务必跑 `node scripts/verify-background-run.js`。
15. **实时输出是「按数据重建」的**：事件先写进 `run.items` / `run.acc`，再由 `renderMessages()` 重画；
    不要再往 DOM 里直接 append 然后指望切换时不丢。
16. **技能可以 `@名字` 直接调用**：解析逻辑在 `agent/mentions.js`，跨入口统一由
    `buildAgentContext(..., { text })` 完成，不要再在某个入口单独解析一遍；
17. **例程是真后台跑**：`scheduler.runNow()` 只负责启动并立即返回，**绝不能再改成 `await`**；
    界面运行态一律以 `routines:running` 快照为准，不要靠 `runNow` 的返回值判断「跑没跑完」。
18. **关窗口 ≠ 退出**：`mainWindow.on("close")` 会 `preventDefault()` + `hide()` 进托盘，
    真正退出必须走 `isQuitting = true` 的路径（托盘菜单 / 菜单栏 / `before-quit`）。
    新增任何「退出」入口时都要记得置 `isQuitting`，否则会退不掉。
19. **跑 UI 测试前先杀应用**：`Get-Process Grok* | Stop-Process -Force`。
    `smoke-ui.js` 的 CDP 端口可用 `GROKBOT_CDP_PORT` 覆盖（默认 9333 可能被本机 Chrome 占用）。
    改动这块务必跑 `node scripts/verify-skill-mention.js`（31 项）。
17. **Bot 置顶排序在两处**：主进程 `Store.listBots()` 和渲染层 `renderBots()` 各有一份
    完全相同的排序规则（置顶优先 → 最近置顶 → 最近更新）。改排序时两处必须一起改，
    否则「刷新后顺序跳变」。改这块跑 `node scripts/verify-bot-pin.js`（10 项）。


20. **例程的成功与否只看 `report_result`**：`scheduler.js` 里 `ok = reportStatus === "success"`，
    未上报即失败。写例程指令时必须要求模型「最后调用 report_result」，否则永远判失败。
    改这块跑 `node scripts/verify-routine-report.js`（5 情形）。
21. **本机浏览器别自己再起 Chrome**：Agent 用 `browser_*` 工具时走 `computer/browser.js`，
    自有模式会自己起独立 profile 的 Chrome、退出时 `dispose` 关掉；不要把「让用户手动开 9333」
    再写回 SKILL 或代码里（旧的过时说明已删）。采集脚本用 `cdp.mjs` 的端口自动发现即可。
    改这块跑 `node scripts/verify-local-browser.js`。
22. **`build-app.js` 已改成「就地覆盖 asar」**：targetDir 已存在时只 `copyFileSync` 覆盖
    `resources/app.asar`，不再整体 rm/cp。某些机器上 asar 被残留进程占着 delete 句柄，
    整体删除会把 dist 删一半。改打包逻辑时保留这个分支。
23. **技能目录不在 workspace 内，读走白名单、写仍只在 workspace**：技能装在
    `<userData>\skills`、截图在 `<userData>\screenshots`，所以 `LocalComputer.resolve()`
    对**读**放行这两个目录，对**写**仍只限 workspace。改路径策略时不要一刀切地放开，
    也不要让模型再绕 `run_command Get-Content` 读技能——`use_skill` 已直接给出文件绝对路径。
    改这块跑 `node scripts/verify-path-sandbox.js`（9 项）。


