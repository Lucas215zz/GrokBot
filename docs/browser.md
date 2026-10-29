# 本机浏览器（真实浏览器自动化）

之前的状况：Agent 只有一个 `browser_navigate`，而本机实现直接报
「这台计算机不支持浏览器」。想在网页上点选 / 采集 / 注入脚本，只能让用户手动开一个
带 `--remote-debugging-port=9333` 的 Chrome，脚本再连过去。用户一旦没开、或换了机器，
整条自动化链路就断。

现在的做法：**Bot 自己会拉起一个独立 profile 的 Chrome**，用 CDP（Chrome DevTools Protocol）
直接驱动它；也支持「接管模式」去连用户已经开好的浏览器。

## 两种模式

### 1. 自有模式（默认）

第一次真正用到浏览器时，`computer/browser.js` 会：

```text
chrome.exe
  --user-data-dir=<userData>\browser-profile   登录态持久化，重启还在
  --remote-debugging-port=0                     自动分配端口
  --no-first-run --no-default-browser-check
  about:blank
```

然后读 `<userData>\browser-profile\DevToolsActivePort` 拿到端口，连上去。
浏览器进程是**受控资源**：应用退出（`dispose`）时一起关掉，不像用户自己的 Chrome 常驻。

首次使用需要在设置面板点「打开浏览器」，在弹出的窗口里手动登录一次目标站点
（例如 TikTok Shop Partner Center）。之后登录态留在 `browser-profile` 里，定时任务就能自己操作。

### 2. 接管模式

`app.json` 里配置：

```json
{ "browser": { "attach": "http://127.0.0.1:9333" } }
```

就完全不自己起进程，直接连你已有的 CDP 端点（比如你自己开的调试 Chrome / 别的 profile）。
应用退出时也不会去杀那个浏览器。适合「我已经有一个常年登录的专用 Chrome」的场景。

## Agent 工具

| 工具 | 作用 | 风险档 |
| --- | --- | --- |
| `browser_navigate` | 打开网址（缺协议自动补 `https://`） | network |
| `browser_snapshot` | 列出当前页可交互元素，打 `gbN` 编号并返回文本清单 | safe |
| `browser_click` | 点某个 `gbN` | network |
| `browser_type` | 往某个 `gbN` 输入文本（可 `submit`） | network |
| `browser_eval` | 在页面里执行任意 JS（返回其值） | script |
| `browser_screenshot` | 截图存到 `<userData>/screenshots/` | safe |
| `browser_tabs` | 列出浏览器里所有标签页（标题 + 网址） | safe |
| `browser_tab` | 按标题/网址关键字（或 targetId）切换工作标签页；传空回到默认 | safe |

`snapshot` 返回的形如：

```text
页面：TikTok Shop Partner Center（https://partner.tiktokshop.com/...）
可交互元素 42 个：
[gb0] <a> 首页 → /
[gb1] <button[button]> 待审核
[gb2] <input[text]> 搜索
```

模型先 `snapshot` 拿到 `gbN`，再 `click` / `type`，很稳（不依赖猜测的 CSS 选择器）。

## 多标签页

一个浏览器常常开着好几个标签（比如「Cookie 商店页」+「TikTok 后台」）。默认行为是
**连列表里的第一个 page**，很可能不是你想操作的那个。因此：

- `snapshot` 在标签数 > 1 时会在末尾附上「标签页清单」和当前是第几个；
- 用 `browser_tabs` 可随时单独列一遍；
- 用 `browser_tab { hint: "tiktok" }` 按标题/网址关键字切过去（也可传 targetId 精确匹配），
  之后的 `snapshot / click / type / eval / screenshot` 都作用在这个标签上；
- 传 `hint: ""` 回到默认（第一个标签）。

切换是即时的：`useTab` 会关掉旧连接、重连到目标标签页。找不到时直接返回错误并列出
当前所有标签，不会「静默点到错的页面上」。

## 设置里的「本机浏览器」

设置面板有一栏「本机浏览器」：

- 按钮「打开浏览器」→ 调 `computer:browser-open`，把浏览器拉起来（首次便于人工登录）；
- 状态文本显示当前是否在跑、端口、PID、是自有还是接管。

## 采集脚本如何连到它

技能里的采集脚本（如 `tiktok-affiliate-sample-requests/scripts/collect_to_review.mjs`）
通过同目录的 `cdp.mjs` 自动发现端口，顺序是：

1. 环境变量 `GROKBOT_CDP_PORT`
2. `127.0.0.1:9333`（你自己开的调试 Chrome）
3. `%APPDATA%\Grok Bot\browser-profile\DevToolsActivePort`（Bot 自带浏览器的端口）

所以**不需要**用户再手动保证 9333 开着：只要 Bot 的自带浏览器在跑，脚本就能连上。

## 自检

```powershell
node scripts/verify-local-browser.js
```

覆盖：找到浏览器 → 启动并读端口 → `navigate` + `snapshot` → `type` / `click` / `eval`
→ 截图落盘 → `dispose` 后自有进程结束。全绿即正常。

## 已知限制

- 只驱动 Chromium 系（Chrome / Edge）；找不到会提示用 `GROKBOT_CHROME` 指定路径。
- 自有模式启动会弹一个浏览器窗口（这是有意的，方便人工登录 / 观察）。
- `browser_eval` 能执行任意 JS，属 `script` 风险档，审批会按策略询问。
- 接管模式下导航依赖 `document.readyState`，SPA 内部路由不会触发整页加载，
  `navigate` 已改为轮询 `readyState`（最多 15 秒），不会白等满超时。
