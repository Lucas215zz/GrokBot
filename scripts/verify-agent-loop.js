"use strict";
/**
 * Agent 循环自检（纯本地，不启动应用、不连模型）
 *   node scripts/verify-agent-loop.js
 *
 * 重点验证「步数用尽不要静默停 / 不要假成功」：
 * 1. 正常结束（模型不再调用工具）→ 干净完成
 * 2. 一批步数用尽但还在干活 → 自动续跑，续跑后完成
 * 3. 续跑也用尽 → maxStepsReached=true（未完成，不是假成功）
 * 4. 中途停止 → aborted
 */
const path = require("node:path");
const { runAgent } = require(path.join(__dirname, "..", "app/src/main/agent/loop"));

let fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

/** 按脚本依次返回：每一项 = 一次 stream 的结果 */
function scriptedClient(script) {
  let i = 0;
  return {
    calls: 0,
    async stream() {
      this.calls++;
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return {
        text: step.text || "",
        toolCalls: step.toolCalls || [],
        usage: null,
        model: "fake",
        aborted: Boolean(step.aborted),
      };
    },
  };
}

const callList = (id) => ({ callId: id, name: "list_files", arguments: "{}" });
const computer = { listFiles: async () => "（空）" };

(async () => {
  console.log("\n[1] 正常结束（模型不再调用工具）");
  {
    const events = [];
    const client = scriptedClient([
      { text: "先看一下", toolCalls: [callList("c1")] },
      { text: "做完了", toolCalls: [] },
    ]);
    const r = await runAgent({
      client,
      history: [{ role: "user", content: "任务" }],
      computer,
      emit: (e) => events.push(e),
      maxSteps: 5,
    });
    ok("steps=2", r.steps === 2, String(r.steps));
    ok("没有标记未完成", !r.maxStepsReached);
    ok("发出 done 事件", events.some((e) => e.type === "done"));
  }

  console.log("\n[2] 一批步数用尽但仍在干活 → 自动续跑后完成");
  {
    const events = [];
    // 每批 maxSteps=2；前两次都调用工具（用尽第一批），第三次不调用 → 续跑后完成
    const client = scriptedClient([
      { text: "", toolCalls: [callList("a1")] },
      { text: "", toolCalls: [callList("a2")] },
      { text: "续跑后做完了", toolCalls: [] },
    ]);
    const r = await runAgent({
      client,
      history: [{ role: "user", content: "任务" }],
      computer,
      emit: (e) => events.push(e),
      maxSteps: 2,
      maxContinuations: 2,
    });
    ok("steps=3", r.steps === 3, String(r.steps));
    ok("没有标记未完成", !r.maxStepsReached);
    ok("发出 continuing 事件", events.some((e) => e.type === "continuing"), "batch=" + (events.find((e) => e.type === "continuing")?.batch));
    ok("最终 done", events.some((e) => e.type === "done"));
  }

  console.log("\n[3] 续跑也用尽 → 标记未完成（不是假成功）");
  {
    const events = [];
    // 一直调用工具：maxSteps=2 + 2 次续跑 = 3 批 × 2 = 6 步
    const client = scriptedClient([{ text: "", toolCalls: [callList("x")] }]);
    const r = await runAgent({
      client,
      history: [{ role: "user", content: "任务" }],
      computer,
      emit: (e) => events.push(e),
      maxSteps: 2,
      maxContinuations: 2,
    });
    ok("steps=6", r.steps === 6, String(r.steps));
    ok("标记 maxStepsReached", r.maxStepsReached === true);
    ok("continuations=2", r.continuations === 2, String(r.continuations));
    ok("发出 max_steps 事件", events.some((e) => e.type === "max_steps"));
    ok("没有 done 事件（没假装完成）", !events.some((e) => e.type === "done"));
  }

  console.log("\n[4] 中途停止 → aborted");
  {
    const events = [];
    const client = scriptedClient([{ aborted: true }]);
    const r = await runAgent({
      client,
      history: [{ role: "user", content: "任务" }],
      computer,
      emit: (e) => events.push(e),
      maxSteps: 5,
    });
    ok("aborted=true", r.aborted === true);
    ok("发出 aborted 事件", events.some((e) => e.type === "aborted"));
  }

  console.log(fail === 0 ? "\n✓ Agent 循环自检通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
