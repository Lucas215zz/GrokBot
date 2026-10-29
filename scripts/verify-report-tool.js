"use strict";
/**
 * report_result 工具 + Agent 循环透传自检（不需要 Electron / 真实模型）
 *   node scripts/verify-report-tool.js
 *
 * 用假的 model client 模拟「模型调用 report_result」：
 * 1. 工具执行不报错，且把结果写进 ctx.report
 * 2. runAgent 返回的 report 与上报内容一致
 * 3. 审批策略把 report_result 归为 safe（不弹窗、无人值守也能调）
 */
const path = require("node:path");
const { runAgent } = require(path.join(__dirname, "..", "app/src/main/agent/loop"));
const { executeTool } = require(path.join(__dirname, "..", "app/src/main/tools/executor"));
const { classifyTool } = require(path.join(__dirname, "..", "app/src/main/approval/policy"));

let fail = 0;
const ok = (n, c, extra = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? "  " + extra : ""}`); if (!c) fail++; };

(async () => {
  console.log("\n[1] report_result 归为 safe（不触发审批）");
  {
    const c = classifyTool("report_result", { status: "success", summary: "x" });
    ok("category=safe", c.category === "safe", JSON.stringify(c));
  }

  console.log("\n[2] executeTool 写入 ctx.report");
  {
    const report = { status: null, summary: "", details: "", reportedAt: null };
    const out = await executeTool(
      { name: "report_result", arguments: JSON.stringify({ status: "blocked", summary: "未登录", details: "需要扫码" }) },
      { computer: {}, reportResult: (r) => Object.assign(report, r) },
    );
    ok("返回包含「受阻」", /受阻/.test(out), out);
    ok("report.status=blocked", report.status === "blocked");
    ok("report.summary=未登录", report.summary === "未登录");
    ok("report.details=需要扫码", report.details === "需要扫码");
  }

  console.log("\n[3] runAgent 透传 report 给调度器");
  {
    const report = { status: null, summary: "", details: "", reportedAt: null };
    // 第一轮：模型调用 report_result；第二轮：模型给出最终答复
    let turn = 0;
    const fakeClient = {
      async stream({ onText }) {
        turn++;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [{ callId: "c1", name: "report_result", arguments: JSON.stringify({ status: "success", summary: "抓到 5 条" }) }],
          };
        }
        onText?.("已完成");
        return { text: "已完成", toolCalls: [], usage: null, model: "mock" };
      },
    };
    const res = await runAgent({
      client: fakeClient,
      history: [{ role: "user", content: "干活" }],
      systemPrompt: "",
      computer: {},
      report,
      emit: () => {},
    });
    ok("返回值带 report", Boolean(res.report));
    ok("report.status=success", res.report?.status === "success");
    ok("report.summary=抓到 5 条", res.report?.summary === "抓到 5 条");
    ok("reportedAt 已写入", typeof res.report?.reportedAt === "number");
    ok("最终文本仍正常返回", res.text === "已完成", res.text);
  }

  console.log(fail === 0 ? "\n✓ report_result 工具与循环透传通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
