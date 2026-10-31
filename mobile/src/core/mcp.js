// MCP 客户端与管理器（手机端只支持 http / Streamable HTTP 传输，
// stdio 需要本地进程，手机不支持）。

import AsyncStorage from "@react-native-async-storage/async-storage";
import { newId } from "./util";

const KEY = "grokbot:mcp";
const PROTOCOL_VERSION = "2025-06-18";

export class McpHttpClient {
  constructor({ name, url, headers = {} }) {
    this.name = name;
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
    this.nextId = 1;
    this.tools = [];
  }

  async connect() {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "grokbot-mobile", version: "1.0.0" } },
      }),
    });
    if (!r.ok) throw new Error(`MCP HTTP 端点返回 ${r.status}`);
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    await this.refreshTools();
    return this;
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
    });
    if (!r.ok) throw new Error(`MCP HTTP 调用失败：${r.status}`);
    const text = await r.text();
    const jsonLine = text.split("\n").reverse().find((l) => l.trim().startsWith("{") || l.startsWith("data:"));
    let msg;
    try {
      msg = JSON.parse(jsonLine?.startsWith("data:") ? jsonLine.slice(5).trim() : jsonLine);
    } catch {
      throw new Error("MCP 返回无法解析");
    }
    if (msg.error) throw new Error(msg.error.message || "MCP 调用失败");
    return msg.result;
  }

  async refreshTools() {
    const r = await this.request("tools/list", {});
    this.tools = Array.isArray(r?.tools) ? r.tools : [];
    return this.tools;
  }

  async callTool(name, args) {
    const r = await this.request("tools/call", { name, arguments: args || {} });
    const parts = [];
    for (const c of r?.content || []) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image") parts.push("[图片]");
      else if (c.type === "resource") parts.push(`[资源] ${c.resource?.uri || ""}`);
      else parts.push(JSON.stringify(c));
    }
    return parts.join("\n") || (r?.isError ? "MCP 工具执行失败" : "（无输出）");
  }
}

export class McpManager {
  constructor() {
    this.servers = [];
    this.clients = new Map();
    this.ready = this.load();
  }

  async load() {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      this.servers = raw ? (JSON.parse(raw).servers || []) : [];
    } catch {
      this.servers = [];
    }
  }

  async save(servers) {
    this.servers = servers;
    await AsyncStorage.setItem(KEY, JSON.stringify({ servers }));
  }

  async connectAll() {
    for (const s of this.servers) {
      if (s.enabled === false) continue;
      await this.connect(s.name).catch(() => {});
    }
  }

  async connect(name) {
    const cfg = this.servers.find((s) => s.name === name);
    if (!cfg) throw new Error(`未找到 MCP 服务器：${name}`);
    await this.disconnect(name);
    try {
      const client = await new McpHttpClient(cfg).connect();
      this.clients.set(name, { client, tools: client.tools, status: "connected", error: null });
      return client.tools;
    } catch (error) {
      this.clients.set(name, { client: null, tools: [], status: "error", error: error.message });
      throw error;
    }
  }

  async disconnect(name) {
    this.clients.delete(name);
  }

  async disconnectAll() {
    this.clients.clear();
  }

  allTools() {
    const out = [];
    for (const [serverName, entry] of this.clients) {
      if (entry.status !== "connected") continue;
      for (const t of entry.tools) {
        out.push({
          name: `mcp__${serverName}__${t.name}`,
          description: `[MCP/${serverName}] ${t.description || ""}`.trim(),
          parameters: t.inputSchema || { type: "object", properties: {} },
        });
      }
    }
    return out;
  }

  async handleCall(toolName, args) {
    const m = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
    if (!m) return null;
    const [, serverName, realName] = m;
    const entry = this.clients.get(serverName);
    if (!entry || entry.status !== "connected") return `错误：MCP 服务器「${serverName}」未连接`;
    try {
      return await entry.client.callTool(realName, args);
    } catch (error) {
      return `错误：MCP 调用失败 - ${error.message}`;
    }
  }

  status() {
    return this.servers.map((s) => {
      const entry = this.clients.get(s.name);
      return {
        name: s.name,
        type: "http",
        enabled: s.enabled !== false,
        status: entry?.status || "disconnected",
        error: entry?.error || null,
        toolCount: entry?.tools?.length || 0,
        target: s.url,
      };
    });
  }
}
