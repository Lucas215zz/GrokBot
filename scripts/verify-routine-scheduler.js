"use strict";
/**
 * 例程调度器离线自检（不需要 Electron / 不需要模型）
 *   node scripts/verify-routine-scheduler.js
 *
 * 覆盖：
 * 1. 「立即运行」必须立刻返回（后台执行），不能等整轮跑完
 * 2. 运行中能查到 runningInfo（界面据此显示「停止」）
 * 3. 同一条例程不会并发叠跑
 * 4. 停止能让本轮真的中止，并记录 stopped
 * 5. 定时触发同样走后台，且先推进 nextRunAt
 */
const path = require("node:path");
const { RoutineScheduler } = require(path.join(__dirname, "..", "app/src/main/routines/scheduler"));

let fail = 0;
const ok = (n, c, extra = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? "  " + extra : ""}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStore(routine) {
  const r = { ...routine, logs: [] };
  return {
    list: () => [r],
    get: (id) => (id === r.id ? r : null),
    update: (id, patch) => Object.assign(r, patch),
    logRun: (id, entry) => { r.logs.push(entry); r.lastRunAt = entry.at; return r; },
    _r: r,
  };
}

(async () => {
  console.log("\n[1] 立即运行必须立刻返回");
  {
    const store = fakeStore({ id: "rt1", botId: "b1", name: "慢任务", schedule: { kind: "interval", minutes: 60 }, enabled: true, nextRunAt: Date.now() + 3600e3 });
    let release;
    const done = new Promise((res) => (release = res));
    const events = [];
    const sched = new RoutineScheduler({
      store,
      runRoutine: async () => { await done; return { text: "完成", steps: 1 }; },
      onEvent: (ev) => events.push(ev),
    });
    const t0 = Date.now();
    const r = sched.runNow("rt1");
    const elapsed = Date.now() - t0;
    ok("runNow 返回 started", r.started === true);
    ok("runNow 立刻返回（<100ms）", elapsed < 100, `${elapsed}ms`);
    ok("启动事件已发出", events.some((e) => e.type === "routine_started" && e.trigger === "manual"));
    ok("运行中可查到状态", Boolean(sched.runningInfo().rt1) && sched.isRunning("rt1"));

    console.log("\n[2] 同一例程不并发叠跑");
    const again = sched.runNow("rt1");
    ok("第二次返回 alreadyRunning", again.alreadyRunning === true && again.started === false);

    console.log("\n[3] 停止能真正中止");
    const stopOk = sched.stopRoutine("rt1");
    ok("stopRoutine 返回 true", stopOk === true);
    release();
    await sleep(80);
    const entry = store._r.logs[0];
    ok("记录了一次执行", Boolean(entry));
    ok("标记为已停止", entry && entry.stopped === true, entry && entry.summary);
    ok("运行表已清空", !sched.isRunning("rt1"));
    ok("完成事件已发出", events.some((e) => e.type === "routine_failed" || e.type === "routine_done"));
    sched.stop();
  }

  console.log("\n[4] 定时触发也走后台");
  {
    const store = fakeStore({ id: "rt2", botId: "b1", name: "定时", schedule: { kind: "interval", minutes: 60 }, enabled: true, nextRunAt: Date.now() - 1000 });
    let release2;
    const done2 = new Promise((res) => (release2 = res));
    const events = [];
    const sched = new RoutineScheduler({ store, runRoutine: async () => { await done2; return { text: "ok" }; }, onEvent: (ev) => events.push(ev) });
    const before = store._r.nextRunAt;
    sched.start();
    await sleep(1400);
    ok("到点后进入运行表", sched.isRunning("rt2"));
    ok("nextRunAt 已推进到未来", store._r.nextRunAt > Date.now(), String(new Date(store._r.nextRunAt).toISOString()));
    ok("nextRunAt 确实变了", store._r.nextRunAt !== before);
    ok("触发来源是 schedule", events.some((e) => e.type === "routine_started" && e.trigger === "schedule"));
    release2();
    await sleep(60);
    ok("结束后运行表清空", !sched.isRunning("rt2"));
    sched.shutdown();
  }

  console.log(fail === 0 ? "\n✓ 例程调度器自检全部通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
