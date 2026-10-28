# 云计算机接口契约

Grok Bot 的执行环境被抽象成一台「计算机」。现在是本机，以后可以换成云端，
上层 Agent 与工具逻辑完全不用改。

切换方式（`app.json`）：

```json
"computer": { "kind": "local" }
```

```json
"computer": { "kind": "remote", "baseUrl": "https://vm.example.com", "token": "..." }
```

也可以直接在「设置 → 执行环境」里切换。

## 设计要点（对齐官方产品）

- **一台计算机，全账号共享**：所有 Bot 共用同一台云计算机，登录状态互通
- **安全边界在账号级**，不在单个 Bot
- **持久**：关掉本机应用后任务继续跑（云端才有）
- **可观看 / 可接管**：`/screen` 给出可看的画面地址，`/takeover` 请求人工介入
- **本机模式下**：每个 Bot 有独立工作目录，浏览器/接管能力不可用

## 接口

基地址：`computer.baseUrl`
鉴权：所有请求带 `Authorization: Bearer <token>`

### GET /health

```json
{ "ok": true, "id": "vm-01", "os": "linux", "persistent": true }
```

### POST /fs/list

请求 `{ "path": "." }`

```json
{ "output": "工作目录：\nhello.txt  (35 B)\nsrc/" }
```

### POST /fs/read

请求 `{ "path": "hello.txt", "startLine": 1, "endLine": 50 }`（行号可选）

```json
{ "output": "文件内容…" }
```

### POST /fs/write

请求 `{ "path": "hello.txt", "content": "你好" }`

```json
{ "bytes": 6, "existed": false }
```

### POST /fs/search

请求 `{ "pattern": "TODO", "path": ".", "maxResults": 50 }`

```json
{ "output": "src/a.js:12: // TODO 修复" }
```

### POST /exec

请求 `{ "command": "ls -la", "timeoutMs": 60000 }`

```json
{ "code": 0, "stdout": "...", "stderr": "", "timedOut": false }
```

### POST /browser/navigate

请求 `{ "url": "https://example.com" }`

```json
{ "output": "[浏览器] 已打开 https://example.com" }
```

### POST /takeover

请求 `{ "reason": "需要登录 GitHub" }`

```json
{ "status": "resolved", "detail": "用户已完成登录" }
```

`status` 取值：`not-needed` / `resolved` / `pending`

### GET /screen

```json
{ "url": "https://vm.example.com/vnc/session" }
```

没有可观看画面时返回 `{ "url": null }`。

## 最小服务端示例（Node.js）

```js
const http = require("node:http");
const { exec } = require("node:child_process");

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const send = (o) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };

  if (req.url === "/health") return send({ ok: true, id: "vm-01", persistent: true });

  if (req.url === "/exec") {
    exec(body.command, { timeout: body.timeoutMs || 60000 }, (err, stdout, stderr) => {
      send({ code: err ? 1 : 0, stdout, stderr, timedOut: err?.killed || false });
    });
    return;
  }

  send({ error: "not implemented" });
}).listen(8080);
```

> 生产环境务必：加鉴权、把文件操作限制在容器内、给命令执行加超时与资源限制、
> 用容器/VM 隔离而不是直接跑在宿主机上。

## 当前实现状态

| 能力 | 本机 | 云端 |
| --- | --- | --- |
| 文件读写 | ✅ | ✅ 已实现（待接真实服务端） |
| 命令执行 | ✅ PowerShell | ✅ 已实现 |
| 浏览器 | ❌ | ✅ 已实现（待接真实服务端） |
| 屏幕观看/接管 | ❌ | ✅ 已实现（待接真实服务端） |
| 关应用后继续跑 | ❌ | 依赖服务端 |
