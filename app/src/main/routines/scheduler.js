"use strict";

/**
 * 例程调度器：每秒检查一次，到点就触发。
 *
 * 设计要点：
 * - 同一时刻只允许一条例程在跑（避免并发把机器打满）
 * - 触发后立刻算出 nextRunAt，避免重复触发
 * - 执行失败不会停掉调度，只记录日志
 */

const { computeNextRun } = require("./routine-store");

const TICK_MS = 1000;

class RoutineScheduler {
  constructor({ store, runRoutine, onEvent }) {
    this.store = store;
    this.runRoutine = runRoutine;
    this.onEvent = onEvent || (() => {});
    this.timer = null;
    this.busy = new Set();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#tick().catch(() => {}), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    // 启动时补齐 nextRunAt（防止休眠后错过）
    for (const r of this.store.list()) {
      if (!r.enabled) continue;
      if (!r.nextRunAt || r.nextRunAt < Date.now() - 6 * 3600 * 1000) {
        this.store.update(r.id, { nextRunAt: computeNextRun(r.schedule, Date.now()) });
      }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async #tick() {
    const now = Date.now();
    for (const routine of this.store.list()) {
      if (!routine.enabled) continue;
      if (routine.nextRunAt == null) continue;
      if (routine.nextRunAt > now) continue;
      if (this.busy.has(routine.id)) continue;

      this.busy.add(routine.id);
      // 先推进下次时间，避免重复触发
      this.store.update(routine.id, { nextRunAt: computeNextRun(routine.schedule, now) });
      this.onEvent({ type: "routine_started", routine: { id: routine.id, name: routine.name, botId: routine.botId } });

      this.#execute(routine).finally(() => this.busy.delete(routine.id));
    }
  }

  async #execute(routine) {
    const startedAt = Date.now();
    let entry;
    try {
      const result = await this.runRoutine(routine);
      entry = {
        at: startedAt,
        ok: !result?.error,
        durationMs: Date.now() - startedAt,
        summary: (result?.text || result?.error || "（无输出）").slice(0, 300),
        steps: result?.steps ?? null,
      };
    } catch (error) {
      entry = {
        at: startedAt,
        ok: false,
        durationMs: Date.now() - startedAt,
        summary: error.message,
        steps: null,
      };
    }
    this.store.logRun(routine.id, entry);
    this.onEvent({
      type: entry.ok ? "routine_done" : "routine_failed",
      routine: { id: routine.id, name: routine.name, botId: routine.botId },
      entry,
    });
  }

  /** 手动立即跑一次（测试用） */
  async runNow(routineId) {
    const routine = this.store.get(routineId);
    if (!routine) throw new Error("例程不存在");
    await this.#execute(routine);
    return this.store.get(routineId);
  }
}

module.exports = { RoutineScheduler };
