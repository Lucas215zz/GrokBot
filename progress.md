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
- 同一时刻只跑一条；先推进 nextRunAt 再执行
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
- 离线自检 **120 项全过**（分类矩阵 / 策略矩阵 / 状态机 / 防绕过 / 审计落盘）
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

---

## 三、关键决策

| 决策 | 理由 |
| --- | --- |
| **自建独立应用，不改官方** | 官方是 Cursor 云端架构，逆向成本 > 重写 |
| **执行环境抽象成「计算机」** | 云端接口预留，上层 Agent 不用改（已实测可切换） |
| **模型接本地路由器 8788** | 复用已有的 `codex-model-router`，多模型可选 |
| **技能用渐进式加载** | 全塞进上下文会撑爆；清单+按需读正文 |
| **工具执行全在本地** | 模型只做决策，安全可控 |
| **路径沙箱** | 所有文件操作经 `safeResolve`，越界直接拒绝 |
| **PowerShell 强制 UTF-8** | 否则中文在管道里变 GBK 乱码（踩过坑） |
| **抽出 buildAgentContext** | 交互/委派/群聊/例程四个入口复用同一份上下文 |
| **例程先推进再执行** | 防长任务导致重复触发 |

---

## 四、当前状态

### 环境

| 项 | 值 |
| --- | --- |
| 运行方式 | `dist\app\Grok Bot.exe`（双击 `launch.cmd`） |
| 模型服务 | `http://127.0.0.1:8788/v1`（codex-model-router，已确认在线） |
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

### 代码规模

```
JS 模块              24 个 / 6456 行（app/src 下的 .js；另有 css 312 行 / html 410 行）
  renderer/app.js   1735 行
  main.js            735 行
  mentions.js        128 行（@ 技能解析）
验证脚本             14 个 / 2326 行（scripts/）
docs                 7 份 / 751 行
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
```

---

## 五、未完成待办

### 高优先级

| # | 事项 | 说明 |
| --- | --- | --- |
| ~~1~~ | ~~长期记忆~~ | ✅ 已完成（2026-10-28） |
| ~~1~~ | ~~审批边界~~ | ✅ 已完成（2026-10-28）：四档风险 + 弹窗 + 三级记忆 + 审计 + 例程无人值守 |
| 2 | **云端服务端** | 写一个 Docker 版实现 `docs/cloud-computer.md` 的契约，实现 24h 无人值守 |

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
| `scripts/verify-approval.js` | 审批自检（120 项） |
| `scripts/verify-approval-live.js` | 审批端到端（13 项） |
| `scripts/verify-background-run.js` | 后台运行端到端（17 项，需真实模型） |
| `scripts/verify-skill-mention.js` | `@技能` 直接调用自检（31 项） |
| `scripts/verify-bot-pin.js` | Bot 置顶自检（10 项） |
| `docs/skills.md` / `mcp.md` / `collab.md` / `routines.md` / `memory.md` / `approval.md` | 各模块文档 |

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
npm run verify:all      # 审批 120 + 审批端到端 13 + 云端契约 + 前端解析 46 + @技能 31 + 模型拉取 8 + 界面冒烟 + 后台运行 17
```

单独跑：`npm run verify:approval` / `verify:approval:e2e` / `verify:mentions` / `verify:skills` / `verify:models` / `verify:ui` / `verify:background`
（`verify:mentions` 是解析器 31 项；`verify:mentions:e2e` 是真实模型的实机 6 项，需要先关掉正在运行的 Grok Bot）
另有 `verify:pins`（Bot 置顶 10 项，纯数据层，不用起界面）。

> `verify:ui`、`verify:models`、`verify:background` 会启动打包后的 exe 并占用调试端口，
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
    改动这块务必跑 `node scripts/verify-skill-mention.js`（31 项）。
17. **Bot 置顶排序在两处**：主进程 `Store.listBots()` 和渲染层 `renderBots()` 各有一份
    完全相同的排序规则（置顶优先 → 最近置顶 → 最近更新）。改排序时两处必须一起改，
    否则「刷新后顺序跳变」。改这块跑 `node scripts/verify-bot-pin.js`（10 项）。

