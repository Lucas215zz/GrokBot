// 技能存储：手机端用 AsyncStorage 存技能（SKILL.md 内容整体存为字符串）。
// 列表返回 { id, name, description }；read 返回完整对象。

import AsyncStorage from "@react-native-async-storage/async-storage";
import { sanitizeId } from "../core/util";

const KEY = "grokbot:skills";

export function parseFrontmatter(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  const fmText = m[1];
  for (const line of fmText.split(/\r?\n/)) {
    const km = /^([A-Za-z0-9_.\-\/]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!km) continue;
    meta[km[1]] = km[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: m[2] == null ? "" : m[2] };
}

function collapse(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

export class SkillStore {
  constructor() {
    this.ready = this.#load();
  }

  async #load() {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      this.items = raw ? JSON.parse(raw) : [];
    } catch {
      this.items = [];
    }
  }

  async #persist() {
    await AsyncStorage.setItem(KEY, JSON.stringify(this.items));
  }

  list() {
    return this.items
      .map((s) => ({ id: s.id, name: s.name || s.id, description: collapse(s.description), dir: null, hasScripts: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  read(id) {
    const s = this.items.find((x) => x.id === id);
    if (!s) return null;
    return { id: s.id, name: s.name || s.id, description: s.description || "", body: s.body || "", dir: null, hasScripts: false, files: [], meta: {} };
  }

  async save(id, { name, description, body }) {
    const safeId = sanitizeId(id);
    const existing = this.items.find((x) => x.id === safeId);
    const item = {
      id: safeId,
      name: name || safeId,
      description: description || "",
      body: body || "",
      updatedAt: Date.now(),
      createdAt: existing?.createdAt || Date.now(),
    };
    if (existing) this.items = this.items.map((x) => (x.id === safeId ? item : x));
    else this.items.push(item);
    await this.#persist();
    return this.read(safeId);
  }

  async remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    await this.#persist();
    return true;
  }

  /** 从纯文本导入一个技能（用于引导示例） */
  async importFromText(text) {
    const { meta, body } = parseFrontmatter(text);
    const id = sanitizeId(meta.name || "skill-" + Date.now().toString(36));
    return this.save(id, { name: meta.name, description: meta.description, body });
  }
}
