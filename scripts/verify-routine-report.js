"use strict";
/**
 * 例程「真实结果上报」自检（不需要 Electron / 不需要模型）
 *   node scripts/verify-routine-report.js
 *
 * 背景：以前 scheduler 用 ok = !result.error && !aborted，只要模型吐了字就算成功，
 * 于是「我没能完成」也被记成成功（假成功）。现在改为以 report_result 上报为准：
 *   - success  → ok=true
 *   - blocked  → ok=false, blocked=true
 *   - failed   → ok=false
 *   - 未上报   → ok=false（不再静默算成功）
 *   - 被停止   → stopped=true, ok=false
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

async function runOnce(runRoutineImpl, { abortAfterMs } = {}) {
  const store = fakeStore({
    id: "rtR", botId: "b1", name: "测试", schedule: { kind: "interval", minutes: 60 },
    enabled: true, nextRunAt: Date.now() + 3600e3,
  });
  const sched = new RoutineScheduler({ store, runRoutine: runRoutineImpl, onEvent: () => {} });
  sched.runNow("rtR");
  if (abortAfterMs != null) {
    await sleep(abortAfterMs);
    sched.stopRoutine("rtR");
  }
  for (let i = 0; i < 300 && store._r.logs.length === 0; i++) await sleep(20);
  sched.stop();
  return store._r.logs[0];
}

(async () => {
  console.log("\n[1] 上报 success → 成功");
  {
    const e = await runOnce(async () => ({ text: "完成", steps: 2, report: { status: "success", summary: "抓到 5 条并写入飞书" } }));
    ok("ok=true", e.ok === true);
    ok("reportStatus=success", e.reportStatus === "success");
    ok("摘要取自上报内容", /抓到 5 条/.test(e.summary), e.summary);
  }

  console.log("\n[2] 上报 blocked → 不算成功，标记受阻");
  {
    const e = await runOnce(async () => ({ text: "需要登录，没法继续", steps: 3, report: { status: "blocked", summary: "TikTok 未登录" } }));
    ok("ok=false", e.ok === false);
    ok("blocked=true", e.blocked === true);
    ok("reportStatus=blocked", e.reportStatus === "blocked");
    ok("摘要如实为受阻原因", /未登录/.test(e.summary), e.summary);
  }

  console.log("\n[3] 上报 failed → 失败");
  {
    const e = await runOnce(async () => ({ text: "出错了", report: { status: "failed", summary: "接口 500" } }));
    ok("ok=false", e.ok === false);
    ok("reportStatus=failed", e.reportStatus === "failed");
  }

  console.log("\n[4] 未上报（只吐了文字）→ 不再静默算成功");
  {
    const e = await runOnce(async () => ({ text: "我没能完成今天的抓取，原因是……", steps: 4 }));
    ok("ok=false", e.ok === false);
    ok("blocked=false（不是受阻，是没上报）", e.blocked === false);
    ok("reportStatus=null", e.reportStatus === null);
    ok("摘要明确写了未上报", /未上报/.test(e.summary), e.summary);
  }

  console.log("\n[5] 被停止 → stopped=true 且 ok=false");
  {
    const e = await runOnce(async (routine, signal) => {
      // 真实 runAgent 会感知 abort；这里用可中断的等待模拟
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
      if (signal?.aborted) return { text: "", aborted: true };
      return { report: { status: "success", summary: "x" } };
    }, { abortAfterMs: 120 });
    ok("stopped=true", e.stopped === true);
    ok("ok=false", e.ok === false);
    ok("摘要=已手动停止", e.summary === "已手动停止", e.summary);
  }

  console.log(fail === 0 ? "\n✓ 例程结果上报自检全部通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
