# 用家里的 Mac 当「云电脑」

把一台常开在家的 Mac 变成 Grok Bot 的云计算机，这样你人在外面（或换另一台电脑）
也能让 Bot 在「家里那台机器」上读写文件、跑命令、开浏览器。

> 一句话结论：**用 Cloudflare Tunnel，不需要公网 IP、不需要端口映射、不需要 DDNS。**
> 你原来纠结的「IP 一变就要去改域名」在 Tunnel 模式下根本不存在。

## 为什么不用公网 IP + 端口映射

| 方案 | 公网 IP | 端口映射 | DDNS | 运营商封 80/443 | 安全性 |
| --- | --- | --- | --- | --- | --- |
| 公网 IP 直连 + 端口映射 | 需要 | 需要 | 需要（IP 动态变） | 会挡 80/443 | 端口直接暴露，差 |
| 自己写 DDNS 脚本 | 需要 | 需要 | 自己维护 | 会挡 80/443 | 同上，还得自己兜住 |
| **Cloudflare Tunnel** | **不需要** | **不需要** | **不需要** | **无所谓** | 出站连接 + 可加 Zero Trust |

Tunnel 的原理：Mac 上的 `cloudflared` 进程**主动向外**连 Cloudflare 边缘节点，
Cloudflare 再把 `https://你的域名` 的流量通过这条已建立的连接转回本机。

```
 你的笔记本 / 手机
        │  https://grok.example.com
        ▼
 Cloudflare 边缘  ──(加密长连接，由 Mac 主动发起)──►  家里的 Mac
                                                        ├─ cloudflared
                                                        └─ grok-server 127.0.0.1:8787
                                                           └─ Chrome / 文件 / 命令
```

因为连接是「从家里往外打」的：

- 家里 IP 天天变？无所谓，是 Mac 去找 Cloudflare，不是 Cloudflare 找 Mac。
- 运营商封 80/443？无所谓，出站 443 是通的就行。
- 路由器不用开任何端口，攻击面为零（除非域名泄露且没加 Access）。

## 整体架构

本仓库把「执行环境」抽象成一台**计算机**，上层 Agent 完全不用改。本机模式和
远程（云）模式走同一套工具接口：

**两个角色要分清楚：**

- **服务端（家里 Mac）**：只跑 `server/grok-server.js`（纯 Node，不需要 Electron），
  负责文件 / 命令 / 浏览器。用 LaunchAgent 常驻 + `cloudflared` 暴露到公网。
- **App（你的笔记本 / 任意一台有界面的电脑）**：跑 Grok Bot 桌面程序，负责界面、
  模型调用、以及**例程调度**。设置里把执行环境切到「云计算机」，指向 Mac 的域名。

> 也就是说：**Mac 上不需要装 Electron App**，只要 Node + Chrome 就行。
> 想 24h 无人值守跑例程，则「App 所在的机器」也得常开（见文末约束 1）。

| 组件 | 作用 |
| --- | --- |
| `server/grok-server.js` | 跑在 Mac 上的服务端（纯 Node），实现文件 / 命令 / 浏览器等端点 |
| `deploy/macos/setup.sh` | 把服务端装成 LaunchAgent（开机自启、崩溃拉起） |
| `deploy/macos/tunnel-setup.sh` | 装 `cloudflared` 并配好 Tunnel + LaunchAgent |
| `deploy/macos/keep-awake.sh` | 关闭睡眠、合盖不休眠、提醒开自动登录 |
| App 里「设置 → 执行环境 → 云计算机」 | 填 `https://你的域名` + token |

## 前提

- macOS（Intel / Apple Silicon 都行），已装 **Node.js 22+**（`brew install node`）。
  文件 / 命令功能 18+ 就够，但**浏览器自动化用了全局 `WebSocket`，需要 Node 22+**。
- 有一个**托管在 Cloudflare 的域名**（Nameserver 指向 Cloudflare，免费套餐即可）
- 家里 Mac 已安装 **Google Chrome**（浏览器自动化要用；也可用 `GROKBOT_CHROME` 指定路径）
- 一个常开的登录用户会话（见文末「必须知道的三个约束」）

## 部署步骤

### 1. 先让服务端在本机跑起来

```bash
cd /path/to/Grok_Bot
bash deploy/macos/setup.sh
```

脚本会：生成配置 + 随机 token → 装 `com.grokbot.server` LaunchAgent →
启动 → 自检 → 打印 token。

自检通过后，本机应该能：

```bash
TOKEN=$(node server/grok-server.js --print-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/health
# {"ok":true,"id":"...","os":"darwin","persistent":true}
```

### 2. 配 Cloudflare Tunnel

```bash
bash deploy/macos/tunnel-setup.sh grok.example.com
```

脚本会：

1. 检查 / `brew install cloudflared`
2. `cloudflared tunnel login`（弹浏览器，选你的域名授权）
3. `cloudflared tunnel create grokbot` → 拿 tunnel id + 凭据
4. `cloudflared tunnel route dns grokbot grok.example.com` → 自动建 CNAME
5. 生成 `~/.cloudflared/config.yml`
6. 装 `com.grokbot.tunnel` LaunchAgent（开机自启、崩溃拉起）
7. 用公网地址自检 `https://grok.example.com/health`

> DNS 生效通常 1-2 分钟，脚本自检失败不代表配错，稍等再 `curl` 一次即可。

### 3. 在 App 里切换执行环境

在**另一台**（或同一台）电脑打开 Grok Bot：

**设置 → 执行环境 → 云计算机**

- 地址：`https://grok.example.com`
- Token：`node server/grok-server.js --print-token` 的输出

保存后，所有 Bot 的文件 / 命令 / 浏览器操作都会落到家里那台 Mac 上。

### 4. （强烈建议）加一层 Zero Trust Access

`/exec` 本质是远程代码执行。虽然服务端已加 token + 危险命令黑名单 + 路径沙箱，
但域名一旦泄露，光靠一个 token 不够稳。加 Access 后，访问者必须先过邮箱验证码：

Cloudflare 面板 → **Zero Trust → Access → Applications → Add an application**

- 类型：**Self-hosted**
- Application domain：`grok.example.com`
- Policy：**Allow**，条件 `Emails` = 你自己的邮箱
- （可选）Session 时长设长一点，免得天天验证

配好后，App 请求会带上 Cloudflare 的 Access 会话；首次需要在浏览器里过一次验证。

## 日常运维

```bash
bash deploy/macos/setup.sh --status          # 服务端状态 + 健康检查
bash deploy/macos/tunnel-setup.sh --status   # tunnel 状态
launchctl kickstart -k gui/$(id -u)/com.grokbot.server   # 重启服务端
launchctl kickstart -k gui/$(id -u)/com.grokbot.tunnel   # 重启 tunnel

tail -f ~/Library/Logs/grokbot/grok-server.err.log
tail -f ~/Library/Logs/grokbot/tunnel.err.log
```

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `https://域名/health` 打不开 | DNS 未生效（等 1-2 分钟）；或 tunnel 没起（看 `tunnel.err.log`） |
| 502 / 1033 | 本机 `8787` 没起，先 `bash deploy/macos/setup.sh --status` |
| 浏览器工具报「找不到 Chrome」 | 装 Chrome，或 `export GROKBOT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` |
| `node`/`git` 找不到 | launchd PATH 很窄，plist 里已补 `/opt/homebrew/bin`；自定义工具请用绝对路径 |
| 浏览器截图黑屏 / 起不来 | LaunchAgent 必须在**已登录的 GUI 会话**里跑；确认开了自动登录、没锁屏 |
| 一段时间后连不上 | Mac 睡眠了，跑 `bash deploy/macos/keep-awake.sh`，并开自动登录 |
| 401 | token 不对，重新 `node server/grok-server.js --print-token` |

## 必须知道的三个约束

1. **例程调度还在 App（Electron 主进程）里，不在 Mac 服务端。**
   Tunnel 只解决「连得上」，**不解决「App 退出后例程还在跑」**。
   - 只想「人在外面也能让 Bot 操作家里 Mac」→ App 开在笔记本即可，用完可关。
   - 想「24h 无人值守跑例程」→ **App 所在的机器必须常开**（收进托盘即可，关窗口≠退出，
     别点「退出」）。当前只有 Windows 版打包；若要让 Mac 也跑 App，需另建 macOS 的
     Electron 产物。彻底把调度器拆进服务端是另一件事，目前没做。

2. **`/exec` 是远程代码执行。**
   已加 Bearer token（常量时间比较）+ 危险命令黑名单 + 路径沙箱（防 `../` 与符号链接逃逸）。
   仍然建议在 Cloudflare 侧套 Zero Trust Access。

3. **Mac 必须保持「已登录的 GUI 会话」。**
   浏览器自动化依赖交互式桌面。需要开自动登录、禁止睡眠；
   用 LaunchAgent（不是 LaunchDaemon），否则 Chrome 起不来。

## 安全设计速览

`server/grok-server.js` 的默认姿态是「宁可拒绝」：

- 默认只监听 `127.0.0.1`，公网只能经 `cloudflared` 进来
- 所有请求要 `Authorization: Bearer <token>`，`crypto.timingSafeEqual` 比较
- token 存 `~/.grokbot-server/token`，权限 `0600`
- 每 IP 限流（默认 600 次/分钟）
- 文件操作锁在 `~/.grokbot-server/workspaces/<botId>/`，`realpathSync` 双重校验防符号链接逃逸
- `/exec` 有超时（默认 120s）、输出截断、内置黑名单（`rm -rf /`、`diskutil eraseDisk`、
  `csrutil disable`、`killall WindowServer` 等）

## 自检

```bash
node scripts/verify-mac-server.js
```

会起一个临时服务端，跑 24 项端到端检查：鉴权、文件读写、路径沙箱、Bot 隔离、
命令执行、危险命令拦截、浏览器方法非占位、capabilities。
