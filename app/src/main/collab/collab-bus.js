"use strict";

/**
 * Bot 之间的协作总线。
 *
 * 三种协作方式（对齐官方产品）：
 *   1. 委派 delegate —— A 把子任务交给 B，等结果（同步）
 *   2. 留言 message  —— A 给 B 发消息，B 下次对话能看到（异步）
 *   3. 群聊 room     —— 多个 Bot 就同一话题依次发言（广播）
 *
 * 数据落盘在 <dataDir>/collab/
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class CollabBus {
  constructor(dataDir, { getBots }) {
    this.dir = path.join(dataDir, "collab");
    this.getBots = getBots;
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = new Map();
    this.#loadQueue();
  }

  #file(roomId) {
    return path.join(this.dir, `${sanitize(roomId)}.json`);
  }

  #inboxFile() {
    return path.join(this.dir, "_inbox.json");
  }

  #loadQueue() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#inboxFile(), "utf8"));
      for (const [k, v] of Object.entries(raw || {})) this.queue.set(k, v);
    } catch {
      /* 首次运行 */
    }
  }

  #saveQueue() {
    try {
      fs.writeFileSync(this.#inboxFile(), JSON.stringify(Object.fromEntries(this.queue), null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }

  /** 给某个 Bot 投递待处理消息 */
  deliver(toBotId, message) {
    const list = this.queue.get(toBotId) || [];
    list.push({ ...message, at: Date.now(), id: "m-" + crypto.randomBytes(4).toString("hex") });
    this.queue.set(toBotId, list.slice(-50));
    this.#saveQueue();
  }

  /** 取出并清空收件箱 */
  takeInbox(botId) {
    const list = this.queue.get(botId) || [];
    if (list.length) {
      this.queue.delete(botId);
      this.#saveQueue();
    }
    return list;
  }

  /** 追加群聊消息 */
  appendRoom(roomId, entry) {
    const f = this.#file(roomId);
    let room = { id: roomId, messages: [] };
    try {
      room = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      /* 新房间 */
    }
    room.messages.push({ ...entry, at: Date.now() });
    room.messages = room.messages.slice(-200);
    fs.writeFileSync(f, JSON.stringify(room, null, 2), "utf8");
    return room;
  }

  readRoom(roomId) {
    try {
      return JSON.parse(fs.readFileSync(this.#file(roomId), "utf8"));
    } catch {
      return { id: roomId, messages: [] };
    }
  }

  listRooms() {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        out.push({ id: r.id, messageCount: r.messages?.length || 0, lastAt: r.messages?.at(-1)?.at || 0 });
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  findBot(name) {
    const bots = this.getBots();
    return (
      bots.find((b) => b.name === name) ||
      bots.find((b) => b.name.includes(name) || name.includes(b.name)) ||
      null
    );
  }
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "-") || "room";
}

module.exports = { CollabBus };
