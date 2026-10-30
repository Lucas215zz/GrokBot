"use strict";
/**
 * 自检：真起一台 grok-server，用 App 自己的 RemoteComputer 连上去跑一遍。
 *
 * 覆盖鉴权、文件读写、命令执行、危险命令拦截、路径沙箱、Bot 隔离、
 * 以及 RemoteComputer 的浏览器方法不再抛「不支持」。
 *
 *   node scripts/verify-mac-server.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const SERVER = path.join(root, "server", "grok-server.js");
const PORT = 47933;
const TOKEN = "verify-token-" + Date.now().toString(36);
const DATA_DIR = path.join(os.tmpdir(), "grok-verify-" + Date.now());

let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

async function waitHealthy(base, token, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  console.log("启动 grok-server…");
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      GROK_DATA_DIR: DATA_DIR,
      GROK_TOKEN: TOKEN,
      GROK_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const base = `http://127.0.0.1:${PORT}`;
  const ok = await waitHealthy(base, TOKEN);
  if (!ok) {
    console.error("服务端没起来。stderr:\n" + stderr);
    child.kill();
    process.exit(1);
  }

  const { RemoteComputer } = require(path.join(root, "app/src/main/computer/remote-computer"));
  const botA = new RemoteComputer({ baseUrl: base, token: TOKEN, botId: "botA" });
  const botB = new RemoteComputer({ baseUrl: base, token: TOKEN, botId: "botB" });
  const bad = new RemoteComputer({ baseUrl: base, token: "wrong-token", botId: "botA" });

  try {
    console.log("\n[1] 鉴权");
    const h = await bad.health();
    check("错 token 健康检查失败", h.ok === false, JSON.stringify(h));
    const res = await fetch(`${base}/health`);
    check("无 token 返回 401", res.status === 401, `实际 ${res.status}`);
    const good = await botA.health();
    check("正确 token 健康检查通过", good.ok === true, JSON.stringify(good));

    console.log("\n[2] 文件");
    const w = await botA.writeFile("notes/a.txt", "第一行\n第二行 Mac\n");
    check("写入新文件", w.existed === false && w.bytes > 0, JSON.stringify(w));
    const w2 = await botA.writeFile("notes/a.txt", "覆盖后\n");
    check("覆盖已有文件 existed=true", w2.existed === true);
    const r = await botA.readFile("notes/a.txt");
    check("读回内容正确", r.includes("覆盖后"), r);
    const list = await botA.listFiles(".");
    check("列目录含 notes/", list.includes("notes/"), list);
    const s = await botA.searchText("覆盖");
    // 服务端用 path.relative，Windows 下是反斜杠，统一成正斜杠再比
    check("搜索命中", s.replace(/\\/g, "/").includes("notes/a.txt"), s);

    console.log("\n[3] 路径沙箱");
    let escaped = false;
    try {
      await botA.readFile("../../../../etc/passwd");
    } catch (error) {
      escaped = /拒绝访问/.test(error.message);
    }
    check("../ 越界被拒绝", escaped);

    let absEscaped = false;
    try {
      await botA.writeFile("/tmp/grok-should-not-exist.txt", "x");
    } catch (error) {
      absEscaped = /拒绝访问/.test(error.message);
    }
    check("绝对路径越界被拒绝", absEscaped);

    console.log("\n[4] Bot 隔离");
    const listB = await botB.listFiles(".");
    check("botB 看不到 botA 的文件", !listB.includes("notes"), listB);

    console.log("\n[5] 命令执行");
    const e = await botA.exec("echo hello-from-remote");
    check("echo 成功", e.code === 0 && e.stdout.includes("hello-from-remote"), JSON.stringify(e));

    let denied = false;
    try {
      await botA.exec("rm -rf /");
    } catch (error) {
      denied = /永久拒绝/.test(error.message);
    }
    check("rm -rf / 被服务端拦截", denied);

    let denied2 = false;
    try {
      await botA.exec("csrutil disable");
    } catch (error) {
      denied2 = /永久拒绝/.test(error.message);
    }
    check("csrutil disable 被拦截", denied2);

    console.log("\n[6] RemoteComputer 浏览器方法已实现");
    for (const name of [
      "browserSnapshot",
      "browserClick",
      "browserType",
      "browserEval",
      "browserScreenshot",
      "browserTabs",
      "browserUseTab",
    ]) {
      const fn = RemoteComputer.prototype[name];
      const src = fn ? fn.toString() : "";
      check(`${name} 不是基类占位实现`, Boolean(fn) && !/这台计算机不支持/.test(src));
    }

    console.log("\n[7] capabilities");
    const caps = botA.capabilities();
    check("browser=true", caps.browser === true);
    check("screen=true", caps.screen === true);
    check("persistent=true", caps.persistent === true);
  } finally {
    child.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
