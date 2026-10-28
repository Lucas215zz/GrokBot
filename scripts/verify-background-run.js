"use strict";

/**
 * 后台运行端到端验证（需要真实模型服务在线）。
 *   node scripts/verify-background-run.js
 *
 * 覆盖：
 * 1. 一个对话跑着时，切到另一个对话不打断它，切回来还能看到实时文本
 * 2. 两个对话可以同时后台跑，侧栏各自有运行小圆点
 * 3. 切到别的 Bot 不打断已有运行
 * 4. 当前对话的运行按钮是「停止」，点它能终止
 * 5. 结束后最终回复落盘，磁盘上不留 streaming 残影
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

const exe = path.resolve(__dirname, "..", "dist", "app", "Grok Bot.exe");
const PORT = 9339;
const PROMPT =
  "不要调用任何工具。请连续输出一篇约 1200 字的技术短文，主题：HTTP 缓存机制（Cache-Control、ETag、Last-Modified 的作用与区别）。要分段、逐条展开，不要省略。";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error("CDP 未就绪");
}

function attach(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { evaluate };
}

async function main() {
  const child = spawn(exe, ["--remote-debugging-port=" + PORT], { stdio: "ignore" });
  let failures = 0;
  const ok = (name, cond, extra) => {
    console.log("  " + (cond ? "✓" : "✗") + " " + name + (extra ? "  " + extra : ""));
    if (!cond) failures++;
  };

  let ctx = null;
  try {
    const target = await findPage();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const { evaluate } = attach(ws);
    await sleep(3200);

    console.log("\n[后台运行]");
    const setup = await evaluate(`(async()=>{
      const S=window.gbState;
      if(!S.botId) throw new Error('没有可用的 Bot');
      const a=await window.api.sessions.create(S.botId,'后台测试A');
      const b=await window.api.sessions.create(S.botId,'后台测试B');
      S.sessions=await window.api.sessions.list(S.botId); window.renderSessions();
      await window.selectSession(a.id);
      document.getElementById('input').value=${JSON.stringify(PROMPT)};
      window.syncComposer(); window.send();
      return {botId:S.botId,a:a.id,b:b.id};
    })()`);
    ctx = setup;
    ok("已启动后台任务", Boolean(setup.a), JSON.stringify(setup));

    const midway = await evaluate(`(async()=>{
      const S=window.gbState; const key=S.botId+':'+${JSON.stringify(setup.a)};
      await new Promise(r=>setTimeout(r,900));
      const run=S.runs.get(key);
      const before={running:!!run, accLen:run?run.acc.length:0, live:!!document.querySelector('#messages .live')};
      await window.selectSession(${JSON.stringify(setup.b)});
      const bLive=!!document.querySelector('#messages .live');
      const stillRunning=S.runs.has(key);
      await new Promise(r=>setTimeout(r,2500));
      const run2=S.runs.get(key);
      const accGrew=!!run2 && run2.acc.length>before.accLen;
      await window.selectSession(${JSON.stringify(setup.a)});
      const backText=document.querySelector('#messages .live .content')?.textContent||'';
      return {before,bLive,stillRunning,accGrew,backLive:!!document.querySelector('#messages .live'),backText};
    })()`);
    ok("运行中显示实时区", midway.before.running && midway.before.live, JSON.stringify(midway.before));
    ok("切到别的对话不显示它的实时区", midway.bLive === false);
    ok("切走后任务仍在运行", midway.stillRunning === true);
    ok("切走期间输出继续增长", midway.accGrew === true);
    ok("切回来能看到实时文本", midway.backLive === true && midway.backText.length > 0, JSON.stringify(String(midway.backText).slice(0, 40)));

    // 并发：B 也跑起来
    await evaluate(`(async()=>{
      const S=window.gbState;
      await window.selectSession(${JSON.stringify(setup.b)});
      document.getElementById('input').value=${JSON.stringify(PROMPT)};
      window.syncComposer(); window.send();
    })()`);
    await sleep(1600);
    const both = await evaluate(`(()=>{const S=window.gbState;
      return {count:S.runs.size, dots:document.querySelectorAll('#sessionList .run-dot').length,
        status:document.getElementById('statusLine').textContent,
        busy:document.getElementById('sendBtn').classList.contains('busy')};})()`);
    ok("两个对话可同时后台运行", both.count === 2, String(both.count));
    ok("侧栏两个会话各有运行点", both.dots === 2, String(both.dots));
    ok("状态行反映运行中", /工作中|在后台/.test(both.status || ""), JSON.stringify(both.status));
    ok("当前对话按钮是停止态", both.busy === true);

    const sw = await evaluate(`(async()=>{const S=window.gbState;
      const other=S.bots.find(b=>b.id!==S.botId);
      if(!other) return {skip:true};
      await window.selectBot(other.id);
      await new Promise(r=>setTimeout(r,1200));
      return {skip:false, still:S.runs.size, botDot:document.querySelectorAll('#botList .run-dot').length};})()`);
    if (sw.skip) console.log("  - 只有一个 Bot，跳过切换 Bot 检查");
    else {
      ok("切到别的 Bot 不打断已有运行", sw.still >= 2, String(sw.still));
      ok("原 Bot 名字旁显示运行点", sw.botDot >= 1, String(sw.botDot));
    }

    // 停止：切回 A，点按钮
    const stop = await evaluate(`(async()=>{const S=window.gbState;
      await window.selectBot(${JSON.stringify(setup.botId)});
      await window.selectSession(${JSON.stringify(setup.a)});
      const busy=document.getElementById('sendBtn').classList.contains('busy');
      document.getElementById('sendBtn').click();
      await new Promise(r=>setTimeout(r,1800));
      return {busy, hasA:S.runs.has(S.botId+':'+${JSON.stringify(setup.a)})};})()`);
    ok("运行中按钮是停止态", stop.busy === true);
    ok("点停止后该对话被终止", stop.hasA === false);

    // 等 B 也结束，检查落盘
    const finished = await evaluate(`(async()=>{const S=window.gbState;
      const key=S.botId+':'+${JSON.stringify(setup.b)};
      for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,500)); if(!S.runs.has(key)) break; }
      const s=await window.api.sessions.get(S.botId, ${JSON.stringify(setup.b)});
      const msgs=s.messages||[];
      const assistant=msgs.filter(m=>m.role==='assistant');
      return {running:S.runs.has(key), assistantCount:assistant.length,
        text:(assistant[assistant.length-1]||{}).content||'', hasStreaming:msgs.some(m=>m.streaming)};})()`);
    ok("后台任务自然结束", finished.running === false);
    ok("最终回复已落盘", finished.assistantCount >= 1 && String(finished.text).length > 20, JSON.stringify(String(finished.text).slice(0, 40)));
    ok("磁盘上没有残留流式快照", finished.hasStreaming === false);

    ws.close();
  } finally {
    // 清理测试对话（放 finally 里，失败时也会尽量清掉）
    child.kill();
  }

  if (ctx) await cleanup(ctx);
  console.log(failures === 0 ? "\n✓ 后台运行全部通过\n" : `\n✗ ${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** 直接删数据目录里的测试会话，避免依赖界面状态 */
async function cleanup(ctx) {
  const fs = require("node:fs");
  const dir = path.join(process.env.APPDATA || "", "Grok Bot", "bots", ctx.botId, "sessions");
  for (const id of [ctx.a, ctx.b]) {
    const f = path.join(dir, id + ".json");
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
