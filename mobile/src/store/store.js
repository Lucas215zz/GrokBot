// 数据层：Bot、会话、设置。基于 AsyncStorage 持久化。

import AsyncStorage from "@react-native-async-storage/async-storage";
import { newId } from "../core/util";

const KEYS = {
  app: "grokbot:app",
  bots: "grokbot:bots",
  sessions: (botId) => `grokbot:sessions:${botId}`,
};

const DEFAULT_APP = {
  version: 1,
  provider: {
    baseUrl: "http://127.0.0.1:8788/v1",
    apiKey: "local-router",
    model: "",
    reasoningEffort: "",
  },
  computer: { kind: "local", baseUrl: "", token: "" },
  approval: { mode: "balanced" },
  ui: { theme: "dark" },
};

const PALETTE = ["#6b4eff", "#ff5d8f", "#35d07f", "#ffb020", "#4ea8ff", "#c86bff", "#ff7a45"];

export class Store {
  constructor() {
    this.app = null;
    this.bots = [];
    this.sessionsCache = new Map(); // botId -> session[]
    this.ready = this.#init();
  }

  async #init() {
    try {
      const raw = await AsyncStorage.getItem(KEYS.app);
      const parsed = raw ? JSON.parse(raw) : {};
      this.app = {
        ...DEFAULT_APP,
        ...parsed,
        provider: { ...DEFAULT_APP.provider, ...(parsed.provider || {}) },
        computer: { ...DEFAULT_APP.computer, ...(parsed.computer || {}) },
        approval: { ...DEFAULT_APP.approval, ...(parsed.approval || {}) },
        ui: { ...DEFAULT_APP.ui, ...(parsed.ui || {}) },
      };
    } catch {
      this.app = { ...DEFAULT_APP };
    }
    try {
      const raw = await AsyncStorage.getItem(KEYS.bots);
      this.bots = raw ? JSON.parse(raw) : [];
    } catch {
      this.bots = [];
    }
  }

  getApp() {
    return this.app;
  }

  async updateApp(patch) {
    const p = { ...this.app, ...patch };
    if (patch.provider) p.provider = { ...this.app.provider, ...patch.provider };
    if (patch.ui) p.ui = { ...this.app.ui, ...patch.ui };
    if (patch.computer) p.computer = { ...this.app.computer, ...patch.computer };
    if (patch.approval) p.approval = { ...this.app.approval, ...patch.approval };
    this.app = p;
    await AsyncStorage.setItem(KEYS.app, JSON.stringify(this.app));
    return this.app;
  }

  listBots() {
    return this.bots.slice().sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return b.updatedAt - a.updatedAt;
    });
  }

  getBot(id) {
    return this.bots.find((b) => b.id === id) || null;
  }

  async #persistBots() {
    await AsyncStorage.setItem(KEYS.bots, JSON.stringify(this.bots));
  }

  async createBot({ name, description = "", systemPrompt = "", color, emoji, enabledSkills }) {
    const id = "bot-" + newId();
    const now = Date.now();
    const bot = {
      id,
      name: name || "新 Bot",
      description,
      systemPrompt: systemPrompt || "你是一个能操作手机的助手。需要真实信息时使用工具，不要编造。回答用简体中文。",
      color: color || PALETTE[Math.floor(Math.random() * PALETTE.length)],
      emoji: emoji || "🤖",
      enabledSkills: Array.isArray(enabledSkills) ? enabledSkills : [],
      approvalMode: "inherit",
      pinned: false,
      pinnedAt: null,
      workspace: `workspaces/${id}`,
      createdAt: now,
      updatedAt: now,
    };
    this.bots.push(bot);
    await this.#persistBots();
    return bot;
  }

  async updateBot(id, patch) {
    const bot = this.getBot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch, id: bot.id, updatedAt: Date.now() };
    this.bots = this.bots.map((b) => (b.id === id ? next : b));
    await this.#persistBots();
    return next;
  }

  async setBotPinned(id, pinned) {
    const bot = this.getBot(id);
    if (!bot) return null;
    const next = { ...bot, pinned: Boolean(pinned), pinnedAt: pinned ? Date.now() : null };
    this.bots = this.bots.map((b) => (b.id === id ? next : b));
    await this.#persistBots();
    return next;
  }

  async deleteBot(id) {
    this.bots = this.bots.filter((b) => b.id !== id);
    await this.#persistBots();
    this.sessionsCache.delete(id);
    await AsyncStorage.removeItem(KEYS.sessions(id));
    return true;
  }

  async listSessions(botId) {
    if (this.sessionsCache.has(botId)) return this.sessionsCache.get(botId);
    let list = [];
    try {
      const raw = await AsyncStorage.getItem(KEYS.sessions(botId));
      list = raw ? JSON.parse(raw) : [];
    } catch {
      list = [];
    }
    this.sessionsCache.set(botId, list);
    return list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSession(botId, sessionId) {
    const list = await this.listSessions(botId);
    return list.find((s) => s.id === sessionId) || null;
  }

  async createSession(botId, title = "新对话") {
    const now = Date.now();
    const s = { id: "s-" + newId(), botId, title, messages: [], createdAt: now, updatedAt: now };
    const list = await this.listSessions(botId);
    list.push(s);
    await this.#saveSessions(botId, list);
    return s;
  }

  async saveSession(session) {
    session.updatedAt = Date.now();
    const list = await this.listSessions(session.botId);
    const i = list.findIndex((s) => s.id === session.id);
    if (i >= 0) list[i] = session;
    else list.push(session);
    await this.#saveSessions(session.botId, list);
    return session;
  }

  async deleteSession(botId, sessionId) {
    const list = await this.listSessions(botId);
    const next = list.filter((s) => s.id !== sessionId);
    await this.#saveSessions(botId, next);
    return true;
  }

  async #saveSessions(botId, list) {
    this.sessionsCache.set(botId, list);
    await AsyncStorage.setItem(KEYS.sessions(botId), JSON.stringify(list));
  }
}
