"use strict";

/**
 * 审批网关：危险操作在执行前停下来，等人点「允许 / 拒绝」。
 *
 * 三种运行场景：
 * - 界面里的对话：弹窗询问
 * - 例程（无人值守）：默认拒绝，除非该例程显式允许风险操作
 * - 子 Bot / 群聊：如果画面里有弹窗就弹，否则按无人值守处理
 *
 * 记住的范围只保存在内存里：
 * - 「本次运行」：同一次 Agent 循环内，同一类操作不再问
 * - 「本会话」：当前对话内，同一类操作不再问（重启即失效）
 * 拒绝也会被记住，避免模型换个写法反复撞墙。
 */

const crypto = require("node:crypto");
const { classifyTool, shouldAsk, clip, LABEL, SEVERITY } = require("./policy");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class ApprovalManager {
  /**
   * @param {object} opts
   * @param {() => string} opts.getGlobalMode 全局策略（strict/balanced/relaxed/off）
   * @param {(event: object) => void} opts.send 把审批请求/撤销推给界面
   */
  constructor({ getGlobalMode, send, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.getGlobalMode = getGlobalMode || (() => "balanced");
    this.send = send || (() => {});
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // id -> { resolve, timer, request }
    this.byKey = new Map(); // 去重：同一次运行里重复的请求
    this.allowedRun = new Set(); // `${runId}|${category}`
    this.allowedSession = new Set(); // `${sessionId}|${category}`
    this.deniedRun = new Set(); // `${runId}|${ruleId}`
  }

  modeFor({ mode, bot }) {
    const m = mode || bot?.approvalMode || "inherit";
    if (m && m !== "inherit") return m;
    return this.getGlobalMode() || "balanced";
  }

  /**
   * 执行前调用。返回 { allowed:boolean, reason:string, category:string }
   *
   * @param {object} input
   * @param {string} input.runId
   * @param {string} [input.sessionId]
   * @param {string} [input.botId]
   * @param {string} [input.botName]
   * @param {string} input.tool
   * @param {object} input.args
   * @param {string} [input.mode] 本次运行的策略（Bot 覆盖）
   * @param {boolean} [input.unattended] 无人值守：不弹窗
   * @param {boolean} [input.autoApprove] 无人值守时是否自动放行（例程显式勾选）
   * @param {AbortSignal} [input.signal]
   */
  async ask(input) {
    const { runId, sessionId, botId, botName, requestedBy, tool, args, mode, unattended, autoApprove, signal } = input;
    const classification = classifyTool(tool, args || {});
    const category = classification.category;

    if (classification.blocked) {
      return {
        allowed: false,
        category,
        blocked: true,
        reason: classification.reason || "该操作被永久拒绝",
        classification,
      };
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

    // 无人值守：不弹窗。勾选了「允许危险操作」的例程直接放行，其余安全拒绝。
    if (unattended && autoApprove) {
      return { allowed: true, category, decidedBy: "routine-allow", classification };
    }
    if (unattended) {
      return {
        allowed: false,
        category,
        decidedBy: "unattended",
        reason: `无人值守运行，已安全拒绝「${classification.label || LABEL[category] || category}」；如确需放行，请在例程设置里勾选「允许危险操作」`,
        classification,
      };
    }

    const key = `${runId}|${ruleId}|${category}`;
    if (this.byKey.has(key)) return this.byKey.get(key);

    const id = "ap-" + crypto.randomBytes(5).toString("hex");
    const request = {
      id,
      runId,
      sessionId: sessionId || null,
      botId: botId || null,
      botName: botName || "",
      requestedBy: requestedBy || "",
      tool,
      args: sanitizeArgs(args),
      category,
      ruleId: classification.ruleId || "",
      label: classification.label || LABEL[category] || category,
      reason: classification.reason || "",
      severity: classification.severity || SEVERITY[category] || "medium",
      detail: clip(classification.detail || "", 3000),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.timeoutMs,
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

      const timer = setTimeout(() => {
        finish({ allowed: false, decidedBy: "timeout", reason: "等待审批超时，已自动拒绝" });
      }, this.timeoutMs);
      if (timer.unref) timer.unref();

      // finish 负责清理 + 兑现；rawResolve 只兑现，供 cancelRun 在删表后使用
      this.pending.set(id, { finish, rawResolve: resolvePromise, timer, request, key });

      if (signal) {
        if (signal.aborted) {
          finish({ allowed: false, decidedBy: "aborted", reason: "任务已停止，操作未执行" });
          return;
        }
        signal.addEventListener(
          "abort",
          () => finish({ allowed: false, decidedBy: "aborted", reason: "任务已停止，操作未执行" }),
          { once: true },
        );
      }

      this.send({ type: "approval_request", request });
    });

    this.byKey.set(key, promise);
    return promise;
  }

  /**
   * 界面上点了按钮。
   * @param {string} id
   * @param {"allow"|"deny"} decision
   * @param {"once"|"run"|"session"} [scope]
   */
  resolve(id, decision, scope = "once") {
    const entry = this.pending.get(id);
    if (!entry) return false;

    const { request } = entry;
    const allow = decision === "allow";

    if (allow) {
      if (scope === "run") this.allowedRun.add(`${request.runId}|${request.category}`);
      if (scope === "session" && request.sessionId) {
        this.allowedSession.add(`${request.sessionId}|${request.category}`);
      }
    } else if (request.ruleId) {
      // 记住这次拒绝，模型用同一写法重试时不再反复弹窗
      this.deniedRun.add(`${request.runId}|${request.ruleId}`);
    }

    entry.finish({
      allowed: allow,
      decidedBy: "user",
      reason: allow ? "" : "用户拒绝了该操作",
    });
    return true;
  }

  /** 停止任务时，把该运行挂着的问题全部按拒绝收尾 */
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
    return [...this.pending.values()]
      .filter((e) => !runId || e.request.runId === runId)
      .map((e) => e.request);
  }

  /** 会话或 Bot 删除时清掉残留的放行记录 */
  forgetSession(sessionId) {
    for (const key of [...this.allowedSession]) {
      if (key.startsWith(sessionId + "|")) this.allowedSession.delete(key);
    }
  }

  /** 一次运行结束后清掉它的临时记录，避免长期运行越攒越多 */
  forgetRun(runId) {
    for (const key of [...this.allowedRun]) {
      if (key.startsWith(runId + "|")) this.allowedRun.delete(key);
    }
    for (const key of [...this.deniedRun]) {
      if (key.startsWith(runId + "|")) this.deniedRun.delete(key);
    }
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

module.exports = { ApprovalManager, DEFAULT_TIMEOUT_MS };
