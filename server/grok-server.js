#!/usr/bin/env node
"use strict";

/**
 * Grok Bot 云计算机服务端。
 *
 * 实现 docs/cloud-computer.md 的 HTTP 契约，让任意一台机器（这里主要是 macOS）
 * 变成 Grok Bot 的「云计算机」。
 *
 * 设计原则（很重要，别改坏）：
 *   1. 默认只监听 127.0.0.1 —— 外面必须经过 cloudflared / Caddy 才能进来。
 *   2. 所有请求都要 Bearer token，常量时间比较。
 *   3. 文件操作全部锁在 dataDir/workspaces/<botId>/ 里面，越界直接拒绝。
 *   4. /exec 有超时、输出上限、危险命令黑名单。
 *   5. 每个 Bot 一个工作目录（上层账号级共用同一台机器，但文件互不踩）。
 *
 * 用法：
 *   node server/grok-server.js                 # 用 ~/.grokbot-server/config.json
 *   node server/grok-server.js --print-token   # 打印当前 token（部署时复制到 App）
 *   node server/grok-server.js --init          # 生成配置 + 随机 token
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_READ_BYTES = 200 * 1024;
const MAX_OUTPUT_CHARS = 20000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".grokbot-server");

function expandHome(p) {
  const s = String(p || "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * 内置的危险命令黑名单。
 * 与 app/src/main/approval/policy.js 的 HARD_DENY 保持同一套思路，
 * 但服务端是最后一道闸，不能依赖上层是否装了审批。
 */
const BUILTIN_DENY = [
  { re: /\brm\s+[^\n]*-[a-z]*r[a-z]*[^\n]*\s(?:\/|\/\*|~)(?:\s|$)/i, label: "删除系统根目录" },
  { re: /\brm\b[^\n]*--no-preserve-root\b/i, label: "绕过保护删除系统根目录" },
  { re: /\bmkfs(?:\.\w+)?\b/i, label: "格式化文件系统" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, label: "直接写块设备" },
  { re: /\bdiskutil\b[^\n]*\b(?:eraseDisk|eraseVolume|zeroDisk|secureErase)\b/i, label: "抹掉磁盘" },
  { re: /\bcsrutil\b[^\n]*\b(?:disable|clear)\b/i, label: "关闭系统完整性保护" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, label: "关机 / 重启" },
  { re: /\bkillall\b[^\n]*\b(?:WindowServer|launchd|kernel_task|loginwindow)\b/i, label: "杀死系统关键进程" },
  { re: /\bformat(?:\.com)?\s+(?:volume\b|[a-z]:)/i, label: "格式化磁盘" },
  { re: /\bdiskpart\b/i, label: "磁盘分区操作" },
  { re: /\bbcdedit\b/i, label: "修改启动配置" },
  { re: /\bvssadmin\b[^\n]*\bdelete\b/i, label: "删除卷影副本" },
  { re: /\b(?:remove-item|del|erase|rd|rmdir)\b[^\n]*["']?[a-z]:[\\/]+["']?(?:\s|$)/i, label: "删除盘符根目录" },
];

function defaultConfig() {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "",
    dataDir: "~/.grokbot-server",
    // 单个请求最长执行时间
    exec: {
      timeoutMs: 120000,
      maxOutputChars: MAX_OUTPUT_CHARS,
      // 额外追加的黑名单（正则字符串）
      deny: [],
    },
    // /screen 返回的画面地址（VNC / 屏幕共享），没有就留 null
    screenUrl: null,
    // 允许的 Origin，留空表示不校验（服务端对服务端调用没有 Origin）
    allowedOrigins: [],
    // 每分钟每 IP 最大请求数
    rateLimitPerMinute: 600,
  };
}

function loadConfig() {
  const dataDir = path.resolve(expandHome(process.env.GROK_DATA_DIR || DEFAULT_DATA_DIR));
  const file = path.join(dataDir, "config.json");
  const cfg = defaultConfig();
  cfg.dataDir = dataDir;

  let raw = null;
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`配置文件解析失败：${file}\n${error.message}`);
    }
  }
  Object.assign(cfg, raw || {});
  cfg.dataDir = path.resolve(expandHome(process.env.GROK_DATA_DIR || cfg.dataDir || DEFAULT_DATA_DIR));
  cfg.exec = { ...defaultConfig().exec, ...(raw?.exec || {}) };

  // 环境变量优先级最高，便于 launchd / systemd / 容器覆盖
  if (process.env.GROK_HOST) cfg.host = process.env.GROK_HOST;
  if (process.env.GROK_PORT) cfg.port = Number(process.env.GROK_PORT);

  // token 优先级：环境变量 > 配置文件 > token 文件 > 自动生成
  const tokenFile = path.join(cfg.dataDir, "token");
  if (process.env.GROK_TOKEN) {
    cfg.token = process.env.GROK_TOKEN;
  } else if (!cfg.token && fs.existsSync(tokenFile)) {
    cfg.token = fs.readFileSync(tokenFile, "utf8").trim();
  }
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, cfg.token, { mode: 0o600 });
    console.log(`[grok-server] 已生成新 token → ${tokenFile}`);
  }
  return { cfg, file, tokenFile };
}

// ---------------------------------------------------------------------------
// 工作目录与路径沙箱
// ---------------------------------------------------------------------------

class Workspaces {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** botId 只允许字母数字和 ._-，防止 ../ 逃逸 */
  dirFor(botId) {
    const id = String(botId || "default").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "default";
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 把请求里的相对路径解析成真实绝对路径。
   * 任何解析后落在工作目录外的路径一律拒绝（含符号链接逃逸）。
   */
  resolve(botId, relPath) {
    const base = this.dirFor(botId);
    const raw = String(relPath || ".").trim() || ".";
    const target = path.resolve(base, raw);
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new HttpError(400, `拒绝访问工作目录之外的路径：${relPath}`);
    }
    // 真实路径校验：挡住指向外部的符号链接
    try {
      const realBase = fs.realpathSync(base);
      const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : target;
      const realRel = path.relative(realBase, realTarget);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new HttpError(400, `拒绝访问工作目录之外的路径（符号链接）：${relPath}`);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // realpath 失败（文件还不存在）时用上面的字面量判断兜底
    }
    return { base, target };
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 构造子进程环境。
 * launchd 启动的进程 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * Homebrew 装的 node / npm / python 全都找不到 —— 必须显式补上。
 */
function buildEnv() {
  const extra = IS_MAC
    ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
    : IS_WIN
      ? []
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const base = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...extra, ...base])].join(path.delimiter);
  return {
    ...process.env,
    PATH: merged,
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "",
    GIT_PAGER: "cat",
    PAGER: "cat",
    PYTHONIOENCODING: "utf-8",
    ...(IS_WIN ? { PYTHONUTF8: "1" } : {}),
  };
}

function truncate(text, limit) {
  const s = String(text ?? "");
  return s.length > limit ? `${s.slice(0, limit)}\n…（已截断，共 ${s.length} 字符）` : s;
}

function checkDeny(command, extraDeny) {
  for (const rule of BUILTIN_DENY) {
    if (rule.re.test(command)) {
      throw new HttpError(403, `命令被服务端永久拒绝：${rule.label}`);
    }
  }
  for (const pattern of extraDeny || []) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      continue;
    }
    if (re.test(command)) {
      throw new HttpError(403, `命令命中自定义拒绝规则：${pattern}`);
    }
  }
}

function runExec(command, { cwd, timeoutMs, maxOutputChars }) {
  return new Promise((resolve) => {
    const shell = IS_WIN ? "powershell.exe" : "/bin/bash";
    const args = IS_WIN
      ? ["-NoProfile", "-NonInteractive", "-Command",
         `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`]
      : ["-lc", command];

    let child;
    try {
      child = spawn(shell, args, { cwd, env: buildEnv(), windowsHide: true });
    } catch (error) {
      return resolve({ code: null, stdout: "", stderr: `命令启动失败：${error.message}`, timedOut: false });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = maxOutputChars * 2;

    child.stdout.on("data", (d) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < cap) stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, Math.max(1000, Math.min(Number(timeoutMs) || 120000, 600000)));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `命令启动失败：${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// 文件操作
// ---------------------------------------------------------------------------

function isBinaryFile(file, size) {
  if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|exe|dll|dylib|mp4|mp3|wav|xlsx|docx|pptx)$/i.test(file)) {
    return true;
  }
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(4096, Math.max(1, size)));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch { /* ignore */ }
  return false;
}

function listFiles(dir, relPath) {
  if (!fs.existsSync(dir)) return `目录不存在：${relPath}`;
  if (!fs.statSync(dir).isDirectory()) return `不是目录：${relPath}`;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 300);
  const lines = entries.map((e) => {
    if (e.isDirectory()) return `${e.name}/`;
    try {
      return `${e.name}  (${fs.statSync(path.join(dir, e.name)).size} B)`;
    } catch {
      return e.name;
    }
  });
  return `${relPath === "." ? "工作目录" : relPath}：\n${lines.join("\n") || "（空）"}`;
}

function readFileText(file, relPath, { startLine, endLine }) {
  if (!fs.existsSync(file)) return `文件不存在：${relPath}`;
  const stat = fs.statSync(file);
  if (stat.isDirectory()) return `这是一个目录，请用 list_files：${relPath}`;
  if (isBinaryFile(file, stat.size)) {
    return `这是二进制/图片文件（${Math.round(stat.size / 1024)} KB），read_file 只能读文本：\n${file}`;
  }
  if (stat.size > MAX_READ_BYTES) {
    return `文件过大（${Math.round(stat.size / 1024)} KB），请指定行范围或用 search_text 定位。`;
  }
  const text = fs.readFileSync(file, "utf8");
  if (!startLine && !endLine) return truncate(text, MAX_OUTPUT_CHARS);
  const lines = text.split("\n");
  const from = Math.max(1, Number(startLine) || 1);
  const to = Math.min(lines.length, Number(endLine) || lines.length);
  return `（第 ${from}-${to} 行，共 ${lines.length} 行）\n` + truncate(lines.slice(from - 1, to).join("\n"), MAX_OUTPUT_CHARS);
}

function searchText(root, dir, pattern, maxResults) {
  if (!pattern) return "错误：pattern 不能为空";
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return `错误：正则无效（${pattern}）`;
  }
  const results = [];
  const limit = Math.min(Number(maxResults) || 50, 200);
  const walk = (d) => {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat || stat.size > 512 * 1024) continue;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      text.split("\n").forEach((line, i) => {
        if (results.length >= limit) return;
        if (re.test(line)) results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  };
  walk(dir);
  return results.length ? results.join("\n") : `未找到匹配「${pattern}」的内容`;
}

// ---------------------------------------------------------------------------
// 浏览器（复用 App 的 CDP 实现）
// ---------------------------------------------------------------------------

let LocalBrowser = null;
let browser = null;

function loadBrowserClass() {
  if (LocalBrowser) return LocalBrowser;
  // 服务端通常和仓库一起部署；打包后找不到就降级（浏览器接口返回明确错误）
  const candidates = [
    path.join(__dirname, "..", "app", "src", "main", "computer", "browser.js"),
    path.join(__dirname, "browser.js"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      ({ LocalBrowser } = require(file));
      return LocalBrowser;
    } catch { /* 继续找 */ }
  }
  return null;
}

function getBrowser(cfg) {
  const Cls = loadBrowserClass();
  if (!Cls) throw new HttpError(501, "服务端找不到浏览器模块（browser.js），浏览器功能不可用");
  if (!browser) {
    browser = new Cls({
      userDataDir: path.join(cfg.dataDir, "browser"),
      config: {},
    });
  }
  return browser;
}

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

class RateLimiter {
  constructor(perMinute) {
    this.limit = Math.max(10, Number(perMinute) || 600);
    this.hits = new Map(); // ip -> number[]
  }

  allow(ip) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const list = (this.hits.get(ip) || []).filter((t) => t > windowStart);
    if (list.length >= this.limit) {
      this.hits.set(ip, list);
      return false;
    }
    list.push(now);
    this.hits.set(ip, list);
    if (this.hits.size > 5000) this.hits.clear(); // 防内存膨胀
    return true;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免通过时间差判断长度
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function createServer(cfg) {
  const workspaces = new Workspaces(path.join(cfg.dataDir, "workspaces"));
  const limiter = new RateLimiter(cfg.rateLimitPerMinute);
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const endpoint = url.pathname.replace(/\/+$/, "") || "/";
    const ip = req.socket.remoteAddress || "?"; 

    try {
      if (!limiter.allow(ip)) throw new HttpError(429, "请求过于频繁");

      // 鉴权：/health 也要 token（避免公网探测存活）
      const auth = String(req.headers.authorization || "");
      const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!safeEqual(presented, cfg.token)) {
        throw new HttpError(401, "token 无效");
      }

      if (cfg.allowedOrigins?.length) {
        const origin = String(req.headers.origin || "");
        if (origin && !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, "Origin 不在白名单");
      }

      const body = req.method === "POST" ? await readBody(req) : {};
      const botId = String(body.botId || req.headers["x-grok-bot"] || "default");
      const ws = workspaces.dirFor(botId);

      // ---------------- 健康 ----------------
      if (endpoint === "/health") {
        return json(res, 200, {
          ok: true,
          id: os.hostname(),
          os: process.platform,
          arch: process.arch,
          persistent: true,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          node: process.version,
          botId,
          workspace: ws,
        });
      }

      // ---------------- 文件 ----------------
      if (endpoint === "/fs/list") {
        const { target } = workspaces.resolve(botId, body.path || ".");
        return json(res, 200, { output: listFiles(target, body.path || ".") });
      }

      if (endpoint === "/fs/read") {
        const { target } = workspaces.resolve(botId, body.path);
        if (!body.path) throw new HttpError(400, "path 不能为空");
        return json(res, 200, { output: readFileText(target, body.path, body) });
      }

      if (endpoint === "/fs/write") {
        const { target } = workspaces.resolve(botId, body.path);
        if (!body.path) throw new HttpError(400, "path 不能为空");
        const existed = fs.existsSync(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const text = String(body.content ?? "");
        fs.writeFileSync(target, text, "utf8");
        return json(res, 200, { bytes: Buffer.byteLength(text), existed });
      }

      if (endpoint === "/fs/search") {
        const { base, target } = workspaces.resolve(botId, body.path || ".");
        return json(res, 200, {
          output: searchText(base, target, body.pattern, body.maxResults),
        });
      }

      // ---------------- 终端 ----------------
      if (endpoint === "/exec") {
        const command = String(body.command || "");
        if (!command.trim()) throw new HttpError(400, "command 不能为空");
        checkDeny(command, cfg.exec.deny);
        const result = await runExec(command, {
          cwd: ws,
          timeoutMs: body.timeoutMs ?? cfg.exec.timeoutMs,
          maxOutputChars: cfg.exec.maxOutputChars,
        });
        return json(res, 200, {
          code: result.code,
          stdout: truncate(result.stdout, cfg.exec.maxOutputChars),
          stderr: truncate(result.stderr, cfg.exec.maxOutputChars),
          timedOut: result.timedOut,
        });
      }

      // ---------------- 浏览器 ----------------
      if (endpoint === "/browser/navigate") {
        const b = getBrowser(cfg);
        return json(res, 200, { output: await b.navigate(String(body.url || "")) });
      }

      if (endpoint === "/browser/snapshot") {
        const b = getBrowser(cfg);
        return json(res, 200, { output: await b.snapshot() });
      }

      if (endpoint === "/browser/click") {
        const b = getBrowser(cfg);
        return json(res, 200, { output: await b.click(String(body.uid || "")) });
      }

      if (endpoint === "/browser/type") {
        const b = getBrowser(cfg);
        return json(res, 200, {
          output: await b.type(String(body.uid || ""), String(body.text ?? ""), { submit: Boolean(body.submit) }),
        });
      }

      if (endpoint === "/browser/eval") {
        const b = getBrowser(cfg);
        const value = await b.eval(String(body.expression || ""));
        return json(res, 200, { output: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
      }

      if (endpoint === "/browser/screenshot") {
        const b = getBrowser(cfg);
        const dir = path.join(cfg.dataDir, "screenshots");
        const file = await b.screenshot(dir);
        // 返回 base64：调用方在另一台机器上，服务端路径对它没意义
        return json(res, 200, {
          base64: fs.readFileSync(file).toString("base64"),
          file,
        });
      }

      if (endpoint === "/browser/tabs") {
        const b = getBrowser(cfg);
        return json(res, 200, { tabs: await b.listTabs() });
      }

      if (endpoint === "/browser/tab") {
        const b = getBrowser(cfg);
        const r = await b.useTab(String(body.hint || ""));
        if (!r.ok) throw new HttpError(404, r.reason || "没有匹配的标签页");
        return json(res, 200, { output: `已切换标签页：${r.tab?.title || r.tab?.url || "默认"}`, tabs: r.tabs });
      }

      // ---------------- 人机接管 ----------------
      if (endpoint === "/takeover") {
        console.log(`[takeover] ${new Date().toISOString()} ${body.reason || "(无原因)"}`);
        return json(res, 200, {
          status: cfg.screenUrl ? "pending" : "not-needed",
          detail: cfg.screenUrl
            ? `请打开 ${cfg.screenUrl} 完成操作，完成后点「已接管」`
            : "未配置屏幕地址，请直接在 Mac 上操作",
        });
      }

      if (endpoint === "/screen") {
        return json(res, 200, { url: cfg.screenUrl || null });
      }

      throw new HttpError(404, `未知接口：${endpoint}`);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error("[grok-server]", error);
      if (!res.headersSent) json(res, status, { error: error.message || String(error) });
    }
  });

  server.on("clientError", (_err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /* ignore */ }
  });

  return server;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function init() {
  const dataDir = path.resolve(expandHome(process.env.GROK_DATA_DIR || DEFAULT_DATA_DIR));
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "config.json");
  if (fs.existsSync(file)) {
    console.log(`[grok-server] 配置已存在，未覆盖：${file}`);
  } else {
    const cfg = defaultConfig();
    cfg.token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    console.log(`[grok-server] 已生成配置：${file}`);
  }
  const { cfg } = loadConfig();
  console.log(`[grok-server] token：${cfg.token}`);
  console.log("[grok-server] 把上面这串 token 填到 App 的「设置 → 执行环境 → 云计算机」里");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--init")) return init();

  const { cfg, file, tokenFile } = loadConfig();
  if (argv.includes("--print-token")) {
    console.log(cfg.token);
    return;
  }

  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[grok-server] 监听 http://${cfg.host}:${cfg.port}`);
    console.log(`[grok-server] 数据目录 ${cfg.dataDir}`);
    console.log(`[grok-server] 配置 ${file}${fs.existsSync(file) ? "" : "（不存在，使用默认值）"}`);
    console.log(`[grok-server] token 文件 ${tokenFile}`);
    if (cfg.host !== "127.0.0.1" && cfg.host !== "::1") {
      console.warn("[grok-server] 警告：没有监听回环地址，请确认前面有 TLS + 鉴权网关");
    }
  });

  const shutdown = (sig) => {
    console.log(`[grok-server] 收到 ${sig}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) main();

module.exports = { createServer, loadConfig, defaultConfig, Workspaces, HttpError, BUILTIN_DENY };
