"use strict";

/**
 * 长期记忆。
 *
 * 两级作用域：
 *   user —— 跨 Bot 共享（我的偏好、习惯、称呼）
 *   bot  —— 单个 Bot 专属（它的职责相关经验）
 *
 * 两个层级：
 *   profile —— 长期稳定的事实与偏好，每次对话都注入系统提示（预算有限，要精炼）
 *   log     —— 任务历史与经验，不自动注入，靠 recall 按需检索
 *
 * 存储：
 *   %APPDATA%\Grok Bot\memory\user.json
 *   %APPDATA%\Grok Bot\memory\<botId>.json
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PROFILE_CHARS = 3000;
const MAX_ITEMS_PER_FILE = 500;

const TIERS = new Set(["profile", "log"]);

class MemoryStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "memory");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  #file(scope, botId) {
    const name = scope === "user" ? "user" : sanitize(botId || "unknown");
    return path.join(this.dir, `${name}.json`);
  }

  #read(scope, botId) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file(scope, botId), "utf8"));
      return Array.isArray(raw.memories) ? raw.memories : [];
    } catch {
      return [];
    }
  }

  #write(scope, botId, memories) {
    const file = this.#file(scope, botId);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ memories: memories.slice(-MAX_ITEMS_PER_FILE) }, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  /** 列出某个作用域的全部记忆 */
  list(scope, botId) {
    return this.#read(scope, botId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 合并读取：全局 + 该 Bot */
  listAll(botId) {
    return [
      ...this.#read("user", null).map((m) => ({ ...m, scope: "user" })),
      ...this.#read("bot", botId).map((m) => ({ ...m, scope: "bot" })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 写入一条记忆。
   * 同一 tier + topic 视为同一条，覆盖更新，避免堆积重复。
   */
  write({ scope = "user", botId, tier = "log", topic, content, source = "user" }) {
    if (!TIERS.has(tier)) throw new Error(`未知层级：${tier}`);
    const text = String(content || "").trim();
    if (!text) throw new Error("记忆内容不能为空");
    const key = String(topic || text.slice(0, 24)).trim().slice(0, 60);

    const memories = this.#read(scope, botId);
    const now = Date.now();
    const existing = memories.find((m) => m.tier === tier && m.topic === key);

    if (existing) {
      existing.content = text;
      existing.updatedAt = now;
      existing.source = source;
      this.#write(scope, botId, memories);
      return existing;
    }

    const item = {
      id: "mem-" + crypto.randomBytes(4).toString("hex"),
      tier,
      topic: key,
      content: text,
      source,
      createdAt: now,
      updatedAt: now,
    };
    memories.push(item);
    this.#write(scope, botId, memories);
    return item;
  }

  remove(scope, botId, id) {
    const memories = this.#read(scope, botId);
    const i = memories.findIndex((m) => m.id === id);
    if (i < 0) return false;
    memories.splice(i, 1);
    this.#write(scope, botId, memories);
    return true;
  }

  /** 清空某个作用域 */
  clear(scope, botId) {
    this.#write(scope, botId, []);
    return true;
  }

  /**
   * 检索：按关键词匹配 topic / content。
   * 中英文都走简单的子串匹配，足够日常使用。
   */
  search(botId, query, { tier, limit = 20, scope } = {}) {
    const q = String(query || "").trim().toLowerCase();
    let pool = scope ? this.listAll(botId).filter((m) => m.scope === scope) : this.listAll(botId);
    if (tier) pool = pool.filter((m) => m.tier === tier);
    if (!q) return pool.slice(0, limit);

    const terms = q.split(/\s+/).filter(Boolean);
    const scored = pool
      .map((m) => {
        const hay = `${m.topic}\n${m.content}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (m.topic.toLowerCase().includes(t)) score += 3;
          if (hay.includes(t)) score += 1;
        }
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);

    return scored.slice(0, limit).map((x) => x.m);
  }

  /**
   * 生成注入系统提示的记忆块。
   * 只取 profile 层，并做长度截断，避免撑爆上下文。
   */
  profileBlock(botId) {
    const items = this.listAll(botId).filter((m) => m.tier === "profile");
    if (!items.length) return "";

    const lines = [];
    let used = 0;
    for (const m of items) {
      const line = `- ${m.topic}：${m.content}`;
      if (used + line.length > MAX_PROFILE_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    if (!lines.length) return "";

    const truncated = items.length > lines.length ? `\n（还有 ${items.length - lines.length} 条更早的记忆，可用 recall 检索）` : "";
    return `\n\n## 已记住的信息\n${lines.join("\n")}${truncated}`;
  }
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "-") || "unknown";
}

module.exports = { MemoryStore, MAX_PROFILE_CHARS };
