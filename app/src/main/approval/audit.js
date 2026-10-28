"use strict";

/**
 * 审批审计：每次「有风险的工具调用」都记一条，追加写 JSONL。
 *
 * 记录内容刻意不含完整文件内容，只保留可判定的信息：
 * 时间、Bot、工具、类别、决定、来源、参数摘要。
 */

const fs = require("node:fs");
const path = require("node:path");
const { normalize, clip } = require("./policy");

const MAX_READ = 300;

function summarize(tool, args = {}) {
  if (tool === "run_command") return clip(args.command, 400);
  if (tool === "write_file") return String(args.path ?? "");
  if (tool === "delegate_to_bot" || tool === "message_bot") return String(args.botName ?? "");
  if (tool === "start_group_chat") {
    return Array.isArray(args.members) ? args.members.join("、") : String(args.topic ?? "");
  }
  try {
    return clip(JSON.stringify(args), 400);
  } catch {
    return "";
  }
}

class AuditLog {
  constructor(dataDir) {
    this.file = path.join(dataDir, "approvals.jsonl");
    this.memory = [];
    this.#loadTail();
  }

  #loadTail() {
    try {
      const text = fs.readFileSync(this.file, "utf8");
      this.memory = text
        .split("\n")
        .filter(Boolean)
        .slice(-MAX_READ)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      this.memory = [];
    }
  }

  /** @returns {object} 写入的条目 */
  record(entry) {
    const item = {
      at: Date.now(),
      botId: entry.botId || null,
      botName: entry.botName || "",
      runId: entry.runId || null,
      sessionId: entry.sessionId || null,
      tool: entry.tool,
      category: entry.category,
      severity: entry.severity || "",
      decision: entry.decision, // allowed | denied
      decidedBy: entry.decidedBy || "policy", // policy | user | cached-deny | timeout | unattended | aborted
      summary: summarize(entry.tool, entry.args || {}),
      reason: entry.reason || "",
      unattended: Boolean(entry.unattended),
    };
    this.memory.push(item);
    if (this.memory.length > MAX_READ) this.memory = this.memory.slice(-MAX_READ);

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(item) + "\n", "utf8");
    } catch (error) {
      console.error("[audit] 写入失败", error.message);
    }
    return item;
  }

  /** 最近的记录，新的在前 */
  recent(limit = 100) {
    const n = Math.max(1, Math.min(Number(limit) || 100, MAX_READ));
    return this.memory.slice(-n).reverse();
  }

  stats() {
    const total = this.memory.length;
    const denied = this.memory.filter((m) => m.decision === "denied").length;
    return { total, denied, allowed: total - denied };
  }

  clear() {
    this.memory = [];
    try {
      fs.rmSync(this.file, { force: true });
    } catch (error) {
      console.error("[audit] 清理失败", error.message);
    }
  }
}

module.exports = { AuditLog, summarize, normalize };
