"use strict";

/**
 * MCP 管理器：管理多个 MCP 服务器，把它们的工具聚合进 Bot 的工具集。
 *
 * 工具命名：mcp__<服务器名>__<工具名>，避免与内置工具冲突。
 */

const fs = require("node:fs");
const path = require("node:path");
const { McpClient } = require("./mcp-client");

class McpManager {
  constructor(dataDir) {
    this.file = path.join(dataDir, "mcp.json");
    this.servers = [];      // 配置
    this.clients = new Map(); // name -> {client, tools, status, error}
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.servers = Array.isArray(raw.servers) ? raw.servers : [];
    } catch {
      this.servers = [];
    }
    return this.servers;
  }

  save(servers) {
    this.servers = servers;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ servers }, null, 2), "utf8");
    return this.servers;
  }

  /** 连接所有启用的服务器 */
  async connectAll() {
    for (const s of this.servers) {
      if (s.enabled === false) continue;
      await this.connect(s.name).catch(() => {});
    }
  }

  async connect(name) {
    const cfg = this.servers.find((s) => s.name === name);
    if (!cfg) throw new Error(`未找到 MCP 服务器：${name}`);

    // 已有连接先断开
    await this.disconnect(name);

    try {
      const client = await new McpClient(cfg).connect();
      this.clients.set(name, { client, tools: client.tools, status: "connected", error: null });
      return client.tools;
    } catch (error) {
      this.clients.set(name, { client: null, tools: [], status: "error", error: error.message });
      throw error;
    }
  }

  async disconnect(name) {
    const entry = this.clients.get(name);
    if (entry?.client) await entry.client.close().catch(() => {});
    this.clients.delete(name);
  }

  async disconnectAll() {
    for (const name of [...this.clients.keys()]) await this.disconnect(name);
  }

  /** 全部可用 MCP 工具（转成 Responses 格式） */
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

  /** 判断是否是 MCP 工具，并转发调用 */
  async handleCall(toolName, args) {
    const m = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
    if (!m) return null;
    const [, serverName, realName] = m;
    const entry = this.clients.get(serverName);
    if (!entry || entry.status !== "connected") {
      return `错误：MCP 服务器「${serverName}」未连接`;
    }
    try {
      return await entry.client.callTool(realName, args);
    } catch (error) {
      return `错误：MCP 调用失败 - ${error.message}`;
    }
  }

  isMcpTool(toolName) {
    return /^mcp__/.test(toolName);
  }

  /** 状态快照（给界面用） */
  status() {
    return this.servers.map((s) => {
      const entry = this.clients.get(s.name);
      return {
        name: s.name,
        type: s.type || "stdio",
        enabled: s.enabled !== false,
        status: entry?.status || "disconnected",
        error: entry?.error || null,
        toolCount: entry?.tools?.length || 0,
        tools: (entry?.tools || []).map((t) => t.name),
        target: s.type === "http" ? s.url : [s.command, ...(s.args || [])].join(" "),
      };
    });
  }
}

module.exports = { McpManager };
