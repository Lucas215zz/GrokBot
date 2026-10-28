"use strict";

/**
 * 极简 OpenAI Responses 兼容 mock（仅用于离线验证审批链路）。
 *
 * 它按「对话里是否已出现 function_call_output」来决定下一步：
 * - 首次：如果用户要求删除，就发一个 run_command 的 function_call
 * - 收到工具结果后：读结果内容，输出一段总结
 *
 * 这样能确定性地复现「模型想删 → 审批拦/放 → 模型看到结果再回话」。
 */

const http = require("node:http");

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function startMockModel({ port = 47922 } = {}) {
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
      res.writeHead(404).end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const input = Array.isArray(body.input) ? body.input : [];
    const userText = input
      .filter((m) => m.type === "message" && m.role === "user")
      .map((m) => (m.content || []).map((c) => c.text || "").join(""))
      .join("\n");
    const lastOutput = [...input].reverse().find((m) => m.type === "function_call_output");
    const sawBlock = lastOutput && /已阻止/.test(String(lastOutput.output || ""));

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const wantsDelete = /删除|删掉|remove/i.test(userText);
    const wantsList = /列|有哪些|看一下/i.test(userText) && !wantsDelete;

    // 第二轮：已有工具结果 → 总结
    if (lastOutput) {
      const text = sawBlock
        ? "操作被审批拦截了，文件没有被删除，我不会绕过它。"
        : `已按你的要求执行完毕。工具返回：${String(lastOutput.output || "").slice(0, 60).replace(/\n/g, " ")}`;
      sse(res, { type: "response.output_text.delta", delta: text });
      sse(res, { type: "response.completed", response: { model: "mock-model", usage: { input_tokens: 10, output_tokens: 10 } } });
      return res.end();
    }

    if (wantsDelete) {
      const m = /([\w.-]+\.(?:txt|md|log|json))/.exec(userText);
      const target = m ? m[1] : "keep.txt";
      const args = JSON.stringify({ command: `Remove-Item .\\${target} -Force` });
      sse(res, { type: "response.output_item.added", item: { id: "fc1", type: "function_call", name: "run_command", call_id: "call_1" } });
      sse(res, { type: "response.function_call_arguments.delta", item_id: "fc1", delta: args });
      sse(res, { type: "response.output_item.done", item: { id: "fc1", type: "function_call", name: "run_command", call_id: "call_1", arguments: args } });
      sse(res, { type: "response.completed", response: { model: "mock-model" } });
      return res.end();
    }

    if (wantsList) {
      sse(res, { type: "response.output_item.added", item: { id: "fc2", type: "function_call", name: "list_files", call_id: "call_2" } });
      sse(res, { type: "response.function_call_arguments.delta", item_id: "fc2", delta: JSON.stringify({ path: "." }) });
      sse(res, { type: "response.output_item.done", item: { id: "fc2", type: "function_call", name: "list_files", call_id: "call_2", arguments: JSON.stringify({ path: "." }) } });
      sse(res, { type: "response.completed", response: { model: "mock-model" } });
      return res.end();
    }

    sse(res, { type: "response.output_text.delta", delta: "好的。" });
    sse(res, { type: "response.completed", response: { model: "mock-model" } });
    res.end();
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { startMockModel };

if (require.main === module) {
  startMockModel().then((s) => {
    console.log("mock 模型已启动 :" + s.address().port);
  });
}
