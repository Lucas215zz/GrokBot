// Bot 协作总线（留言 / 群聊）。AsyncStorage 持久化。

import AsyncStorage from "@react-native-async-storage/async-storage";
import { newId, sanitizeId } from "../core/util";

const INBOX = "grokbot:collab:inbox";
const ROOM_PREFIX = "grokbot:collab:room:";

export class CollabBus {
  constructor({ getBots }) {
    this.getBots = getBots;
    this.queue = new Map();
    this.ready = this.#load();
  }

  async #load() {
    try {
      const raw = await AsyncStorage.getItem(INBOX);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) this.queue.set(k, v);
    } catch {
      /* ignore */
    }
  }

  async #saveQueue() {
    await AsyncStorage.setItem(INBOX, JSON.stringify(Object.fromEntries(this.queue)));
  }

  async deliver(toBotId, message) {
    const list = this.queue.get(toBotId) || [];
    list.push({ ...message, at: Date.now(), id: "m-" + newId() });
    this.queue.set(toBotId, list.slice(-50));
    await this.#saveQueue();
  }

  async takeInbox(botId) {
    const list = this.queue.get(botId) || [];
    if (list.length) {
      this.queue.delete(botId);
      await this.#saveQueue();
    }
    return list;
  }

  async appendRoom(roomId, entry) {
    const key = ROOM_PREFIX + sanitizeId(roomId);
    let room = { id: roomId, messages: [] };
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) room = JSON.parse(raw);
    } catch {
      /* new room */
    }
    room.messages.push({ ...entry, at: Date.now() });
    room.messages = room.messages.slice(-200);
    await AsyncStorage.setItem(key, JSON.stringify(room));
    return room;
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
