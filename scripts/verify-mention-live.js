"use strict";
/**
 * 实机验证：@技能名 直接调用（真实 Electron + 真实模型）。
 * 前置：先关掉正在运行的 Grok Bot（单实例锁）。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const exe = path.resolve(__dirname, "..", "dist", "app", "Grok Bot.exe");
const PORT = 9377;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("CDP 未就绪");
}
function attach(ws) {
  let nextId = 0; const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate };
}

(async () => {
  const child = spawn(exe, ["--remote-debugging-port=" + PORT], { stdio: "ignore" });
  let fail = 0;
  const ok = (n, c, x) => { console.log("  " + (c ? "✓" : "✗") + " " + n + (x && !c ? "  -> " + x : "")); if (!c) fail++; };
  try {
    const target = await findPage();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const { send, evaluate } = attach(ws);
    await send("Runtime.enable");
    await sleep(3000);

    const skillCount = await evaluate("window.gbState.skills.length");
    ok("已加载真实技能（≥8）", skillCount >= 8, String(skillCount));

    const pop = await evaluate(`(() => {
      const el = document.getElementById('input');
      el.value = '@'; el.setSelectionRange(1,1);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { open: document.getElementById('mentionPop').hidden === false,
               n: document.querySelectorAll('#mentionList .mention-item').length };
    })()`);
    ok("@ 弹出真实技能候选", pop.open && pop.n >= 8, JSON.stringify(pop));

    const filt = await evaluate(`(() => {
      const el = document.getElementById('input');
      el.value = '@munger'; el.setSelectionRange(7,7);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { n: document.querySelectorAll('#mentionList .mention-item').length,
               first: document.querySelector('#mentionList .mention-item .m-name')?.textContent || '' };
    })()`);
    ok("@munger 精确过滤", filt.n === 1 && filt.first === "@munger-perspective", JSON.stringify(filt));

    const applied = await evaluate(`(() => {
      const el = document.getElementById('input');
      el.value = '@munger'; el.setSelectionRange(7,7);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      return { value: el.value, closed: document.getElementById('mentionPop').hidden === true };
    })()`);
    ok("Tab 确认填入 @名字", applied.value === "@munger-perspective " && applied.closed, JSON.stringify(applied));

    await evaluate(`(async () => {
      await newSession();
      const el = document.getElementById('input');
      el.value = '@munger-perspective 用一句话说什么是能力圈';
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
    })()`);

    let sawSkill = false, sawText = false, namesSeen = [];
    for (let i = 0; i < 200; i++) {
      const st = await evaluate(`(() => {
        const names = [...document.querySelectorAll('#messages .tool .tool-name')].map(x=>x.textContent);
        const live = document.querySelector('#messages .live .content')?.textContent || '';
        const bub = [...document.querySelectorAll('#messages .msg.assistant .content')].map(x=>x.textContent).join('');
        const busy = document.getElementById('sendBtn').classList.contains('busy');
        return { names, liveLen: live.length, bubLen: bub.length, busy };
      })()`);
      if (st.names.includes('已加载技能')) { sawSkill = true; namesSeen = st.names; }
      if (st.liveLen > 0 || st.bubLen > 0) sawText = true;
      if (!st.busy && i > 3) break;
      await sleep(500);
    }
    ok("对话中出现「已加载技能」轨迹", sawSkill, JSON.stringify(namesSeen.slice(0,8)));
    ok("模型有实际回复文本", sawText);
  } catch (e) {
    console.error("测试异常：", e.message);
    fail++;
  } finally {
    try { child.kill(); } catch {}
    console.log(fail ? "\n✗ 失败 " + fail : "\n✓ @技能实机验证通过");
    process.exit(fail ? 1 : 0);
  }
})();
