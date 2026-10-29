"use strict";

/**
 * 例程调度器：每秒检查一次，到点就触发。
 *
 * 设计要点：
 * - 同一条例程同一时刻只跑一次（手动触发和定时触发共用一份运行表，避免叠加）
 * - 后台执行：触发后立即返回，不阻塞调用方（IPC / 定时器）
 * - 每条运行有自己的 AbortController，可以单独停止
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
    /** @type {Map<string, {controller: AbortController, startedAt: number, trigger: string}>} */
    this.runs = new Map(); // routineId -> 运行句柄
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

  /** 停止调度并中止所有正在跑的例程 */
  shutdown() {
    this.stop();
    for (const h of this.runs.values()) h.controller.abort();
  }

  /** 某条例程是否正在后台运行 */
  isRunning(routineId) {
    return this.runs.has(routineId);
  }

  /** 正在运行的例程 id 列表（供界面显示） */
  runningIds() {
    return [...this.runs.keys()];
  }

  /** 运行中的例程快照：{ id: { startedAt, trigger } } */
  runningInfo() {
    const out = {};
    for (const [id, h] of this.runs) out[id] = { startedAt: h.startedAt, trigger: h.trigger };
    return out;
  }

  async #tick() {
    const now = Date.now();
    for (const routine of this.store.list()) {
      if (!routine.enabled) continue;
      if (routine.nextRunAt == null) continue;
      if (routine.nextRunAt > now) continue;
      if (this.runs.has(routine.id)) continue;

      // 先推进下次时间，避免重复触发
      this.store.update(routine.id, { nextRunAt: computeNextRun(routine.schedule, now) });
      this.#launch(routine, "schedule");
    }
  }

  /**
   * 启动一次后台运行并立即返回。
   * @returns {{started:boolean, alreadyRunning?:boolean}}
   */
  #launch(routine, trigger) {
    if (this.runs.has(routine.id)) return { started: false, alreadyRunning: true };
    const controller = new AbortController();
    const handle = { controller, startedAt: Date.now(), trigger };
    this.runs.set(routine.id, handle);

    this.onEvent({
      type: "routine_started",
      routine: { id: routine.id, name: routine.name, botId: routine.botId },
      trigger,
      startedAt: handle.startedAt,
    });

    // 关键：不 await —— 后台跑，结束再回收。调用方（IPC / 定时器）立刻返回。
    this.#execute(routine, controller.signal, trigger)
      .catch(() => {})
      .finally(() => this.runs.delete(routine.id));

    return { started: true };
  }

  async #execute(routine, signal, trigger) {
    const startedAt = Date.now();
    let entry;
    try {
      const result = await this.runRoutine(routine, signal);
      const aborted = Boolean(result?.aborted) || Boolean(signal?.aborted);
      // 关键：以模型「上报的结果」为准，而不是「只要吐了字就算成功」。
      // - success  → ok
      // - blocked  → 未完成（缺少授权/登录/数据），标记 blocked
      // - failed / 未上报 → 失败
      const rep = result?.report || null;
      const reportStatus = rep && ["success", "blocked", "failed"].includes(rep.status) ? rep.status : null;
      const ok = !aborted && !result?.error && reportStatus === "success";
      const blocked = !aborted && !result?.error && reportStatus === "blocked";
      const unreported = !aborted && !result?.error && !reportStatus;
      let summary;
      if (aborted) summary = "已手动停止";
      else if (result?.error) summary = String(result.error).slice(0, 300);
      else if (reportStatus) summary = String(rep.summary || rep.details || "").slice(0, 300) || "（模型未给出摘要）";
      else if (unreported) summary = "模型未上报执行结果（未调用 report_result），按失败处理：" + String(result?.text || "").slice(0, 240);
      else summary = String(result?.text || result?.error || "（无输出）").slice(0, 300);
      entry = {
        at: startedAt,
        ok,
        blocked,
        reportStatus,
        stopped: aborted,
        trigger,
        durationMs: Date.now() - startedAt,
        summary,
        steps: result?.steps ?? null,
      };
    } catch (error) {
      const aborted = Boolean(signal?.aborted);
      entry = {
        at: startedAt,
        ok: false,
        blocked: false,
        reportStatus: null,
        stopped: aborted,
        trigger,
        durationMs: Date.now() - startedAt,
        summary: aborted ? "已手动停止" : error.message,
        steps: null,
      };
    }
    this.store.logRun(routine.id, entry);
    this.onEvent({
      type: entry.ok ? "routine_done" : "routine_failed",
      routine: { id: routine.id, name: routine.name, botId: routine.botId },
      trigger,
      entry,
    });
  }

  /**
   * 手动「立即运行」：后台启动，立刻返回，不阻塞界面。
   * @returns {{started:boolean, alreadyRunning?:boolean}}
   */
  runNow(routineId) {
    const routine = this.store.get(routineId);
    if (!routine) throw new Error("例程不存在");
    return this.#launch(routine, "manual");
  }

  /** 停止一条正在运行的例程。返回是否真的中止了一个运行。 */
  stopRoutine(routineId) {
    const h = this.runs.get(routineId);
    if (!h) return false;
    h.controller.abort();
    return true;
  }
}

module.exports = { RoutineScheduler };
