"use strict";

/**
 * 窗口边界回归：
 * 上次保存的窗口尺寸超过当前屏幕工作区时（换显示器 / 改缩放 / 大屏最大化后关闭），
 * 窗口底部会伸出屏幕，导致最下方的输入框看不见。
 *
 * 这里直接注入一份「比屏幕还高」的窗口状态，启动应用，然后断言：
 *   1) 视口高度不超过屏幕工作区；
 *   2) 输入框和发送按钮完整落在视口内；
 *   3) 没有把整页撑出滚动条。
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const exe = path.join(root, "dist", "app", "Grok Bot.exe");
const appDir = path.join(process.env.APPDATA || os.homedir(), "Grok Bot");
const appJson = path.join(appDir, "app.json");
const backup = path.join(os.tmpdir(), "grokbot-appjson-backup-" + Date.now() + ".json");
const PORT = 9337;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error("CDP 未就绪");
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error("找不到 " + exe);
  if (!fs.existsSync(appDir)) throw new Error("找不到数据目录 " + appDir);

  fs.copyFileSync(appJson, backup);
  let child = null;
  let failures = 0;
  const ok = (name, cond, extra) => {
    console.log("  " + (cond ? "✓" : "✗") + " " + name + (extra ? "  " + extra : ""));
    if (!cond) failures++;
  };

  try {
    // 注入「比屏幕还高 + 位置偏下」的坏状态
    const base = JSON.parse(fs.readFileSync(appJson, "utf8"));
    base.window = { width: 1400, height: 4000, x: 80, y: 120, maximized: false };
    fs.writeFileSync(appJson, JSON.stringify(base, null, 2), "utf8");

    child = spawn(exe, ["--remote-debugging-port=" + PORT], { stdio: "ignore" });
    const target = await findPage();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
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

    await send("Runtime.enable");
    await sleep(2800);

    console.log("\n[窗口边界]");
    const box = JSON.parse(
      await evaluate(`JSON.stringify({
        ih: innerHeight, iw: innerWidth,
        availH: screen.availHeight, availW: screen.availWidth,
        composer: (() => { const r = document.querySelector('.composer').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; })(),
        send: (() => { const r = document.getElementById('sendBtn').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; })(),
        foot: (() => { const r = document.querySelector('.composer-foot').getBoundingClientRect(); return { bottom: Math.round(r.bottom) }; })(),
        docScroll: document.documentElement.scrollHeight,
        appScroll: document.querySelector('.app').scrollHeight
      })`),
    );

    ok("视口高度不高于屏幕工作区", box.ih <= box.availH, `innerHeight=${box.ih} availHeight=${box.availH}`);
    ok("视口宽度不大于屏幕工作区", box.iw <= box.availW, `innerWidth=${box.iw} availWidth=${box.availW}`);
    ok("输入框完整在视口内", box.composer.bottom <= box.ih && box.composer.top >= 0 && box.composer.h >= 20, JSON.stringify(box.composer));
    ok("发送按钮完整在视口内", box.send.bottom <= box.ih && box.send.h > 0, JSON.stringify(box.send));
    ok("底部状态行在视口内", box.foot.bottom <= box.ih, JSON.stringify(box.foot));
    ok("整页没有溢出滚动", box.appScroll <= box.ih + 1, `appScroll=${box.appScroll} ih=${box.ih}`);

    ws.close();
  } finally {
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
    await sleep(600);
    fs.copyFileSync(backup, appJson);
    fs.rmSync(backup, { force: true });
    // 清理可能残留的进程
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("taskkill", ["/IM", "Grok Bot.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }

  if (failures) {
    console.log("\n✗ 窗口边界有 " + failures + " 项未通过");
    process.exit(1);
  }
  console.log("\n✓ 窗口边界全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
