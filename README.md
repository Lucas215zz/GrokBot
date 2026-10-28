# Grok Bot — 多 Bot Agent 平台

一个真正能「干活」的桌面 Agent 平台：创建多个 Bot，每个 Bot 拥有独立的
工作目录、会话和工具权限，通过本地模型路由器驱动。

## 现在能做什么（已实测）

- **多 Bot**：创建任意多个 Bot，各有名字/头像/人设/系统提示词
- **独立工作目录**：每个 Bot 有自己的文件夹，读写都被限制在里面
- **真实工具调用**：列目录、读文件、写文件、执行命令、全文搜索
- **自主多轮**：模型自己决定调哪个工具、看结果、再继续，直到完成
- **Bot 协作**：一个 Bot 可以把子任务委派给团队里更合适的另一个 Bot
- **技能（Skill）**：可复用的做事流程，Bot 会先查技能再动手；支持新建/导入/按 Bot 隔离
- **`@技能名` 直接调用**：输入框敲 `@` 自动补全，点名即强制加载该技能正文并严格执行（对话/委派/群聊/例程通用）
- **MCP**：接入外部能力（数据库、浏览器、SaaS），工具自动变成模型可调用的函数
- **Bot 协作**：委派（同步）、留言（异步）、群聊（多方讨论）三种方式
- **Bot 置顶**：左栏图钉或设置里勾选，常用的 Bot 固定在最上方
- **例程（Routines）**：定时自动跑任务，支持间隔 / 每天 / 每周
- **长期记忆**：Bot 记住你的偏好与经验，跨会话生效
- **审批边界**：删除 / 联网 / 系统变更等危险操作先问你，可留审计记录
- **会话持久化**：每个 Bot 下多个对话，历史与工具轨迹都会保存
- **流式输出**：逐字显示，工具调用过程可视化

实测案例：让 Bot 写周报，它先 `list_bots` 发现「文档官」，再
`delegate_to_bot` 委派，拿回结果后转述——3 步完成。

## 启动

**不想自己构建**：到 [Releases](https://github.com/Lucas215zz/GrokBot/releases) 下载
`GrokBot-1.0.0-win-x64.zip`，解压后双击 `Grok Bot.exe` 即可（免安装，内置运行时）。

**从源码跑**：双击 `launch.cmd`，或直接运行：

```
dist\app\Grok Bot.exe
```

首次使用：右上角「选择模型」→ 选一个 → 点左栏 `+` 新建 Bot → 直接发任务。

## 前提

需要一个 OpenAI Responses 兼容的模型服务。默认连本机路由器：

```
http://127.0.0.1:8788/v1     （codex-model-router）
```

在「设置」里可改成任意兼容地址 + API Key。填好这两项后，模型列表会**自动从上游拉取**，
下拉即可选（也能手动输入自定义模型 ID，因为上游列表不一定全）。

## 长期记忆

两级作用域 + 两个层级：

| | 作用域 `user` | 作用域 `bot` |
| --- | --- | --- |
| **profile**（每次注入） | 「叫我老李」 | 「日报分三部分」 |
| **log**（按需检索） | — | 做过的任务、踩过的坑 |

实测：第 1 轮说「以后叫我老李」，第 2 轮**全新会话**直接答「记得，老李」。

详见 [docs/memory.md](docs/memory.md)。

## 审批边界

Bot 能直接跑 PowerShell，所以执行前有一道闸：

| 风险 | 例子 | 默认 |
| --- | --- | --- |
| 只读 | 列目录、读文件、`git status` | 放行 |
| 写入 | `write_file` | 放行（标准档） |
| 要确认 | 删除、联网安装、读密钥、改系统、Bot 协作、MCP、内联脚本、未登记工具 | **弹窗问你** |
| 永久拒绝 | `Format-Volume`、`diskpart`、`del C:\`、删 `C:\Windows`（共 13 条） | 直接拦 |

关键是 **shell 命令不受工作目录沙箱限制**，所以「随便跑个命令」本身要确认；
只有确凿只读的入口（`Get-ChildItem`、`npm ls`）免问，`python x.py`、`npm run` 一律要问。

**没有「默认放行」这个坑**：未登记的工具按 `unknown` 档处理、照样要问；
用 `read_file` 读 `.env` / `credentials.json` / `.ssh/` 会被当作读密钥处理。

弹窗三个选项：允许一次 / 本次运行都允许 / 本会话都允许。拒绝会记住，
模型换个说法重试会重新问，同一写法则直接返回「已阻止」。

例程是无人值守的：默认自动拒绝危险操作，需要时在例程设置里勾「允许危险操作」。
左栏「🛡 审批」可查审计记录（`approvals.jsonl`，只记有风险的操作）。

详见 [docs/approval.md](docs/approval.md)。

## 例程（定时任务）

给 Bot 挂时间表，到点自动干活：

| 方式 | 例子 |
| --- | --- |
| 固定间隔 | 每 60 分钟巡检一次 |
| 每天 | 每天 09:00 整理待办 |
| 每周 | 每周一 08:30 出周报 |

实测：创建一条「每分钟巡检」例程后**不做任何操作**，一分钟后自动完成
6 步工具调用，把时间写进文件并读回校验，同时记录了耗时与摘要。

每条例程保留最近 20 条执行记录，界面可看「上次成功/失败」并手动触发测试。
详见 [docs/routines.md](docs/routines.md)。

## MCP

通过 MCP 让 Bot 获得外部能力，工具自动以 `mcp__<服务器>__<工具>` 注入。

实测：接入一个提供 `add_numbers` 的 MCP 服务器后，问「算一下 1234 + 5678」，
模型自己调用 `mcp__calc__add_numbers`，返回 6912。

支持 stdio（本地进程）与 http（远程端点）两种传输。
详见 [docs/mcp.md](docs/mcp.md)。

## Bot 协作

三种方式，模型自己按场景选：

| 工具 | 同步性 | 用途 |
| --- | --- | --- |
| `delegate_to_bot` | 阻塞等结果 | 需要对方产出 |
| `message_bot` | 不阻塞 | 通知、转交、分派 |
| `start_group_chat` | 依次等待 | 多方讨论 |

实测：研究官给撰稿人留言 → 撰稿人下次对话第一句就是
「团队有一条待办：研究官今晚 8 点前需要一篇短文」。

详见 [docs/collab.md](docs/collab.md)。

## 技能

技能存在 `%APPDATA%\Grok Bot\skills\<名称>\SKILL.md`，格式与 Codex 兼容：

```markdown
---
name: 写日报
description: 需要生成工作日报、周报时使用。
---
# 步骤
1. ...
```

Bot 的调用方式（渐进式加载）：

1. 技能清单（名称+描述）自动注入系统提示
2. 任务匹配时，模型调用 `use_skill` 读正文，再按步骤执行

实测跑通：`use_skill → run_command → write_file → read_file`，
严格按技能定义的结构产出日报文件。

也可以**直接点名**：在输入框用 `@技能名`（支持中文名或英文 id，`@` 会弹出候选），
正文会被强制加载并严格执行，跳过「模型自己判断要不要用」这一步。

在「Bot 设置 → 启用的技能」里可按 Bot 隔离（不勾 = 全部可用）。
详见 [docs/skills.md](docs/skills.md)。

## 计算机抽象（为云端预留）

Grok Bot 的核心抽象是「计算机」：一个账号共享一台持久计算机，
所有 Bot 在上面工作，安全边界在账号级。

当前用**本机**实现，云端接口已全部预留：

```json
"computer": { "kind": "local" }
"computer": { "kind": "remote", "baseUrl": "https://vm.example.com", "token": "..." }
```

也可以在「设置 → 执行环境」里切换。

| 能力 | 本机 | 云端 |
| --- | --- | --- |
| 文件读写 | ✅ | ✅ 已实现 |
| 命令执行 | ✅ | ✅ 已实现 |
| 浏览器 | ❌ | ✅ 已实现 |
| 屏幕观看 / 接管 | ❌ | ✅ 已实现 |
| 关应用后继续跑 | ❌ | 依赖服务端 |

完整接口契约见 [docs/cloud-computer.md](docs/cloud-computer.md)，
含每个端点的请求/响应格式和最小服务端示例。

自检命令（会起一台模拟云计算机，验证本地与云端行为一致）：

```powershell
node scripts/verify-cloud.js
```

## 架构

```
渲染层 (HTML/CSS/JS)
   │  IPC
主进程 (main.js)
   ├── store/store.js         Bot、会话、设置的持久化
   ├── skills/skill-store.js  技能读写（SKILL.md）+ 导入
   ├── mcp/                   MCP 客户端与管理器
   ├── collab/collab-bus.js   协作总线（留言/群聊）
   ├── routines/              例程（定时任务调度）
   ├── memory/memory-store.js 长期记忆（profile / log）
   ├── approval/             审批边界（策略 / 网关 / 审计）
   ├── computer/              计算机抽象（本机 / 云端可切换）
   │    ├── computer.js           接口契约
   │    ├── local-computer.js     本机实现
   │    ├── remote-computer.js    云端实现（HTTP 契约）
   │    └── factory.js            按配置选择
   └── agent/
        ├── model-client.js   Responses API 流式 + function calling
        ├── mentions.js       `@技能名` 解析（强制加载）
        └── loop.js           Agent 循环：模型 → 工具 → 回传 → 继续
             └── tools/
                  ├── registry.js   工具定义
                  └── executor.js   沙箱内执行（路径校验、超时、输出上限）
```

关键设计：

- **工具循环在本地**：模型只负责决策，执行都在你机器上
- **路径沙箱**：所有文件操作经 `safeResolve` 校验，越界直接拒绝
- **命令隔离**：PowerShell 强制 UTF-8 输出，超时强杀，输出截断
- **审批边界**：危险操作执行前暂停等人确认；例程无人值守时安全拒绝
- **可扩展**：在 `tools/registry.js` 加定义、`executor.js` 加实现即可

## 目录

```
app/                  应用源码（打包成 app.asar）
  src/main/           主进程 + Agent 引擎 + 工具
  src/preload/        IPC 桥
  src/renderer/       界面
scripts/build-app.js  打包 / 安装
dist/app/             成品（可直接运行）
```

## 数据位置

`%APPDATA%\Grok Bot\`
- `app.json` — 设置
- `bots/<id>/bot.json` — Bot 配置
- `bots/<id>/sessions/*.json` — 会话
- `workspaces/<id>/` — Bot 的工作文件

## 常用命令

```powershell
npm run build          # 打包到 dist/app
npm run build:install  # 安装到 %LOCALAPPDATA%\Programs\GrokBot
npm run verify:cloud   # 自检云计算机接口（本地/云端一致性）
npm run verify:approval  # 审批策略与状态机自检（离线，120 项）
npm run verify:approval:e2e  # 审批端到端自检（mock 模型，13 项）
npm run clean          # 清理构建残留（被占用时加 --force）
```

## 已知限制

- 只在 Windows 上测过（PowerShell 执行）
- 没有做代码 diff 预览和撤销（写文件直接覆盖）
- 审批是静态匹配，混淆写法的命令仍可能漏判；`run_command` 也仍可访问工作目录外的路径。
  永久拒绝只是黑名单（13 条），不是牢笼 —— 真正的防线是「有风险就问」
- 委派是同步阻塞的，子 Bot 跑完才返回

## 开发与自检

本项目仓库只放源码（`dist/`、`build/` 已忽略，约 637 MB）。克隆后先跑
`npm run build` 生成可执行产物，再 `launch.cmd` 启动。

```powershell
npm install            # 只用于本地工具链（electron/asar 由 npx 拉取）
npm run build          # 打包到 dist/app
npm run verify:all     # 全套回归（部分用例需先关掉正在运行的应用）
```

