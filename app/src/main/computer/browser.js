"use strict";

/**
 * 本机浏览器（真正的浏览器自动化，不再依赖用户手动开 Chrome + 9333）。
 *
 * 做法：由 Bot 自己拉起一个独立 profile 的 Chrome/Edge：
 *   --user-data-dir=<userData>/browser-profile   （登录态持久化，重启还在）
 *   --remote-debugging-port=0                    （自动分配端口，读 DevToolsActivePort）
 * 然后用 CDP（Chrome DevTools Protocol）直接驱动它：
 *   navigate / eval / click / type / snapshot / screenshot
 *
 * 也支持接管模式：配置里给了 attach 地址就直接连过去（比如用户已有的 9333）。
 *
 * 注意：本类是受控资源，进程随应用退出而关闭（dispose），
 * 不会像用户自己的 Chrome 那样常驻。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个可用的 Chromium 系浏览器可执行文件 */
function findBrowserExe() {
  const cands = [
    process.env.GROKBOT_CHROME,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/** 极简 CDP 客户端：连接到一个 page target，收发命令与事件 */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this._loadWaiters = [];
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message || "CDP 错误")) : p.res(msg.result);
      } else if (msg.method === "Page.loadEventFired") {
        const waiters = this._loadWaiters;
        this._loadWaiters = [];
        for (const w of waiters) w();
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this._pending.values()) p.rej(new Error("CDP 连接已关闭"));
      this._pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error("CDP 未连接"));
    const id = ++this._id;
    return new Promise((res, rej) => {
      this._pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitLoad(timeoutMs = 15000) {
    return new Promise((res) => {
      const t = setTimeout(res, timeoutMs);
      this._loadWaiters.push(() => { clearTimeout(t); res(); });
    });
  }

  close() {
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

class LocalBrowser {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir 应用数据目录（profile 存这里）
   * @param {object} [opts.config] app.json 的 browser 配置
   */
  constructor({ userDataDir, config } = {}) {
    this.userDataDir = userDataDir || path.join(process.cwd(), ".grokbot-browser");
    this.config = config || {};
    this.proc = null;
    this.port = null;
    this.client = null;
    this.external = false;
    this.launching = null;
  }

  /** attach 模式：连用户已有的 CDP 端点（例如 http://127.0.0.1:9333） */
  get attachEndpoint() {
    const e = this.config && this.config.attach;
    return typeof e === "string" && e.trim() ? e.trim().replace(/\/+$/, "") : "";
  }

  async #httpJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async #pickPage() {
    const list = await this.#httpJson(`http://127.0.0.1:${this.port}/json/list`);
    const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === "page");
    if (pages.length) return pages[0].webSocketDebuggerUrl;
    try {
      const created = await this.#httpJson(`http://127.0.0.1:${this.port}/json/new?about:blank`);
      return created.webSocketDebuggerUrl;
    } catch {
      throw new Error("浏览器没有可用的页面");
    }
  }

  async #connectPage() {
    const wsUrl = await this.#pickPage();
    const client = new CdpClient(wsUrl);
    await client.connect();
    await client.send("Page.enable").catch(() => {});
    await client.send("Runtime.enable").catch(() => {});
    this.client = client;
    return client;
  }

  async ensure() {
    if (this.client && this.client.ws) return this.client;
    if (this.launching) return this.launching;
    this.launching = this.#launchOrAttach().finally(() => { this.launching = null; });
    return this.launching;
  }

  async #launchOrAttach() {
    if (this.attachEndpoint) {
      this.external = true;
      const base = /^https?:\/\//.test(this.attachEndpoint) ? this.attachEndpoint : `http://${this.attachEndpoint}`;
      this.port = (base.match(/:(\d+)/) || [])[1] || "9333";
      const list = await this.#httpJson(`${base}/json/list`);
      const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === "page");
      const wsUrl = pages[0] ? pages[0].webSocketDebuggerUrl : `${base.replace(/^http/, "ws")}/devtools/page/1`;
      const client = new CdpClient(wsUrl);
      await client.connect();
      await client.send("Page.enable").catch(() => {});
      await client.send("Runtime.enable").catch(() => {});
      this.client = client;
      return client;
    }

    const exe = findBrowserExe();
    if (!exe) throw new Error("找不到 Chrome 或 Edge，无法启动浏览器（可设置环境变量 GROKBOT_CHROME 指定路径）");
    const profileDir = path.join(this.userDataDir, "browser-profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    try { if (fs.existsSync(portFile)) fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }

    this.proc = spawn(
      exe,
      [
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        "--disable-popup-blocking",
        "about:blank",
      ],
      { windowsHide: false, stdio: "ignore", detached: false },
    );
    this.proc.on("exit", () => { this.proc = null; this.client?.close?.(); this.client = null; });

    let port = null;
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      try {
        if (fs.existsSync(portFile)) {
          const txt = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
          if (txt[0] && /^\d+$/.test(txt[0].trim())) { port = Number(txt[0].trim()); break; }
        }
      } catch { /* 文件可能正在写 */ }
    }
    if (!port) throw new Error("浏览器启动超时（没能读到调试端口）");
    this.port = port;

    let lastErr = null;
    for (let i = 0; i < 30; i++) {
      try {
        return await this.#connectPage();
      } catch (e) {
        lastErr = e;
        await sleep(200);
      }
    }
    throw new Error("连接浏览器失败：" + (lastErr?.message || "未知错误"));
  }

  async eval(expression) {
    const c = await this.ensure();
    const r = await c.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "页面脚本执行出错";
      throw new Error(String(d).slice(0, 500));
    }
    return r.result?.value;
  }

  async navigate(url) {
    const c = await this.ensure();
    const raw = String(url || "").trim();
    // 已经是完整协议（http/https/file/data/about/chrome 等）就原样用，否则补 https://
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    const target = hasScheme ? raw : `https://${raw}`;
    // 不用 waitLoad（依赖 Page.loadEventFired，切到已加载页面 / SPA 路由时可能永不触发，
    // 会白等满超时）。改成轮询 readyState：complete 即继续，最多等 15 秒。
    const wait = c.waitLoad(15000);
    await c.send("Page.navigate", { url: target });
    let settled = false;
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      try {
        const rs = await this.eval(`document.readyState`);
        if (rs === "complete") { settled = true; break; }
      } catch { /* 导航中执行可能失败，继续等 */ }
    }
    if (!settled) await wait.catch?.(() => {});
    const info = await this.eval(
      `(() => ({ title: document.title, url: location.href, readyState: document.readyState }))()`,
    );
    return `已打开：${info?.title || ""}（${info?.url || target}）`;
  }

  async snapshot() {
    const data = await this.eval(`(() => {
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[contenteditable=true],[onclick]';
      const all = [...document.querySelectorAll(sel)];
      const visible = all.filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
      });
      const out = [];
      visible.slice(0, 300).forEach((el, i) => {
        const uid = 'gb' + i;
        el.setAttribute('data-gb-uid', uid);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || tag;
        let name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        const type = el.getAttribute('type') || '';
        const href = tag === 'a' ? (el.getAttribute('href') || '').slice(0, 100) : '';
        const r = el.getBoundingClientRect();
        out.push({ uid, role: type ? role + '[' + type + ']' : role, name, href, x: Math.round(r.x), y: Math.round(r.y) });
      });
      return { title: document.title, url: location.href, count: out.length, elements: out };
    })()`);
    const lines = (data.elements || []).map(
      (e) => `[${e.uid}] <${e.role}> ${e.name}${e.href ? " → " + e.href : ""}`,
    );
    return (
      `页面：${data.title || ""}（${data.url || ""}）\n` +
      `可交互元素 ${data.count} 个：\n` +
      (lines.join("\n") || "（没有可交互元素）")
    );
  }

  async click(uid) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector('[data-gb-uid="' + ${JSON.stringify(String(uid))} + '"]');
      if (!el) return { ok: false, reason: '找不到该元素，请重新 snapshot' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase() };
    })()`);
    if (!ok || !ok.ok) throw new Error(ok?.reason || "点击失败");
    await sleep(500);
    return `已点击 [${uid}]（${ok.tag}）`;
  }

  async type(uid, text, { submit = false } = {}) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector('[data-gb-uid="' + ${JSON.stringify(String(uid))} + '"]');
      if (!el) return { ok: false, reason: '找不到该元素，请重新 snapshot' };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      const val = ${JSON.stringify(String(text ?? ""))};
      if (el.isContentEditable) { el.innerText = val; }
      else { el.value = val; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, tag: el.tagName.toLowerCase() };
    })()`);
    if (!ok || !ok.ok) throw new Error(ok?.reason || "输入失败");
    if (submit) {
      await this.eval(`(() => {
        const el = document.querySelector('[data-gb-uid="' + ${JSON.stringify(String(uid))} + '"]');
        const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        el.dispatchEvent(enter);
        if (el.form) { try { el.form.requestSubmit(); } catch (e) {} }
      })()`);
      await sleep(500);
    }
    return `已在 [${uid}] 输入${submit ? "并提交" : ""}`;
  }

  async screenshot(outDir) {
    const c = await this.ensure();
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    const dir = outDir || path.join(this.userDataDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  async info() {
    try {
      return await this.eval(`(() => ({ title: document.title, url: location.href }))()`);
    } catch {
      return null;
    }
  }

  status() {
    return {
      running: Boolean(this.client && this.client.ws),
      external: this.external,
      port: this.port,
      pid: this.proc ? this.proc.pid : null,
      attach: this.attachEndpoint || null,
    };
  }

  dispose() {
    try { this.client?.close?.(); } catch { /* ignore */ }
    this.client = null;
    if (this.proc && !this.external) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.proc = null;
  }
}

module.exports = { LocalBrowser, findBrowserExe };
