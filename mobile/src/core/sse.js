// Server-Sent Events client for React Native.
//
// RN 的 fetch 不支持读取流式响应体（response.body 为 undefined），
// 所以这里用 XMLHttpRequest 的增量 onprogress 事件来逐行解析 SSE。
// 与桌面版 model-client.js 的解析逻辑保持一致：处理
// response.output_text.delta / response.output_item.added / ... / response.completed。

export class SseError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "SseError";
    this.status = status;
  }
}

/**
 * 发起一个流式 SSE 请求。
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.headers
 * @param {string} opts.body JSON 字符串
 * @param {object} opts.handlers 各事件类型的处理函数
 * @param {(type:string, payload:any)=>void} opts.handlers.onEvent
 * @param {() => void} [opts.handlers.onOpen]
 * @param {(err:Error)=>void} [opts.handlers.onError]
 * @param {() => void} [opts.handlers.onDone]
 * @param {AbortSignal} [opts.signal]
 */
export function streamSse({ url, headers = {}, body, handlers, signal }) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", url, true);
  xhr.setRequestHeader("content-type", "application/json");
  xhr.setRequestHeader("accept", "text/event-stream");
  for (const [k, v] of Object.entries(headers)) {
    if (v != null && v !== "") xhr.setRequestHeader(k, v);
  }
  // 保证按增量回调，而不是一次性缓冲
  xhr.responseType = "text";
  xhr.timeout = 0;

  let buffer = "";
  let lastIndex = 0;
  let finished = false;

  const onAbort = () => {
    if (!finished) {
      finished = true;
      handlers.onDone?.();
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  xhr.onreadystatechange = () => {
    if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
      if (xhr.status >= 400) {
        finished = true;
        xhr.abort();
        const friendly = friendlyError(xhr.status, xhr.responseText || "");
        handlers.onError?.(new SseError(friendly, { status: xhr.status }));
      }
    }
  };

  xhr.onprogress = () => {
    const text = xhr.responseText || "";
    const chunk = text.slice(lastIndex);
    lastIndex = text.length;
    if (!chunk) return;
    buffer += chunk;
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
      handlers.onEvent?.(ev.type, ev);
    }
  };

  xhr.onload = () => {
    if (finished) return;
    finished = true;
    // 收尾：处理可能残留的缓冲
    const text = xhr.responseText || "";
    const chunk = text.slice(lastIndex);
    if (chunk) {
      buffer += chunk;
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
        handlers.onEvent?.(ev.type, ev);
      }
    }
    if (xhr.status >= 400) {
      handlers.onError?.(new SseError(friendlyError(xhr.status, xhr.responseText || ""), { status: xhr.status }));
    } else {
      handlers.onDone?.();
    }
  };

  xhr.onerror = () => {
    if (finished) return;
    finished = true;
    handlers.onError?.(new SseError("无法连接模型服务（网络错误）"));
  };

  xhr.onabort = () => {
    if (finished) return;
    finished = true;
    handlers.onDone?.();
  };

  xhr.send(body);

  return {
    abort() {
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
    },
  };
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
