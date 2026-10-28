"use strict";

/**
 * 数据层：Bot、会话、设置。
 * 一个 Bot = 一个目录，内含 bot.json + sessions/*.json
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class Store {
  constructor(rootDir) {
    this.root = rootDir;
    this.botsDir = path.join(rootDir, "bots");
    this.file = path.join(rootDir, "app.json");
    fs.mkdirSync(this.botsDir, { recursive: true });
    this.app = this.#readApp();
  }

  #readApp() {
    const defaults = {
      version: 1,
      provider: {
        baseUrl: "http://127.0.0.1:8788/v1",
        apiKey: "local-router",
        model: "",
        reasoningEffort: "",
      },
      // 执行环境：local = 本机；remote = 云计算机（预留）
      computer: { kind: "local", baseUrl: "", token: "" },
      // 审批边界：strict / balanced / relaxed / off
      approval: { mode: "balanced" },
      ui: { theme: "dark" },
      window: { width: 1180, height: 820, x: null, y: null, maximized: false },
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...defaults,
        ...raw,
        provider: { ...defaults.provider, ...(raw.provider || {}) },
        computer: { ...defaults.computer, ...(raw.computer || {}) },
        approval: { ...defaults.approval, ...(raw.approval || {}) },
      };
    } catch {
      return defaults;
    }
  }

  getApp() { return this.app; }

  updateApp(patch) {
    const p = { ...this.app, ...patch };
    if (patch.provider) p.provider = { ...this.app.provider, ...patch.provider };
    if (patch.ui) p.ui = { ...this.app.ui, ...patch.ui };
    if (patch.computer) p.computer = { ...this.app.computer, ...patch.computer };
    if (patch.approval) p.approval = { ...this.app.approval, ...patch.approval };
    this.app = p;
    this.#writeApp();
    return this.app;
  }

  #writeApp() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.app, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  // ---------------- Bots ----------------
  listBots() {
    const out = [];
    for (const name of fs.readdirSync(this.botsDir)) {
      const meta = path.join(this.botsDir, name, "bot.json");
      if (!fs.existsSync(meta)) continue;
      try { out.push(JSON.parse(fs.readFileSync(meta, "utf8"))); } catch { /* skip */ }
    }
    // 置顶的排前面（最近置顶的更靠前），其余按最近更新
    return out.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return b.updatedAt - a.updatedAt;
    });
  }

  getBot(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.botsDir, id, "bot.json"), "utf8")); }
    catch { return null; }
  }

  createBot({ name, description = "", systemPrompt = "", color, emoji, enabledSkills }) {
    const id = "bot-" + crypto.randomBytes(4).toString("hex");
    const now = Date.now();
    const bot = {
      id,
      name: name || "新 Bot",
      description,
      systemPrompt: systemPrompt || "你是一个能操作电脑的助手。需要真实信息时使用工具，不要编造。回答用简体中文。",
      color: color || pickColor(),
      emoji: emoji || "🤖",
      enabledSkills: Array.isArray(enabledSkills) ? enabledSkills : [],
      // inherit = 跟随全局设置；strict/balanced/relaxed/off = 该 Bot 单独覆盖
      approvalMode: "inherit",
      pinned: false,
      pinnedAt: null,
      workspace: path.join(this.root, "workspaces", id),
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(bot.workspace, { recursive: true });
    fs.mkdirSync(path.join(this.botsDir, id, "sessions"), { recursive: true });
    this.#writeBot(bot);
    return bot;
  }

  updateBot(id, patch) {
    const bot = this.getBot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch, id: bot.id, updatedAt: Date.now() };
    this.#writeBot(next);
    return next;
  }

  /**
   * 置顶 / 取消置顶。
   * 不碰 updatedAt —— 置顶是显示偏好，不该让 Bot 在「最近更新」里插队。
   */
  setBotPinned(id, pinned) {
    const bot = this.getBot(id);
    if (!bot) return null;
    const next = {
      ...bot,
      pinned: Boolean(pinned),
      pinnedAt: pinned ? Date.now() : null,
    };
    this.#writeBot(next);
    return next;
  }

  deleteBot(id) {
    const dir = path.join(this.botsDir, id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  #writeBot(bot) {
    const dir = path.join(this.botsDir, bot.id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "bot.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(bot, null, 2), "utf8");
    fs.renameSync(tmp, path.join(dir, "bot.json"));
  }

  // ---------------- Sessions ----------------
  #sessionsDir(botId) { return path.join(this.botsDir, botId, "sessions"); }

  listSessions(botId) {
    const dir = this.#sessionsDir(botId);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        out.push({
          id: s.id, botId: s.botId, title: s.title,
          messageCount: (s.messages || []).length,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
        });
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(botId, sessionId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#sessionsDir(botId), sessionId + ".json"), "utf8"));
    } catch { return null; }
  }

  createSession(botId, title = "新对话") {
    const now = Date.now();
    const s = {
      id: "s-" + crypto.randomBytes(4).toString("hex"),
      botId, title,
      messages: [],
      createdAt: now, updatedAt: now,
    };
    this.#writeSession(s);
    return s;
  }

  saveSession(session) {
    session.updatedAt = Date.now();
    this.#writeSession(session);
    return session;
  }

  deleteSession(botId, sessionId) {
    const f = path.join(this.#sessionsDir(botId), sessionId + ".json");
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f, { force: true });
    return true;
  }

  #writeSession(s) {
    const dir = this.#sessionsDir(s.botId);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, s.id + ".json");
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    fs.renameSync(tmp, f);
  }
}

function pickColor() {
  const palette = ["#6b4eff", "#ff5d8f", "#35d07f", "#ffb020", "#4ea8ff", "#c86bff", "#ff7a45"];
  return palette[Math.floor(Math.random() * palette.length)];
}

module.exports = { Store };
