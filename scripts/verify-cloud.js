"use strict";
/**
 * 验证云计算机契约：起一台模拟云端，跑同一个 Agent，确认与本地行为一致。
 *   node scripts/verify-cloud.js
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const PORT = 47921;
const files = new Map();

// 自带一个确定性的 Responses 兼容 mock 模型：先发 run_command 建文件，收到结果后收尾。
// 这样云计算机契约测试不依赖外部本地路由（127.0.0.1:8788），离线可复现。
function startMockModel() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = (req.url || "/").split("?")[0];
    if (url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
    }
    if (url !== "/v1/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "not found" } }));
    }
    const input = Array.isArray(body.input) ? body.input : [];
    const lastOutput = [...input].reverse().find((m) => m.type === "function_call_output");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (lastOutput) {
      sse({ type: "response.output_text.delta", delta: "已完成。" });
      sse({ type: "response.completed", response: { model: "mock-model" } });
      return res.end();
    }
    const args = JSON.stringify({ command: "echo ok > verify.txt" });
    sse({ type: "response.output_item.added", item: { id: "fc1", type: "function_call", name: "run_command", call_id: "call_1" } });
    sse({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: args });
    sse({ type: "response.output_item.done", item: { id: "fc1", type: "function_call", name: "run_command", call_id: "call_1", arguments: args } });
    sse({ type: "response.completed", response: { model: "mock-model" } });
    res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = (req.url || "/").split("?")[0];
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url === "/health") return send({ ok: true, id: "vm-verify", persistent: true });
    if (url === "/fs/list") {
      const keys = [...files.keys()];
      return send({ output: keys.length ? keys.map((k) => k + "  (" + files.get(k).length + " B)").join("\n") : "（空）" });
    }
    if (url === "/fs/read") return send({ output: files.get(body.path) ?? "文件不存在" });
    if (url === "/fs/write") {
      const existed = files.has(body.path);
      files.set(body.path, body.content ?? "");
      return send({ bytes: Buffer.byteLength(body.content ?? ""), existed });
    }
    if (url === "/fs/search") {
      const hits = [...files.entries()].filter(([, v]) => v.includes(body.pattern)).map(([k]) => k + ":1: " + body.pattern);
      return send({ output: hits.join("\n") || "未找到" });
    }
    if (url === "/exec") {
      const m = /echo\s+["']?([^"'>]+)["']?\s*>\s*(\S+)/i.exec(body.command);
      if (m) { files.set(m[2], m[1].trim()); return send({ code: 0, stdout: "", stderr: "" }); }
      return send({ code: 0, stdout: "[cloud] " + body.command, stderr: "" });
    }
    if (url === "/browser/navigate") return send({ output: "已打开 " + body.url });
    if (url === "/takeover") return send({ status: "not-needed" });
    if (url === "/screen") return send({ url: null });
    send({ error: "not found" });
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

async function main() {
  const { getComputer } = require(path.join(root, "app/src/main/computer/factory"));
  const { ModelClient } = require(path.join(root, "app/src/main/agent/model-client"));
  const { runAgent } = require(path.join(root, "app/src/main/agent/loop"));

  const modelServer = await startMockModel();
  const modelBase = "http://127.0.0.1:" + modelServer.address().port + "/v1";
  const client = new ModelClient(() => ({
    provider: { baseUrl: modelBase, apiKey: "mock", model: "mock-model" },
  }));

  const server = await startMock();
  console.log("模拟云计算机已启动 :" + PORT + "  模拟模型 :" + modelServer.address().port);

  const localWs = path.join(os.tmpdir(), "verify-local-" + Date.now());
  fs.mkdirSync(localWs, { recursive: true });
  const task = "在工作目录创建一个 verify.txt，内容写 ok，然后读回来确认。";

  const local = getComputer({ computer: { kind: "local" } }, { botId: "a", workspace: localWs });
  console.log("\n[本地] capabilities:", JSON.stringify(local.capabilities()));
  const r1 = await runAgent({ client, computer: local, history: [{ role: "user", content: task }], systemPrompt: "必须用工具。", maxSteps: 6, emit: () => {} });
  console.log("[本地] steps:", r1.steps, "error:", r1.error || "none");

  const remote = getComputer({ computer: { kind: "remote", baseUrl: "http://127.0.0.1:" + PORT, token: "t" } }, { botId: "b", workspace: localWs });
  console.log("\n[云端] capabilities:", JSON.stringify(remote.capabilities()));
  const r2 = await runAgent({ client, computer: remote, history: [{ role: "user", content: task }], systemPrompt: "必须用工具。", maxSteps: 6, emit: () => {} });
  console.log("[云端] steps:", r2.steps, "error:", r2.error || "none");

  console.log("\n云端文件:", [...files.keys()]);
  console.log("本地文件:", fs.readdirSync(localWs));

  const ok = !r1.error && !r2.error && files.has("verify.txt");
  console.log("\n" + (ok ? "✓ 通过：同一套 Agent 在本地与云端均正常" : "✗ 失败"));
  server.close();
  modelServer.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
