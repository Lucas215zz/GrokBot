"use strict";
/**
 * 本机浏览器模块自检（会真的拉起一个独立 profile 的 Chrome，跑完自动关掉）
 *   node scripts/verify-local-browser.js
 *
 * 覆盖：
 * 1. 自己找到 Chrome/Edge 并启动（不需要用户手动开 9333）
 * 2. navigate 打开页面
 * 3. snapshot 能列到可交互元素，并给出 uid
 * 4. eval / click / type 能用
 * 5. screenshot 落盘
 * 6. dispose 能关掉自己拉起的进程
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { LocalBrowser, findBrowserExe } = require(path.join(__dirname, "..", "app/src/main/computer/browser"));

let fail = 0;
const ok = (n, c, extra = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? "  " + extra : ""}`); if (!c) fail++; };

(async () => {
  const exe = findBrowserExe();
  console.log("\n[0] 找到浏览器");
  ok("找到 Chrome/Edge", Boolean(exe), exe || "未找到");
  if (!exe) { console.log("\n✗ 环境没有浏览器，跳过\n"); process.exit(1); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-browser-"));
  const b = new LocalBrowser({ userDataDir: dir });
  try {
    console.log("\n[1] 启动并连接");
    await b.ensure();
    const st = b.status();
    ok("已启动（自有进程）", st.running === true && st.external === false, JSON.stringify(st));
    ok("拿到调试端口", typeof st.port === "number" && st.port > 0, String(st.port));

    // 用本地 data: 页面，避免依赖外网
    console.log("\n[2] navigate + snapshot");
    await b.navigate(
      "data:text/html," +
        encodeURIComponent(
          `<html><head><meta charset="utf-8"><title>测试页</title></head><body>
           <h1>你好</h1>
           <input id="q" placeholder="搜索框" />
           <button id="go" onclick="document.title='点了'">点我</button>
           <a href="#x">链接X</a>
         </body></html>`,
        ),
    );
    const snap = await b.snapshot();
    ok("snapshot 含页面标题", /测试页/.test(snap), snap.split("\n")[0]);
    ok("snapshot 列出输入框", /搜索框/.test(snap));
    ok("snapshot 列出按钮", /点我/.test(snap));

    // 解析出 input / button 的 uid
    const inputUid = (snap.match(/\[(gb\d+)\] <[^>]*input[^>]*> 搜索框/) || [])[1];
    const btnUid = (snap.match(/\[(gb\d+)\] <[^>]*button[^>]*> 点我/) || [])[1];
    ok("能取到 input 的 uid", Boolean(inputUid), inputUid);
    ok("能取到 button 的 uid", Boolean(btnUid), btnUid);

    console.log("\n[3] type + click + eval");
    if (inputUid) {
      await b.type(inputUid, "机器人自动化");
      const v = await b.eval(`document.getElementById('q').value`);
      ok("type 写入成功", v === "机器人自动化", JSON.stringify(v));
    }
    if (btnUid) {
      await b.click(btnUid);
      const t = await b.eval(`document.title`);
      ok("click 生效", t === "点了", JSON.stringify(t));
    }

    console.log("\n[4] screenshot");
    const file = await b.screenshot();
    ok("截图已落盘", fs.existsSync(file) && fs.statSync(file).size > 1000, file);

    console.log("\n[5] dispose 关掉自有进程");
    const pid = b.proc ? b.proc.pid : null;
    b.dispose();
    await new Promise((r) => setTimeout(r, 800));
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    ok("自有浏览器进程已结束", alive === false, String(pid));
  } finally {
    try { b.dispose(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(fail === 0 ? "\n✓ 本机浏览器自检通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
