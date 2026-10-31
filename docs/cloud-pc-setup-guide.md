# 链接到云电脑：完整操作步骤（手把手）

本文把「怎么把家里一台 Mac 变成 Grok Bot 的云电脑，并在另一台电脑上连上它」讲清楚，
**每一步都可以照着做**。重点讲三件事：

1. **云端电脑（Mac）要怎么配置** —— 装服务端、装浏览器、常驻、常醒
2. **怎么去 Cloudflare 配置** —— 域名托管、创建 Tunnel、绑定公网地址、加防护
3. **App 里怎么连** —— 填地址 + token

> 一句话原理：Mac 上的 `cloudflared` 主动向外连 Cloudflare 边缘，Cloudflare 再把
> `https://你的域名` 的流量转回本机。所以**不需要公网 IP、不需要端口映射、不需要 DDNS**。

---

## 〇、先分清两个角色

| 角色 | 在哪 | 跑什么 | 干什么 |
| --- | --- | --- | --- |
| **云端电脑（服务端）** | 家里那台 Mac | `server/grok-server.js`（纯 Node）+ Chrome + cloudflared | 文件读写、跑命令、开浏览器 |
| **客户端（App）** | 你的笔记本 / 任意电脑 | Grok Bot 桌面程序 | 界面、模型调用、例程调度 |

关键点：

- **Mac 上不需要装 Electron App**，只要 Node 22+ 和 Chrome。
- App 只是「遥控器」，真正干活的是 Mac 上的服务端。
- 想 24h 无人值守跑例程，**App 所在的机器也得常开**（收进托盘即可，别点「退出」）。
  详见文末「三个约束」。

---

## 一、前置条件（先备齐）

- 一台 **macOS**（Intel / Apple Silicon 都行）
- **Node.js 22+**（浏览器自动化用了全局 `WebSocket`，必须 22+）
- 家里 Mac 装了 **Google Chrome**（浏览器自动化要用）
- 一个**托管在 Cloudflare 的域名**（Nameserver 指向 Cloudflare，免费套餐即可）
- 一台**有界面的电脑**跑 Grok Bot App（当前只有 Windows 版打包）

---

## 二、第一步：配置「云端电脑」（Mac）

### 2.1 装 Node.js 22+

没有 Homebrew 先去 https://brew.sh 装，然后：

```bash
brew install node
node -v   # 应 >= v22
```

### 2.2 装 Chrome

正常安装 Google Chrome 即可。若 Chrome 不在默认路径，用环境变量指定：

```bash
export GROKBOT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

### 2.3 把仓库代码放到 Mac 上

```bash
git clone https://github.com/Lucas215zz/GrokBot.git
cd GrokBot
```

（Mac 上只需要 `server/` 和 `deploy/` 两个目录，不用 `npm install`。）

### 2.4 初始化服务端 + 生成 token

```bash
node server/grok-server.js --init
```

输出里会打印一串 **token**，先复制记下来（也可随时用下面的命令再查）：

```bash
node server/grok-server.js --print-token
```

> token 存在 `~/.grokbot-server/token`，权限 0600。它是 App 连进来的「密码」，
> 别泄露。

### 2.5 装成常驻服务（开机自启、崩溃自动拉起）

```bash
bash deploy/macos/setup.sh
```

脚本做四件事：生成配置 + token → 装 `com.grokbot.server` LaunchAgent →
启动 → 自检并打印 token。

验证本机服务已就绪：

```bash
TOKEN=$(node server/grok-server.js --print-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/health
# 期望：{"ok":true,"id":"...","os":"darwin","persistent":true}
```

### 2.6 保持常醒（关键，否则半夜就睡着了）

云电脑要 24h 在线，但 Mac 默认会睡眠。跑：

```bash
bash deploy/macos/keep-awake.sh
```

脚本会关掉睡眠、合盖不休眠、断电自恢复。然后**手动做两件脚本改不了的事**：

1. **开自动登录**：系统设置 → 用户与群组 → 自动登录 → 选你的账号
   （没有该选项就先关「文件保险箱 FileVault」）
2. **关掉锁屏密码**：系统设置 → 锁定屏幕 → 要求密码：改为「永不」或 8 小时

> 浏览器自动化必须跑在「已登录的 GUI 会话」里，所以自动登录 + 不锁屏是硬要求。

验证：`pmset -g custom`，看 `sleep` / `displaysleep` 是不是 0。

到这里，**云端电脑（本机 127.0.0.1:8787）已经就绪**。下面把它暴露到公网。

---

## 三、第二步：配置 Cloudflare（重点）

### 3.1 把域名托管到 Cloudflare

1. 打开 https://dash.cloudflare.com ，注册 / 登录。
2. 点 **Add a site**，输入你的域名（比如 `example.com`），选 **Free** 套餐。
3. Cloudflare 会给你**两条 Nameserver**，去你的域名注册商（阿里云/腾讯云/GoDaddy 等）
   把域名的 NS 改成这两条。
4. 回来点 **Done, check nameservers**，等生效（几分钟到几小时，邮箱会收到激活通知）。

> 域名托管是 Cloudflare 一切功能的前提，没托管成，后面 Tunnel 建了也解析不了。

### 3.2 进入 Zero Trust 面板

Tunnel 现在归在 Cloudflare 的 **Zero Trust** 面板里管理：

1. 在 dash.cloudflare.com 左侧菜单点 **Zero Trust**（会跳到 https://one.dash.cloudflare.com ）。
2. 首次进入会让你起一个团队名（team name），随便起，免费版可用。
3. 进入后左侧菜单找到 **Networks → Tunnels**。

### 3.3 创建 Tunnel（面板方式）

1. 在 **Networks → Tunnels** 页面点 **Create a tunnel**。
2. Tunnel type 选 **Cloudflared**（自托管，免费）。
3. **Tunnel name** 填 `grokbot`，点 **Save tunnel**。
4. 下一步页面会显示一段安装命令，**Mac 上这样执行**：

   ```bash
   brew install cloudflared
   sudo cloudflared service install <页面给的那一长串 token>
   ```

   执行完，回到面板，tunnel 状态会变成 **Healthy**（绿点）。

> 如果你更喜欢让脚本自动完成（login / create / route dns 全自动），也可以跳过
> 3.3～3.5，直接跑：
>
> ```bash
> bash deploy/macos/tunnel-setup.sh grok.example.com
> ```
>
> 它会自动完成下面所有 CLI 步骤并装好 LaunchAgent。下面的 3.4 是「手动理解每一步」
> 的等价做法，二选一即可。

### 3.4 手动方式：装 cloudflared 并绑定域名（等价 CLI 步骤）

如果你不想用面板的 `service install`，用命令行的等价流程：

```bash
brew install cloudflared

# 登录 Cloudflare（弹浏览器，选你要用的那个域名授权）
cloudflared tunnel login

# 创建 tunnel，返回一个 tunnel id
cloudflared tunnel create grokbot

# 把域名解析到 tunnel（会自动建一条 CNAME）
cloudflared tunnel route dns grokbot grok.example.com
```

凭据会生成在 `~/.cloudflared/<tunnel-id>.json`。

### 3.5 配置 Public Hostname（把域名路由到 8787）★ 最关键一步

Tunnel 建好后，要告诉 Cloudflare「公网哪个域名 → 转回本机哪个端口」。

**面板方式：**

1. 在 Tunnels 列表里点你的 `grokbot`（或点它右边的 `···` → **Configure**）。
2. 切到 **Public Hostname** 标签页，点 **Add a public hostname**。
3. 填：

   | 字段 | 值 |
   | --- | --- |
   | Subdomain | `grok` |
   | Domain | 下拉选 `example.com` |
   | Path | 留空 |
   | Type | `HTTP` |
   | URL | `127.0.0.1:8787` |

4. 点 **Save hostname**。

**配置文件方式（等价）：** 编辑 `~/.cloudflared/config.yml`：

```yaml
tunnel: <你的 tunnel id>
credentials-file: /Users/<你>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: grok.example.com
    service: http://127.0.0.1:8787
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
```

> 最后一行 `http_status:404` 是兜底：没匹配到的域名一律 404，不暴露任何东西。

### 3.6 确认 DNS 记录已自动创建

回到 dash.cloudflare.com → 你的域名 → **DNS**，应该看到一条：

```
CNAME   grok   <tunnel-id>.cfargotunnel.com   （橙色云，proxied）
```

这条记录是 3.4 的 `route dns` 或 3.5 的面板操作自动建的，**不要手改**。

### 3.7 验证公网能通

```bash
TOKEN=$(node server/grok-server.js --print-token)
curl -H "Authorization: Bearer $TOKEN" https://grok.example.com/health
# 期望：{"ok":true,...}
```

> DNS 生效通常 1-2 分钟；打不开先等一会再试，或看 `~/Library/Logs/grokbot/tunnel.err.log`。

---

## 四、第三步：在 App 里链接云电脑

在**另一台**电脑（或同一台）打开 Grok Bot：

1. 右上角 **设置** → **执行环境** → **云计算机**。
2. 填：
   - **地址**：`https://grok.example.com`
   - **Token**：Mac 上 `node server/grok-server.js --print-token` 的输出
3. 保存。

保存后，所有 Bot 的文件 / 命令 / 浏览器操作都会落到家里那台 Mac 上。

---

## 五、（强烈建议）加一层 Zero Trust Access 防护

`/exec` 本质是远程代码执行。虽然服务端已经加了 token + 危险命令黑名单 + 路径沙箱，
但**域名一旦泄露，光靠一个 token 不够稳**。加 Access 后，访问者必须先过邮箱验证码。

> ⚠️ 一个要提前知道的事：加了 Access 后，普通请求会被 302 到登录页。
> 当前 App 的远程客户端**只带 Bearer token，不带 CF-Access 头**，所以直接用
> 「邮箱验证码」策略会让 App 连不上。给 App 用请走 **Service Token**（见下）。

### 方式 A：Service Token（推荐给 App 用）

1. Zero Trust → **Access → Service Auth → Service Tokens** → **Create Service Token**。
2. 起个名字，生成 **Client ID** 和 **Client Secret**（Secret 只显示一次，存好）。
3. 在 Access Application 的策略里，加一条 **Include 规则：Service Token = 你刚建的那个**，
   并把默认的邮箱规则删掉。
4. App 请求时带上这两个头（需要在 `remote-computer.js` 的请求头里补）：

   ```
   CF-Access-Client-Id: <Client ID>
   CF-Access-Client-Secret: <Client Secret>
   ```

### 方式 B：先不加 Access，只靠 token

如果不想改 App，就**先不加 Access**，靠现有的 token + 每 IP 限流（600/分钟）+
危险命令黑名单 + 路径沙箱兜底。等 App 支持 CF-Access 头再补。

### 方式 C：给「人看」的入口加邮箱验证（可选）

如果以后要做「人在手机/浏览器上看云电脑屏幕」，给那个人类入口单独加
`Emails = 你的邮箱` 的 Access 策略即可，与 App 的 Service Token 策略互不影响。

---

## 六、日常运维

```bash
bash deploy/macos/setup.sh --status          # 服务端状态 + 健康检查
bash deploy/macos/tunnel-setup.sh --status   # tunnel 状态

launchctl kickstart -k gui/$(id -u)/com.grokbot.server   # 重启服务端
launchctl kickstart -k gui/$(id -u)/com.grokbot.tunnel   # 重启 tunnel

tail -f ~/Library/Logs/grokbot/grok-server.err.log
tail -f ~/Library/Logs/grokbot/tunnel.err.log
```

---

## 七、故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `https://域名/health` 打不开 | DNS 未生效（等 1-2 分钟）；或 tunnel 没起（看 `tunnel.err.log`） |
| 502 / 1033 | 本机 `8787` 没起，先 `bash deploy/macos/setup.sh --status` |
| 浏览器工具报「找不到 Chrome」 | 装 Chrome，或 `export GROKBOT_CHROME=...` |
| `node` / `git` 找不到 | launchd PATH 很窄，plist 已补 `/opt/homebrew/bin`；自定义工具用绝对路径 |
| 浏览器截图黑屏 / 起不来 | LaunchAgent 必须在**已登录的 GUI 会话**里跑；确认开了自动登录、没锁屏 |
| 一段时间后连不上 | Mac 睡眠了，跑 `bash deploy/macos/keep-awake.sh` 并开自动登录 |
| 401 | token 不对，重新 `node server/grok-server.js --print-token` |
| 加了 Access 后 App 连不上 | App 没带 `CF-Access-*` 头；用 Service Token（见方式 A）或先撤掉 Access |

---

## 八、必须知道的三个约束

1. **例程调度还在 App（Electron 主进程）里，不在 Mac 服务端。**
   Tunnel 只解决「连得上」，**不解决「App 退出后例程还在跑」**。
   - 只想「人在外面也能让 Bot 操作家里 Mac」→ App 开在笔记本即可，用完可关。
   - 想「24h 无人值守跑例程」→ **App 所在的机器必须常开**（收进托盘，别点「退出」）。

2. **`/exec` 是远程代码执行。** 已加 Bearer token（常量时间比较）+ 危险命令黑名单 +
   路径沙箱（防 `../` 与符号链接逃逸）。仍建议在 Cloudflare 侧套 Service Token 防护。

3. **Mac 必须保持「已登录的 GUI 会话」。** 浏览器自动化依赖交互式桌面，
   需要开自动登录、禁止睡眠，用 LaunchAgent（不是 LaunchDaemon），否则 Chrome 起不来。

---

## 九、安全设计速览（服务端默认姿态是「宁可拒绝」）

- 默认只监听 `127.0.0.1`，公网只能经 `cloudflared` 进来
- 所有请求要 `Authorization: Bearer <token>`，`crypto.timingSafeEqual` 比较
- token 存 `~/.grokbot-server/token`，权限 0600
- 每 IP 限流（默认 600 次/分钟）
- 文件操作锁在 `~/.grokbot-server/workspaces/<botId>/`，`realpathSync` 双重校验防符号链接逃逸
- `/exec` 有超时（默认 120s）、输出截断、内置黑名单（`rm -rf /`、`diskutil eraseDisk`、
  `csrutil disable`、`killall WindowServer` 等）

---

## 十、自检

Mac 上跑完整端到端自检（24 项）：

```bash
node scripts/verify-mac-server.js
```

本地验证云计算机接口契约（本地/云端行为一致性）：

```powershell
node scripts/verify-cloud.js
```
