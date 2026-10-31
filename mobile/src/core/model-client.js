// 模型客户端：对接 OpenAI Responses 兼容服务（本地路由器 / 云端）。
// 与桌面版保持行为一致，但流式输出改用 sse.js 的 XHR 增量解析，
// 因为 React Native 的 fetch 不支持读取响应体流。

import { streamSse, SseError } from "./sse";

export class ModelError extends Error {
  constructor(message, { status = 0, code = "", body = "" } = {}) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function normalizeBaseUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(chat\/completions|responses)$/i, "");
  return url;
}

export function endpoint(baseUrl, suffix) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new ModelError("尚未配置模型服务地址", { code: "no_base_url" });
  return /\/v\d+$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

/** 把会话消息转成 Responses input */
function toInput(messages) {
  return messages.map((m) => {
    if (m.type === "function_call") {
      return { type: "function_call", call_id: m.callId, name: m.name, arguments: m.arguments };
    }
    if (m.type === "function_call_output") {
      return { type: "function_call_output", call_id: m.callId, output: m.output };
    }
    return {
      type: "message",
      role: m.role === "assistant" ? "assistant" : "user",
      content: [
        { type: m.role === "assistant" ? "output_text" : "input_text", text: String(m.content ?? "") },
      ],
    };
  });
}

export class ModelClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  #conn(override) {
    const cfg = this.getConfig();
    const p = cfg.provider || {};
    const src = override && typeof override === "object" ? override : p;
    return {
      baseUrl: src.baseUrl || "",
      apiKey: src.apiKey || "",
      model: src.model || "",
      reasoningEffort: src.reasoningEffort || "",
    };
  }

  #headers(conn) {
    const c = conn || this.#conn();
    const h = { "content-type": "application/json" };
    if (c.apiKey) h.authorization = `Bearer ${c.apiKey}`;
    return h;
  }

  async listModels(override) {
    const conn = this.#conn(override);
    const url = endpoint(conn.baseUrl, "/models");
    let res;
    try {
      res = await fetch(url, { headers: this.#headers(conn) });
    } catch (e) {
      throw new ModelError(`无法连接模型服务：${e.message}`, { code: "network" });
    }
    if (!res.ok) {
      throw new ModelError(friendlyError(res.status, await res.text().catch(() => "")), {
        status: res.status,
        code: "http",
      });
    }
    const bodyText = await res.text().catch(() => "");
    let j;
    try {
      j = JSON.parse(bodyText);
    } catch {
      throw new ModelError(
        `接口返回的不是 JSON（地址可能指到了网页而非 API）：${String(bodyText || "").slice(0, 80)}`,
        { code: "not_json" },
      );
    }
    const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    return list.map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);
  }

  /**
   * 流式补全。
   * @returns {Promise<{text:string, toolCalls:Array, usage:object|null, model:string, aborted:boolean}>}
   */
  stream({ messages, tools = [], systemPrompt = "", signal, onText, onToolCallStart }) {
    const conn = this.#conn();
    if (!conn.model) return Promise.reject(new ModelError("尚未选择模型", { code: "no_model" }));

    const payload = {
      model: conn.model,
      input: toInput(messages),
      stream: true,
      max_output_tokens: 8000,
    };
    if (systemPrompt) payload.instructions = systemPrompt;
    if (conn.reasoningEffort) payload.reasoning = { effort: conn.reasoningEffort };
    if (tools.length) payload.tools = tools;

    const url = endpoint(conn.baseUrl, "/responses");

    return new Promise((resolve, reject) => {
      let text = "";
      const calls = [];
      const partial = new Map();
      let usage = null;
      let model = conn.model;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      if (signal?.aborted) {
        return finish({ text: "", toolCalls: [], usage: null, model, aborted: true });
      }

      const handleEvent = (type, ev) => {
        switch (type) {
          case "response.output_text.delta": {
            const d = ev.delta || "";
            if (d) {
              text += d;
              onText?.(d);
            }
            break;
          }
          case "response.output_item.added": {
            const item = ev.item;
            if (item?.type === "function_call") {
              partial.set(item.id || item.callId || String(ev.output_index), {
                name: item.name,
                args: "",
                callId: item.call_id || item.callId,
              });
              onToolCallStart?.(item.name);
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const entry = partial.get(ev.item_id);
            if (entry) entry.args += ev.delta || "";
            break;
          }
          case "response.output_item.done": {
            const item = ev.item;
            if (item?.type === "function_call") {
              calls.push({
                callId: item.call_id || item.callId || `call_${calls.length + 1}`,
                name: item.name,
                arguments: item.arguments || partial.get(item.id)?.args || "{}",
              });
              partial.delete(item.id);
            }
            break;
          }
          case "response.completed": {
            const r = ev.response || {};
            if (r.model) model = r.model;
            if (r.usage) usage = r.usage;
            break;
          }
          case "response.failed":
          case "error": {
            const err = ev.response?.error || ev.error || {};
            fail(new ModelError(err.message || "模型返回失败", { code: "stream_error" }));
            break;
          }
          default:
            break;
        }
      };

      streamSse({
        url,
        headers: this.#headers(conn),
        body: JSON.stringify(payload),
        signal,
        handlers: {
          onEvent: handleEvent,
          onError: (err) => {
            if (err instanceof SseError && err.status) fail(new ModelError(err.message, { status: err.status }));
            else fail(new ModelError(err.message, { code: "network" }));
          },
          onDone: () => {
            if (signal?.aborted) finish({ text, toolCalls: calls, usage, model, aborted: true });
            else finish({ text, toolCalls: calls, usage, model, aborted: false });
          },
        },
      });
    });
  }
}

export function friendlyError(status, bodyText) {
  let detail = "";
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.message || "";
    if (typeof detail === "object") detail = JSON.stringify(detail);
  } catch {
    detail = String(bodyText || "").slice(0, 200);
  }
  const map = {
    400: "请求被拒绝",
    401: "鉴权失败",
    402: "余额不足",
    403: "无权访问该模型",
    404: "接口不存在（检查地址是否含 /v1）",
    429: "限流或额度用尽",
    500: "上游内部错误",
    502: "上游网关错误",
    503: "服务不可用",
    504: "上游超时",
  };
  const head = map[status] || `HTTP ${status}`;
  return detail ? `${head}：${detail}` : head;
}
