"use strict";

/**
 * 模型客户端：对接本地模型路由器（Codex 同款，Responses API）。
 * 支持流式文本 + function calling。
 */

class ModelError extends Error {
  constructor(message, { status = 0, code = "", body = "" } = {}) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function normalizeBaseUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(chat\/completions|responses)$/i, "");
  return url;
}

function endpoint(baseUrl, suffix) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new ModelError("尚未配置模型服务地址", { code: "no_base_url" });
  return /\/v\d+$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

function friendlyError(status, bodyText) {
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

class ModelClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  /**
   * 取连接参数。
   * @param {object=} override 临时覆盖（设置面板里尚未保存的表单值）。
   *   传入后就完全以它为准（空值也照用），不回落到已保存配置，
   *   避免用户清空地址后仍静默连到旧地址。
   */
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

  /** @param {object=} override 临时连接参数，见 #conn */
  async listModels(override) {
    const conn = this.#conn(override);
    const url = endpoint(conn.baseUrl, "/models"); // 地址没配置时在这里就报 no_base_url，别被下面包成 network
    let res;
    try {
      res = await fetch(url, {
        headers: this.#headers(conn),
        signal: AbortSignal.timeout(15000),
      });
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
      // 有的网关 200 却返回 HTML 或纯文本，这里必须明确报错，不能假装成功
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
  async stream({ messages, tools = [], systemPrompt = "", signal, onText, onToolCallStart }) {
    const conn = this.#conn();
    if (!conn.model) throw new ModelError("尚未选择模型", { code: "no_model" });

    const payload = {
      model: conn.model,
      input: toInput(messages),
      stream: true,
      max_output_tokens: 8000,
    };
    if (systemPrompt) payload.instructions = systemPrompt;
    if (conn.reasoningEffort) payload.reasoning = { effort: conn.reasoningEffort };
    if (tools.length) payload.tools = tools;

    let res;
    try {
      res = await fetch(endpoint(conn.baseUrl, "/responses"), {
        method: "POST",
        headers: { ...this.#headers(conn), accept: "text/event-stream" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (e.name === "AbortError") return { text: "", toolCalls: [], usage: null, model: conn.model, aborted: true };
      throw new ModelError(`无法连接模型服务：${e.message}`, { code: "network" });
    }
    if (!res.ok) {
      throw new ModelError(friendlyError(res.status, await res.text().catch(() => "")), { status: res.status });
    }

    // 非流式回退
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream") || !res.body) {
      const j = await res.json().catch(() => null);
      return this.#parseNonStream(j, conn.model, onText);
    }

    let text = "";
    const calls = [];
    const partial = new Map(); // item_id -> {name, args}
    let usage = null;
    let model = conn.model;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          // 中止时 Node 有时抛 TypeError: terminated（cause 是 AbortError），
          // 不能当成真实错误，否则「停止」会显示成「出错」
          if (signal?.aborted || e.name === "AbortError" || e.cause?.name === "AbortError") {
            return { text, toolCalls: calls, usage, model, aborted: true };
          }
          throw e;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }

          switch (ev.type) {
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
              throw new ModelError(err.message || "模型返回失败", { code: "stream_error" });
            }
            default:
              break;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }

    return { text, toolCalls: calls, usage, model, aborted: false };
  }

  #parseNonStream(json, model, onText) {
    const out = Array.isArray(json?.output) ? json.output : [];
    let text = "";
    const calls = [];
    for (const item of out) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === "string") text += c.text;
        }
      }
      if (item.type === "function_call") {
        calls.push({
          callId: item.call_id || item.callId || `call_${calls.length + 1}`,
          name: item.name,
          arguments: item.arguments || "{}",
        });
      }
    }
    if (text) onText?.(text);
    return { text, toolCalls: calls, usage: json?.usage || null, model: json?.model || model, aborted: false };
  }
}

module.exports = { ModelClient, ModelError, normalizeBaseUrl, endpoint };
