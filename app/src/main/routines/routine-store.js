"use strict";

/**
 * 例程（Routine）：让 Bot 按时间表自动干活。
 *
 * 一条例程 = 某个 Bot + 一段指令 + 一个触发规则。
 *
 * 支持三种触发：
 *   interval  —— 每隔 N 分钟
 *   daily     —— 每天固定时刻（HH:MM）
 *   weekly    —— 每周固定星期与时刻
 *
 * 每条例程保留最近 20 条执行记录（成功/失败/耗时/摘要）。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_LOGS = 20;
const MAX_ROUTINES_PER_BOT = 50;

class RoutineStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "routines.json");
    this.routines = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.routines = Array.isArray(raw.routines) ? raw.routines : [];
    } catch {
      this.routines = [];
    }
    return this.routines;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ routines: this.routines }, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list(botId) {
    return botId ? this.routines.filter((r) => r.botId === botId) : this.routines.slice();
  }

  get(id) {
    return this.routines.find((r) => r.id === id) || null;
  }

  create(input) {
    const count = this.routines.filter((r) => r.botId === input.botId).length;
    if (count >= MAX_ROUTINES_PER_BOT) {
      throw new Error(`每个 Bot 最多 ${MAX_ROUTINES_PER_BOT} 条例程`);
    }
    const routine = {
      id: "rt-" + crypto.randomBytes(4).toString("hex"),
      botId: input.botId,
      name: input.name || "未命名例程",
      prompt: input.prompt || "",
      schedule: normalizeSchedule(input.schedule),
      enabled: input.enabled !== false,
      // 无人值守的例程默认不允许危险操作（删除/联网/系统变更等）
      allowRisky: input.allowRisky === true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRunAt: null,
      nextRunAt: null,
      logs: [],
    };
    routine.nextRunAt = computeNextRun(routine.schedule, Date.now());
    this.routines.push(routine);
    this.save();
    return routine;
  }

  update(id, patch) {
    const r = this.get(id);
    if (!r) return null;
    if (patch.schedule) patch.schedule = normalizeSchedule(patch.schedule);
    Object.assign(r, patch, { id: r.id, updatedAt: Date.now() });
    if (patch.schedule || patch.enabled !== undefined) {
      r.nextRunAt = r.enabled ? computeNextRun(r.schedule, Date.now()) : null;
    }
    this.save();
    return r;
  }

  remove(id) {
    const i = this.routines.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.routines.splice(i, 1);
    this.save();
    return true;
  }

  /** 记录一次执行（最多保留 20 条） */
  logRun(id, entry) {
    const r = this.get(id);
    if (!r) return null;
    r.logs.push(entry);
    r.logs = r.logs.slice(-MAX_LOGS);
    r.lastRunAt = entry.at;
    r.nextRunAt = r.enabled ? computeNextRun(r.schedule, Date.now()) : null;
    this.save();
    return r;
  }
}

function normalizeSchedule(s) {
  const kind = s?.kind || "interval";
  if (kind === "interval") {
    const minutes = Math.max(1, Math.min(7 * 24 * 60, Number(s.minutes) || 60));
    return { kind: "interval", minutes };
  }
  if (kind === "daily") {
    return { kind: "daily", time: validTime(s.time) };
  }
  if (kind === "weekly") {
    const dow = Math.max(0, Math.min(6, Number(s.dayOfWeek) || 0));
    return { kind: "weekly", dayOfWeek: dow, time: validTime(s.time) };
  }
  return { kind: "interval", minutes: 60 };
}

function validTime(t) {
  return /^\d{2}:\d{2}$/.test(String(t || "")) ? String(t) : "09:00";
}

/** 计算下一次触发时间 */
function computeNextRun(schedule, fromMs) {
  const from = new Date(fromMs);
  if (schedule.kind === "interval") {
    return fromMs + schedule.minutes * 60 * 1000;
  }

  const [hh, mm] = schedule.time.split(":").map(Number);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hh, mm, 0, 0);

  if (schedule.kind === "daily") {
    if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  // weekly
  const target = schedule.dayOfWeek;
  let diff = target - next.getDay();
  if (diff < 0 || (diff === 0 && next.getTime() <= fromMs)) diff += 7;
  next.setDate(next.getDate() + diff);
  return next.getTime();
}

/** 人类可读的调度描述 */
function describeSchedule(schedule) {
  if (schedule.kind === "interval") {
    const m = schedule.minutes;
    if (m % 1440 === 0) return `每 ${m / 1440} 天`;
    if (m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${m} 分钟`;
  }
  if (schedule.kind === "daily") return `每天 ${schedule.time}`;
  const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `每${days[schedule.dayOfWeek]} ${schedule.time}`;
}

module.exports = { RoutineStore, computeNextRun, describeSchedule, MAX_LOGS };
