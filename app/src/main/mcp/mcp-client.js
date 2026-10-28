"use strict";

/**
 * MCP（Model Context Protocol）客户端。
 *
 * 支持两种传输：
 *   stdio —— 启动本地进程，用 JSON-RPC 走标准输入输出（最常见）
 *   http  —— Streamable HTTP / SSE 端点
 *
 * 协议：JSON-RPC 2.0
 *   initialize → tools/list → tools/call
 */

const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = "2025-06-18";

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/* ---------------- stdio 传输 ---------------- */
class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.onClose = null;
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });

    this.child.stdout.on("data", (d) => this.#onData(d.toString("utf8")));
    this.child.stderr.on("data", () => { /* 忽略服务端日志 */ });
    this.child.on("error", (e) => this.#failAll(new McpError(`MCP 进程启动失败：${e.message}`)));
    this.child.on("close", () => {
      this.#failAll(new McpError("MCP 进程已退出"));
      this.onClose?.();
    });

    // 等进程起来
    await new Promise((r) => setTimeout(r, 150));
  }

  #onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 输出忽略
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new McpError(msg.error.message || "MCP 调用失败", msg.error.code));
        else resolve(msg.result);
      }
    }
  }

  #failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  async request(method, params = {}) {
    if (!this.child) throw new McpError("MCP 进程未启动");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new McpError(`MCP 调用超时：${method}`));
      }, 60000);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close() {
    this.#failAll(new McpError("MCP 连接已关闭"));
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}

/* ---------------- HTTP 传输 ---------------- */
class HttpTransport {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
    this.nextId = 1;
  }

  async start() {
    // 试探连通性
    const r = await fetch(this.url, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "grokbot", version: "1.0.0" } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new McpError(`MCP HTTP 端点返回 ${r.status}`);
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const r = await fetch(this.url, {
      method: "POST",
      headers: {
        ...this.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new McpError(`MCP HTTP 调用失败：${r.status}`);
    const text = await r.text();
    // 可能是 JSON，也可能是 SSE
    const jsonLine = text.split("\n").reverse().find((l) => l.trim().startsWith("{") || l.startsWith("data:"));
    let msg;
    try {
      msg = JSON.parse(jsonLine?.startsWith("data:") ? jsonLine.slice(5).trim() : jsonLine);
    } catch {
      throw new McpError("MCP 返回无法解析");
    }
    if (msg.error) throw new McpError(msg.error.message || "MCP 调用失败", msg.error.code);
    return msg.result;
  }

  notify() {}

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: { ...this.headers, "mcp-session-id": this.sessionId },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* ignore */
    }
  }
}

/* ---------------- MCP 客户端 ---------------- */
class McpClient {
  constructor(config) {
    this.config = config;
    this.transport = null;
    this.tools = [];
    this.serverInfo = null;
  }

  async connect() {
    const { type, command, args, env, cwd, url, headers } = this.config;
    this.transport = type === "http" ? new HttpTransport({ url, headers }) : new StdioTransport({ command, args, env, cwd });
    await this.transport.start();

    const init = await this.transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "grokbot", version: "1.0.0" },
    });
    this.serverInfo = init?.serverInfo || null;
    this.transport.notify("notifications/initialized", {});

    await this.refreshTools();
    return this;
  }

  async refreshTools() {
    const r = await this.transport.request("tools/list", {});
    this.tools = Array.isArray(r?.tools) ? r.tools : [];
    return this.tools;
  }

  /** 调用 MCP 工具，返回文本结果 */
  async callTool(name, args) {
    const r = await this.transport.request("tools/call", { name, arguments: args || {} });
    const parts = [];
    for (const c of r?.content || []) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image") parts.push("[图片]");
      else if (c.type === "resource") parts.push(`[资源] ${c.resource?.uri || ""}`);
      else parts.push(JSON.stringify(c));
    }
    return parts.join("\n") || (r?.isError ? "MCP 工具执行失败" : "（无输出）");
  }

  async close() {
    await this.transport?.close();
  }
}

module.exports = { McpClient, StdioTransport, HttpTransport, McpError, PROTOCOL_VERSION };
