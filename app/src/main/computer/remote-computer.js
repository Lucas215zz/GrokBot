"use strict";

/**
 * 远程云计算机实现。
 *
 * 只要一台服务端满足下面的 HTTP 契约，就能当作「云计算机」使用：
 * 把所有 Bot 的执行都放到云端，关掉本机应用后任务仍继续。
 *
 * 鉴权：所有请求带 Authorization: Bearer <token>
 * 基地址：config.baseUrl（例如 https://vm.example.com）
 *
 * ── 契约 ─────────────────────────────────────────────
 * GET  /health
 *      → { ok: true, id?: string, os?: string, persistent?: boolean }
 *
 * POST /fs/list    { path?: string }
 *      → { output: string }
 *
 * POST /fs/read    { path: string, startLine?: number, endLine?: number }
 *      → { output: string }
 *
 * POST /fs/write   { path: string, content: string }
 *      → { bytes: number }
 *
 * POST /fs/search  { pattern: string, path?: string, maxResults?: number }
 *      → { output: string }
 *
 * POST /exec       { command: string, timeoutMs?: number }
 *      → { code: number|null, stdout: string, stderr: string, timedOut?: boolean }
 *
 * POST /browser/navigate { url: string }
 *      → { output: string }
 *
 * POST /takeover   { reason: string }
 *      → { status: "not-needed"|"resolved"|"pending", detail?: string }
 *
 * GET  /screen
 *      → { url: string|null }
 * ─────────────────────────────────────────────────────
 */

const { Computer } = require("./computer");

class RemoteComputer extends Computer {
  constructor({ id, baseUrl, token, timeoutMs = 60000 }) {
    super({ id: id || "cloud", kind: "remote" });
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.timeoutMs = timeoutMs;
  }

  capabilities() {
    return {
      terminal: true,
      filesystem: true,
      browser: true,
      screen: true,
      persistent: true,
    };
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
    return (await this.#call("POST", "/fs/list", { path: relPath })).output ?? "";
  }

  async readFile(relPath, opts = {}) {
    return (await this.#call("POST", "/fs/read", { path: relPath, ...opts })).output ?? "";
  }

  async writeFile(relPath, content) {
    const r = await this.#call("POST", "/fs/write", { path: relPath, content });
    return { path: relPath, bytes: r.bytes ?? Buffer.byteLength(content ?? ""), existed: r.existed };
  }

  async searchText(pattern, opts = {}) {
    return (await this.#call("POST", "/fs/search", { pattern, ...opts })).output ?? "";
  }

  async exec(command, opts = {}) {
    const r = await this.#call("POST", "/exec", {
      command,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    }, { timeoutMs: (opts.timeoutMs ?? this.timeoutMs) + 15000 });
    return {
      code: r.code ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timedOut: Boolean(r.timedOut),
    };
  }

  async navigate(url) {
    return (await this.#call("POST", "/browser/navigate", { url })).output ?? "";
  }

  async requestTakeover(reason) {
    const r = await this.#call("POST", "/takeover", { reason }, { timeoutMs: 10 * 60000 });
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

module.exports = { RemoteComputer };
