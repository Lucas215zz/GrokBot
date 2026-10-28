"use strict";

/**
 * 例程「后台执行 + 关窗口不中断」端到端实测。
 *   node scripts/verify-routine-background.js
 *
 * 用临时 userData 目录 + 本地 mock 模型，不碰用户真实数据。
 * 覆盖：
 * 1. 点「立即运行」立刻返回（不阻塞界面），按钮变成「停止」
 * 2. 运行中关窗口 —— 进程必须还活着（收进托盘，不再 quit）
 * 3. 关窗口之后任务继续跑完，结果写进 routines.json
 * 4. 可以正常退出
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const exe = path.resolve(__dirname, "..", "dist", "app", "Grok Bot.exe");
const CDP_PORT = 9341;
const MOCK_PORT = 47931;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (n, c, extra = "") => {
  console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? "  " + extra : ""}`);
  if (!c) fail++;
};

/** 慢速 mock：先吐一段，再拖约 9 秒才结束，方便中途关窗口 */
function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = (req.url || "/").split("?")[0];
    if (url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
    }
    if (url !== "/v1/responses") { res.writeHead(404).end("{}"); return; }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "开始处理…" })}\n\n`);
    await sleep(9000);
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "后台任务已经完成。" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { model: "mock-model", usage: { input_tokens: 5, output_tokens: 5 } } })}\n\n`);
    res.end();
  });
  return new Promise((r) => server.listen(MOCK_PORT, () => r(server)));
}

function seedUserData() {
  const dir = path.join(os.tmpdir(), "grokbot-rt-test-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify({
    version: 1,
    provider: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "k", model: "mock-model", reasoningEffort: "" },
    computer: { kind: "local", baseUrl: "", token: "" },
    approval: { mode: "off" },
    ui: { theme: "dark" },
    window: { width: 1180, height: 820, x: null, y: null, maximized: false },
  }, null, 2));
  const botId = "bot-test01";
  const workspace = path.join(dir, "workspaces", botId);
  fs.mkdirSync(path.join(dir, "bots", botId, "sessions"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(dir, "bots", botId, "bot.json"), JSON.stringify({
    id: botId, name: "测试 Bot", description: "", systemPrompt: "用简体中文。",
    emoji: "🤖", enabledSkills: [], approvalMode: "inherit", pinned: false, pinnedAt: null,
    workspace, createdAt: Date.now(), updatedAt: Date.now(),
  }, null, 2));
  fs.writeFileSync(path.join(dir, "routines.json"), JSON.stringify({
    routines: [{
      id: "rt-bg01", botId, name: "后台慢任务", prompt: "随便说一句话即可",
      schedule: { kind: "interval", minutes: 120 }, enabled: true, allowRisky: false,
      createdAt: Date.now(), updatedAt: Date.now(), lastRunAt: null,
      nextRunAt: Date.now() + 3600e3, logs: [],
    }],
  }, null, 2));
  return { dir, botId };
}

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error("CDP 未就绪");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  const mock = await startMock();
  const { dir } = seedUserData();
  const child = spawn(exe, [`--user-data-dir=${dir}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: "ignore" });

  let ws = null;
  try {
    const page = await findPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    let n = 0; const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const id = ++n; pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
    const ev = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
      return r.result.value;
    };
    await sleep(3000);

    console.log("\n[1] 点「立即运行」应立刻返回");
    const click = await ev(`(async()=>{
      await window.openRoutines();
      await new Promise(r=>setTimeout(r,400));
      const btn = document.querySelector('#rtList .rt-act button');
      const t0 = Date.now();
      btn.click();
      await new Promise(r=>setTimeout(r,1200));
      const btns = [...document.querySelectorAll('#rtList .rt-act button')].map(b=>b.textContent);
      return { elapsed: Date.now()-t0, btns };
    })()`);
    ok("1.2s 内按钮已变成「停止」", click.btns.includes("停止"), JSON.stringify(click.btns));
    ok("没有卡在「运行中…」", !click.btns.some((t) => t.includes("运行中")), JSON.stringify(click.btns));

    console.log("\n[2] 运行中关窗口，进程必须还活着");
    // 模拟用户点右上角 X：渲染进程 window.close() → BrowserWindow 'close' 事件
    await ev(`(()=>{ setTimeout(()=>window.close(), 0); return true; })()`);
    await sleep(2500);
    ok("关窗口后进程仍在运行（收进托盘）", alive(child.pid));

    console.log("\n[3] 关窗口后任务继续跑完并落盘");
    const routinesFile = path.join(dir, "routines.json");
    let entry = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      try {
        const j = JSON.parse(fs.readFileSync(routinesFile, "utf8"));
        entry = j.routines[0].logs.slice(-1)[0] || null;
      } catch { /* 可能正在写 */ }
      if (entry) break;
    }
    ok("执行记录已写入", Boolean(entry), entry ? `${entry.durationMs}ms` : "无");
    ok("执行成功", Boolean(entry && entry.ok), entry ? String(entry.summary).slice(0, 40) : "");
    ok("是后台跑完的（耗时 > 8s）", Boolean(entry && entry.durationMs > 8000), entry ? `${entry.durationMs}ms` : "");
    ok("关窗后仍拿到完整回复", Boolean(entry && /完成/.test(String(entry.summary || ""))), entry ? String(entry.summary).slice(0, 40) : "");

    console.log("\n[4] 可以正常退出");
    try { child.kill(); } catch { /* ignore */ }
    await sleep(1800);
    ok("进程已结束", !alive(child.pid));
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    mock.close();
  }

  console.log(fail === 0 ? "\n✓ 例程后台执行端到端全部通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
