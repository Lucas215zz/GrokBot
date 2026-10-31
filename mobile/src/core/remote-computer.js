// 远程云计算机实现：复用 grok-server.js 的 HTTP 契约。
// 手机把所有执行都交给云端（文件 / shell / 浏览器 / 人机接管）。

import { Computer } from "./computer";

export class RemoteComputer extends Computer {
  constructor({ id = "cloud", baseUrl, token, timeoutMs = 60000, botId = "default" }) {
    super({ id, kind: "remote" });
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.timeoutMs = timeoutMs;
    this.botId = String(botId || "default");
    this._screenUrl = null;
    this._tabs = [];
  }

  capabilities() {
    return { terminal: true, filesystem: true, browser: true, screen: true, persistent: true };
  }

  screenUrl() {
    return this._screenUrl || null;
  }

  async #call(method, endpoint, body, { timeoutMs } = {}) {
    if (!this.baseUrl) throw new Error("未配置云计算机地址");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`云计算机返回 ${res.status}：${text.slice(0, 200)}`);
      }
      return await res.json().catch(() => ({}));
    } catch (error) {
      if (error.name === "AbortError") throw new Error("云计算机请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    try {
      const r = await this.#call("GET", "/health", null, { timeoutMs: 10000 });
      return { ok: r.ok === true, detail: r.id || r.os || "" };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  async listFiles(relPath = ".") {
    return (await this.#call("POST", "/fs/list", { path: relPath, botId: this.botId })).output ?? "";
  }

  async readFile(relPath, opts = {}) {
    return (await this.#call("POST", "/fs/read", { path: relPath, botId: this.botId, ...opts })).output ?? "";
  }

  async writeFile(relPath, content) {
    const r = await this.#call("POST", "/fs/write", { path: relPath, content, botId: this.botId });
    return { path: relPath, bytes: r.bytes ?? 0, existed: r.existed };
  }

  async searchText(pattern, opts = {}) {
    return (await this.#call("POST", "/fs/search", { pattern, botId: this.botId, ...opts })).output ?? "";
  }

  async exec(command, opts = {}) {
    const r = await this.#call(
      "POST",
      "/exec",
      { command, botId: this.botId, timeoutMs: opts.timeoutMs ?? this.timeoutMs },
      { timeoutMs: (opts.timeoutMs ?? this.timeoutMs) + 15000 },
    );
    return { code: r.code ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: Boolean(r.timedOut) };
  }

  async navigate(url) {
    return (await this.#call("POST", "/browser/navigate", { url, botId: this.botId })).output ?? "";
  }
  async browserSnapshot() {
    return (await this.#call("POST", "/browser/snapshot", { botId: this.botId })).output ?? "";
  }
  async browserClick(uid) {
    return (await this.#call("POST", "/browser/click", { uid, botId: this.botId })).output ?? "";
  }
  async browserType(uid, text, { submit = false } = {}) {
    return (await this.#call("POST", "/browser/type", { uid, text, submit, botId: this.botId })).output ?? "";
  }
  async browserEval(expression) {
    return (await this.#call("POST", "/browser/eval", { expression, botId: this.botId })).output ?? "";
  }
  async browserScreenshot() {
    const r = await this.#call("POST", "/browser/screenshot", { botId: this.botId });
    if (!r.base64) throw new Error("服务端没有返回截图数据");
    return `[截图 base64，长度 ${r.base64.length}]`;
  }
  async browserTabs() {
    const r = await this.#call("POST", "/browser/tabs", { botId: this.botId });
    this._tabs = Array.isArray(r.tabs) ? r.tabs : [];
    return this._tabs;
  }
  async browserUseTab(hint) {
    const r = await this.#call("POST", "/browser/tab", { hint: String(hint || ""), botId: this.botId });
    this._tabs = Array.isArray(r.tabs) ? r.tabs : [];
    return r.output || "已切换标签页";
  }
  browserStatus() {
    return { running: this._tabs.length > 0, external: false, port: null, pid: null, remote: true };
  }
  async requestTakeover(reason) {
    const r = await this.#call("POST", "/takeover", { reason, botId: this.botId }, { timeoutMs: 10 * 60000 });
    return { status: r.status || "pending", detail: r.detail };
  }
  async refreshScreenUrl() {
    try {
      const r = await this.#call("GET", "/screen", null, { timeoutMs: 10000 });
      this._screenUrl = r.url || null;
    } catch {
      this._screenUrl = null;
    }
    return this._screenUrl;
  }
}
