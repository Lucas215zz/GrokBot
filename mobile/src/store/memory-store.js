// 长期记忆：与桌面版一致。AsyncStorage 持久化。

import AsyncStorage from "@react-native-async-storage/async-storage";
import { newId, sanitizeId } from "../core/util";

const PREFIX = "grokbot:memory:";
const MAX_PROFILE_CHARS = 3000;
const MAX_ITEMS = 500;
const TIERS = new Set(["profile", "log"]);

export class MemoryStore {
  #file(scope, botId) {
    return PREFIX + (scope === "user" ? "user" : sanitizeId(botId || "unknown"));
  }

  async #read(scope, botId) {
    try {
      const raw = await AsyncStorage.getItem(this.#file(scope, botId));
      const j = raw ? JSON.parse(raw) : { memories: [] };
      return Array.isArray(j.memories) ? j.memories : [];
    } catch {
      return [];
    }
  }

  async #write(scope, botId, memories) {
    await AsyncStorage.setItem(this.#file(scope, botId), JSON.stringify({ memories: memories.slice(-MAX_ITEMS) }));
  }

  async list(scope, botId) {
    const m = await this.#read(scope, botId);
    return m.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listAll(botId) {
    const u = await this.#read("user", null);
    const b = await this.#read("bot", botId);
    return [...u.map((m) => ({ ...m, scope: "user" })), ...b.map((m) => ({ ...m, scope: "bot" }))].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async write({ scope = "user", botId, tier = "log", topic, content, source = "user" }) {
    if (!TIERS.has(tier)) throw new Error(`未知层级：${tier}`);
    const text = String(content || "").trim();
    if (!text) throw new Error("记忆内容不能为空");
    const key = String(topic || text.slice(0, 24)).trim().slice(0, 60);
    const memories = await this.#read(scope, botId);
    const now = Date.now();
    const existing = memories.find((m) => m.tier === tier && m.topic === key);
    if (existing) {
      existing.content = text;
      existing.updatedAt = now;
      existing.source = source;
      await this.#write(scope, botId, memories);
      return existing;
    }
    const item = { id: "mem-" + newId(), tier, topic: key, content: text, source, createdAt: now, updatedAt: now };
    memories.push(item);
    await this.#write(scope, botId, memories);
    return item;
  }

  async remove(scope, botId, id) {
    const memories = await this.#read(scope, botId);
    const i = memories.findIndex((m) => m.id === id);
    if (i < 0) return false;
    memories.splice(i, 1);
    await this.#write(scope, botId, memories);
    return true;
  }

  async clear(scope, botId) {
    await this.#write(scope, botId, []);
    return true;
  }

  async search(botId, query, { tier, limit = 20, scope } = {}) {
    const q = String(query || "").trim().toLowerCase();
    let pool = scope ? (await this.listAll(botId)).filter((m) => m.scope === scope) : await this.listAll(botId);
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

  async profileBlock(botId) {
    const items = (await this.listAll(botId)).filter((m) => m.tier === "profile");
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

export { MAX_PROFILE_CHARS };
