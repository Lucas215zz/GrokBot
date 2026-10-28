# 审批边界（Approval）

> 危险操作先停下来问你。默认开启，例程默认无人值守。

## 一、为什么需要

Bot 能直接跑 PowerShell。路径沙箱只约束**文件读写**，管不住：

- `Remove-Item -Recurse` 删掉整个目录
- `npm install` 拉未知代码、`git push` 外发
- `Get-Content ~/.ssh/id_rsa` 读密钥
- `Set-ExecutionPolicy`、`taskkill`、`schtasks` 改系统
- `delegate_to_bot` 把「删文件」转包给另一个 Bot

审批边界就是补这一层：**执行前**判定风险，停下来等人拍板。

## 二、四档风险

| 档 | 典型操作 | 默认（balanced） |
| --- | --- | --- |
| **只读** | `list_files`、`read_file`、`search_text`、`git status` | 直接放行 |
| **普通写 / 执行** | `write_file`、`npm run build`、`python train.py` | 写放行，**执行要问** |
| **需要确认** | 删除、联网、凭据、系统变更、Bot 协作、MCP、内联脚本、**未登记工具** | **要问** |
| **永久拒绝** | `Format-Volume`、`diskpart`、`bcdedit`、`del C:\`、删 `C:\Windows` | **直接拦，不可放行** |

重要细节：**shell 命令不受工作目录沙箱限制**，所以「随便跑个命令」本身算风险。
只有确凿只读的入口（`Get-ChildItem` / `git status` / `npm ls` 等）免问，
`python x.py`、`node x.js`、`npm run` 一律要问 —— 它们能执行任意代码。

### 哪些东西不能「默认放行」

早期的分类有一个危险的默认值：**没登记过的工具直接按只读放行**。这意味着
以后新加一个工具、忘了在 `policy.js` 加分支，边界会静默失效。现在改成：

- 未登记工具 → `unknown` 档，**要问**（只有 `off` 策略才不问）
- 文件工具（`read_file` / `write_file` / `list_files` / `search_text`）的 `path`
  命中 `.env`、`credentials.json`、`.ssh/`、`.aws/` 等 → 归到 `secret` 档，**要问**
  （否则「读密钥」只要不用 `run_command` 就能绕开）
- `browser_navigate` → `network` 档（会把网址带出去，也可能把上下文带出去）
- `remember` 写 `profile` 层 → `memory` 档（profile 每轮都注入，等于往系统提示里塞内容，
  是提示注入的落点）。注意：`memory` 档只在 `strict` 策略下会问，`balanced` 默认不问，
  以免「叫我老李」这种日常偏好每次都要点确认。介意这一点就切到 `strict`。

## 三、四种策略

设置 → 审批策略，或顶栏 `🛡` 徽章（点击直达）。

| 策略 | 问什么 |
| --- | --- |
| `strict` 严格 | 任何写操作、任何命令、MCP、协作都问 |
| `balanced` 标准（默认） | 执行命令、删除、联网、凭据、系统、协作、MCP |
| `relaxed` 宽松 | 只问删除、联网、凭据、系统 |
| `off` 关闭 | 只保留「永久拒绝」 |

Bot 可单独覆盖：Bot 设置 → 审批策略 → 跟随全局 / 严格 / 标准 / 宽松 / 关闭。

## 四、弹窗上的三个按钮

| 按钮 | 效果 |
| --- | --- |
| 允许这一次 | 只放行这一次调用 |
| 本次运行都允许 | 本次任务内，**同一类**操作不再问 |
| 本会话都允许 | 当前对话内，同一类操作不再问（重启失效） |

「拒绝」会被记住：模型用**同一写法**重试时不再弹窗，直接返回「已阻止」，
避免它靠换个路径反复撞墙。换了写法（不同命令）会重新问。

弹窗 **5 分钟无响应自动拒绝**；点停止按钮时，挂起的审批立刻按拒绝收尾。
按 Esc 关不掉审批弹窗 —— 必须明确选一个。

窗口如果被刷新（重载），仍在等待的那条审批会**自动重新弹出来**，不用干等超时。

## 五、例程（无人值守）

例程在你不在电脑前跑，弹窗没人点。所以：

- 默认**自动拒绝**危险操作，并把原因写回给模型
- 需要时在例程设置里勾「允许危险操作」

## 六、审计

左栏「🛡 审批」查看记录，落盘在 `%APPDATA%\Grok Bot\approvals.jsonl`。

只记有风险的操作（只读不记）。记录字段：

```json
{"at":1730000000000,"botName":"代码助手","tool":"run_command","category":"delete",
 "decision":"denied","decidedBy":"user","summary":"Remove-Item .\\a.txt","unattended":false}
```

- 不写文件内容，只留参数摘要
- 最多读回最近 300 条
- 界面可一键清空

## 七、程序接口

```js
const verdict = await approvals.ask({
  runId, sessionId, botId, botName,
  tool: "run_command",
  args: { command: "Remove-Item x" },
  mode: "balanced",     // 可选，Bot 覆盖
  unattended: false,    // 例程传 true
  autoApprove: false,   // 例程勾了「允许危险操作」传 true
  signal,               // 停止任务时立刻收尾
});
// → { allowed, category, decidedBy, reason, classification }
```

`executeTool` 会在执行前调用 `ctx.approve`；拒绝时返回
`已阻止：<原因>`，模型据此换更安全的做法。

## 八、自检

```powershell
npm run verify:approval       # 120 项：分类 / 策略矩阵 / 状态机 / 防绕过 / 审计（离线）
npm run verify:approval:e2e   # 13 项：真实 Agent 循环端到端（用 mock 模型）
node scripts/verify-approval-live.js --live   # 走真实模型路由器
```

## 九、当前限制

- **静态匹配，不是语义理解**。混淆写法（`& ($a+$b)` 拼出来的命令）可能漏判，
  但 `-EncodedCommand`、`Invoke-Expression`、`| sh` 这类已明确归类为「内联脚本」要问。
- **不限制路径**。`run_command` 仍可读写工作目录之外的文件（这是 PowerShell 的本性），
  审批只保证「你会知道」，不保证「做不到」。
- **记忆按进程保存**。「本会话都允许」重启即失效，不会持久化。
- 只拦工具调用，**拦不住 MCP 服务器自己内部的行为**（只能拦「要不要调这个工具」）。
- **永久拒绝是黑名单，不是牢笼**。它覆盖的是「明显毁系统」的写法（格式化、分区、
  删盘符根、删系统目录、改启动项、删注册表系统键……），以及经 `cmd /c`、`rm --no-preserve-root`
  转一手的等价写法；但**任何黑名单都不可能穷尽**，绕过黑名单仍可能造成破坏。真正的安全来自
  「有风险就问你」这一层，黑名单只是减少误点「允许」的代价。

