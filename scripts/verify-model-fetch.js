"use strict";

/**
 * 端到端验证：设置面板里「配置好 baseUrl + apiKey → 自动从上游拉取模型」。
 *
 * 启动一个临时 mock 上游（返回一份模型列表），再启动打包后的应用，
 * 在设置面板里只填地址/密钥（不保存），确认：
 *   1. 会自动触发拉取
 *   2. datalist 被填满，模型输入框自动选了一个默认值
 *   3. 提示文案是成功态
 *   4. 错误密钥会明确报鉴权失败，而不是静默成功
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const exe = path.resolve(__dirname, "..", "dist", "app", "Grok Bot.exe");
const CDP_PORT = 9334;
const MOCK_PORT = 47923;
const MODELS = ["deepseek-v4-pro", "glm-5.3", "kimi-k2.8-preview", "text-embedding-3-small"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMock() {
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url !== "/v1/models") return res.writeHead(404).end("{}");
    // 模拟鉴权：非正确 key 返回 401
    if ((req.headers.authorization || "") !== "Bearer good-key") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
  });
  return new Promise((r) => server.listen(MOCK_PORT, () => r(server)));
}

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* not ready */
    }
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
  return { send, evaluate };
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error("找不到 " + exe);
  const mock = await startMock();
  const child = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], { stdio: "ignore" });

  let failures = 0;
  const ok = (name, cond, extra) => {
    console.log("  " + (cond ? "✓" : "✗") + " " + name + (extra ? "  " + extra : ""));
    if (!cond) failures++;
  };

  try {
    const target = await findPage();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const { evaluate } = attach(ws);
    await sleep(3000);

    console.log("\n[从上游拉取模型]");
    await evaluate("window.openSettings()");
    await sleep(300);
    ok("设置面板已打开", (await evaluate("document.getElementById('settingsModal').hidden")) === false);

    // 先把模型框清空（已保存配置里有值，不清空就测不到「自动挑默认」）
    await evaluate("document.getElementById('modelInput').value=''");
    // 只填地址 + 正确密钥，然后触发 input 事件（模拟用户输入），不点保存
    await evaluate(`(() => {
      const b=document.getElementById('baseUrl'), k=document.getElementById('apiKey');
      b.value='http://127.0.0.1:${MOCK_PORT}/v1'; k.value='good-key';
      b.dispatchEvent(new Event('input',{bubbles:true}));
      k.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(2200);

    const opts = await evaluate("document.querySelectorAll('#modelOptions option').length");
    ok("自动拉取并填入 datalist", opts === MODELS.length, `datalist=${opts}`);
    const hint = await evaluate("document.getElementById('modelHint').textContent");
    ok("成功提示显示数量", /已拉取 4 个模型/.test(hint || ""), JSON.stringify(hint));
    const picked = await evaluate("document.getElementById('modelInput').value");
    ok("自动选中一个对话模型", picked === "deepseek-v4-pro", JSON.stringify(picked));

    // 下拉候选项应包含上游返回的全部模型
    const values = await evaluate("[...document.querySelectorAll('#modelOptions option')].map(o=>o.value)");
    ok("候选包含 embedding 模型（仍允许手动选）", values.includes("text-embedding-3-small"), JSON.stringify(values));

    // 错误密钥：应明确鉴权失败
    await evaluate(`(() => {
      const k=document.getElementById('apiKey'); k.value='bad-key';
      k.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(2200);
    const errHint = await evaluate("document.getElementById('modelHint').textContent");
    ok("错误密钥提示鉴权失败", /鉴权失败/.test(errHint || ""), JSON.stringify(errHint));

    // 换回正确密钥应恢复
    await evaluate(`(() => {
      const k=document.getElementById('apiKey'); k.value='good-key';
      k.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(2200);
    ok("改回正确密钥后恢复", /已拉取 4 个模型/.test(await evaluate("document.getElementById('modelHint').textContent") || ""));

    // 收尾：关闭设置面板，确认没有把临时值写进已保存配置
    await evaluate("document.getElementById('settingsModal').hidden=true");
    const saved = await evaluate("window.api.settings.get()");
    ok("未保存就不污染已存配置", saved.provider.baseUrl !== `http://127.0.0.1:${MOCK_PORT}/v1`, saved.provider.baseUrl);

    ws.close();
  } finally {
    child.kill();
    mock.close();
  }

  console.log(failures === 0 ? "\n✓ 模型拉取端到端通过\n" : "\n✗ " + failures + " 项失败\n");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
