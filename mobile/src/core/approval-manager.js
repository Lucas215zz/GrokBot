// 审批网关。与桌面版一致，但不依赖 crypto / 进程级定时器，
// 超时用 setTimeout（App 前台时有效）。

import { classifyTool, shouldAsk, LABEL, SEVERITY } from "./policy";
import { clip, newId } from "./util";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalManager {
  constructor({ getGlobalMode, send, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.getGlobalMode = getGlobalMode || (() => "balanced");
    this.send = send || (() => {});
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.byKey = new Map();
    this.allowedRun = new Set();
    this.allowedSession = new Set();
    this.deniedRun = new Set();
  }

  modeFor({ mode, bot }) {
    const m = mode || bot?.approvalMode || "inherit";
    if (m && m !== "inherit") return m;
    return this.getGlobalMode() || "balanced";
  }

  async ask(input) {
    const { runId, sessionId, botId, botName, requestedBy, tool, args, mode, unattended, autoApprove, signal } = input;
    const classification = classifyTool(tool, args || {});
    const category = classification.category;

    if (classification.blocked) {
      return { allowed: false, category, blocked: true, reason: classification.reason || "该操作被永久拒绝", classification };
    }

    const policyMode = this.modeFor({ mode });
    if (!shouldAsk(policyMode, category)) {
      return { allowed: true, category, decidedBy: "policy", classification };
    }

    const ruleId = classification.ruleId || "";
    if (this.deniedRun.has(`${runId}|${ruleId}`)) {
      return { allowed: false, category, decidedBy: "cached-deny", reason: "本次运行已拒绝过该操作", classification };
    }
    if (this.allowedRun.has(`${runId}|${category}`)) {
      return { allowed: true, category, decidedBy: "run-allow", classification };
    }
    if (sessionId && this.allowedSession.has(`${sessionId}|${category}`)) {
      return { allowed: true, category, decidedBy: "session-allow", classification };
    }

    if (unattended && autoApprove) {
      return { allowed: true, category, decidedBy: "routine-allow", classification };
    }
    if (unattended) {
      return {
        allowed: false, category, decidedBy: "unattended",
        reason: `无人值守运行，已安全拒绝「${classification.label || LABEL[category] || category}」`,
        classification,
      };
    }

    const key = `${runId}|${ruleId}|${category}`;
    if (this.byKey.has(key)) return this.byKey.get(key);

    const id = "ap-" + newId();
    const request = {
      id, runId, sessionId: sessionId || null, botId: botId || null, botName: botName || "",
      requestedBy: requestedBy || "", tool, args: sanitizeArgs(args), category,
      ruleId: classification.ruleId || "", label: classification.label || LABEL[category] || category,
      reason: classification.reason || "", severity: classification.severity || SEVERITY[category] || "medium",
      detail: clip(classification.detail || "", 3000), createdAt: Date.now(), expiresAt: Date.now() + this.timeoutMs,
    };

    const promise = new Promise((resolvePromise) => {
      const finish = (result) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        this.byKey.delete(key);
        this.send({ type: "approval_resolved", id, runId, decision: result.allowed ? "allow" : "deny" });
        resolvePromise({ ...result, category, classification });
      };
      const timer = setTimeout(() => finish({ allowed: false, decidedBy: "timeout", reason: "等待审批超时，已自动拒绝" }), this.timeoutMs);
      this.pending.set(id, { finish, rawResolve: resolvePromise, timer, request, key });

      if (signal) {
        if (signal.aborted) {
          finish({ allowed: false, decidedBy: "aborted", reason: "任务已停止，操作未执行" });
          return;
        }
        signal.addEventListener("abort", () => finish({ allowed: false, decidedBy: "aborted", reason: "任务已停止，操作未执行" }), { once: true });
      }

      this.send({ type: "approval_request", request });
    });

    this.byKey.set(key, promise);
    return promise;
  }

  resolve(id, decision, scope = "once") {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const { request } = entry;
    const allow = decision === "allow";

    if (allow) {
      if (scope === "run") this.allowedRun.add(`${request.runId}|${request.category}`);
      if (scope === "session" && request.sessionId) this.allowedSession.add(`${request.sessionId}|${request.category}`);
    } else if (request.ruleId) {
      this.deniedRun.add(`${request.runId}|${request.ruleId}`);
    }

    entry.finish({ allowed: allow, decidedBy: "user", reason: allow ? "" : "用户拒绝了该操作" });
    return true;
  }

  cancelRun(runId) {
    for (const [id, entry] of this.pending) {
      if (entry.request.runId !== runId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.byKey.delete(entry.key);
      this.send({ type: "approval_resolved", id, runId, decision: "deny" });
      entry.rawResolve({ allowed: false, decidedBy: "aborted", reason: "任务已停止，操作未执行" });
    }
  }

  pendingFor(runId) {
    return [...this.pending.values()].filter((e) => !runId || e.request.runId === runId).map((e) => e.request);
  }

  forgetRun(runId) {
    for (const key of [...this.allowedRun]) if (key.startsWith(runId + "|")) this.allowedRun.delete(key);
    for (const key of [...this.deniedRun]) if (key.startsWith(runId + "|")) this.deniedRun.delete(key);
  }

  forgetSession(sessionId) {
    for (const key of [...this.allowedSession]) if (key.startsWith(sessionId + "|")) this.allowedSession.delete(key);
  }
}

function sanitizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === "string" && v.length > 4000) out[k] = clip(v, 4000);
    else out[k] = v;
  }
  return out;
}
