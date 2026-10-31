// 运行编排器：把 Store / ModelClient / 各 Store / Computer / 审批 连起来，
// 复刻桌面版 main.js 里 agent:run 的行为（不含 Electron 进程概念）。

import { Store } from "../store/store";
import { SkillStore } from "../store/skill-store";
import { MemoryStore } from "../store/memory-store";
import { CollabBus } from "../store/collab-bus";
import { ModelClient } from "./model-client";
import { McpManager } from "./mcp";
import { getComputer, disposeAll } from "./factory";
import { ApprovalManager } from "./approval-manager";
import { runAgent } from "./loop";
import { BUILTIN_TOOLS } from "./registry";
import { buildAgentContext } from "./context";

export class Orchestrator {
  constructor() {
    this.store = new Store();
    this.client = new ModelClient(() => this.store.getApp());
    this.skillStore = new SkillStore();
    this.memoryStore = new MemoryStore();
    this.mcpManager = new McpManager();
    this.collab = new CollabBus({ getBots: () => this.store.listBots() });
    this.approvals = new ApprovalManager({
      getGlobalMode: () => this.store.getApp().approval?.mode || "balanced",
      send: (ev) => this.listeners.approval?.(ev),
    });
    this.listeners = { agent: null, approval: null, routine: null };
    this.running = new Map(); // runId -> AbortController
  }

  async init() {
    await Promise.all([
      this.store.ready,
      this.skillStore.ready,
      this.memoryStore.ready ?? Promise.resolve(),
      this.mcpManager.ready,
      this.collab.ready,
    ]);
    this.mcpManager.connectAll().catch(() => {});
  }

  onEvent(handlers) {
    this.listeners = { ...this.listeners, ...handlers };
  }

  #emitAgent(runId, ev) {
    this.listeners.agent?.({ runId, ...ev });
  }

  #makeApprover({ runId, sessionId, bot, requestedBy = "", unattended = false, autoApprove = false, signal }) {
    return async (tool, args) => {
      const verdict = await this.approvals.ask({
        runId, sessionId, botId: bot?.id, botName: bot?.name, requestedBy,
        tool, args, mode: bot?.approvalMode, unattended, autoApprove, signal,
      });
      return verdict;
    };
  }

  #sendBotMessage(fromBot, botName, message) {
    const target = this.collab.findBot(botName);
    if (!target) return `错误：团队里没有名为「${botName}」的 Bot`;
    if (target.id === fromBot.id) return "错误：不能给自己留言";
    this.collab.deliver(target.id, { from: fromBot.name, fromId: fromBot.id, text: message });
    return `已给「${target.name}」留言，它下次对话时会看到。`;
  }

  async #delegateTo(fromBot, botName, task, signal, runId, opts = {}) {
    const target = this.collab.findBot(botName);
    if (!target) return `错误：团队里没有名为「${botName}」的 Bot`;
    if (target.id === fromBot.id) return "错误：不能把任务委派给自己";
    const sub = await runAgent({
      client: this.client,
      history: [{ role: "user", content: task }],
      computer: getComputer(this.store.getApp(), { botId: target.id, workspace: target.workspace }),
      signal,
      approve: this.#makeApprover({
        runId, sessionId: opts.sessionId, bot: target,
        requestedBy: `${fromBot.name} 的委派`,
        unattended: Boolean(opts.unattended), autoApprove: Boolean(opts.autoApprove), signal,
      }),
      ...buildAgentContext(this.#deps(), target, { text: task }),
      emit: () => {},
    });
    return sub.text || sub.error || "（对方没有返回内容）";
  }

  async #runGroupChat(fromBot, topic, members, signal, runId, opts = {}) {
    const names = Array.isArray(members) ? members.slice(0, 5) : [];
    if (!names.length) return "错误：需要至少一个参与 Bot";
    const roomId = "room-" + Date.now().toString(36);
    const lines = [];
    await this.collab.appendRoom(roomId, { from: fromBot.name, text: `【话题】${topic}` });
    for (const name of names) {
      const target = this.collab.findBot(name);
      if (!target) {
        lines.push(`${name}：未找到该 Bot`);
        continue;
      }
      const sub = await runAgent({
        client: this.client,
        history: [{ role: "user", content: `你是「${target.name}」。请就以下话题，从你的职责角度给出简洁意见（3-5 句，不要客套）：\n\n${topic}` }],
        computer: getComputer(this.store.getApp(), { botId: target.id, workspace: target.workspace }),
        signal,
        approve: this.#makeApprover({
          runId, sessionId: opts.sessionId, bot: target,
          requestedBy: `${fromBot.name} 发起的群聊`,
          unattended: Boolean(opts.unattended), autoApprove: Boolean(opts.autoApprove), signal,
        }),
        ...buildAgentContext(this.#deps(), target, { text: topic }),
        emit: () => {},
      });
      const reply = (sub.text || sub.error || "（无回应）").trim();
      await this.collab.appendRoom(roomId, { from: target.name, text: reply });
      lines.push(`${target.name}：${reply}`);
    }
    return `群聊记录（房间 ${roomId}）：\n\n${lines.join("\n\n")}`;
  }

  #deps() {
    return { store: this.store, skillStore: this.skillStore, mcpManager: this.mcpManager, memoryStore: this.memoryStore };
  }

  /**
   * 运行一轮对话。
   * @returns {Promise<{ok:boolean, message?:string, text?:string, aborted?:boolean, maxStepsReached?:boolean, session:{id,title}}>}
   */
  async run({ runId, botId, sessionId, text }) {
    const bot = this.store.getBot(botId);
    if (!bot) return { ok: false, message: "Bot 不存在" };
    const session = await this.store.getSession(botId, sessionId);
    if (!session) return { ok: false, message: "会话不存在" };

    const controller = new AbortController();
    this.running.set(runId, controller);

    session.messages = session.messages.filter((m) => !(m && m.streaming));
    session.messages.push({ role: "user", content: text, at: Date.now() });
    if (session.messages.length === 1) {
      session.title = String(text).replace(/\s+/g, " ").slice(0, 40) || "新对话";
    }
    await this.store.saveSession(session);

    const history = session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const inbox = await this.collab.takeInbox(bot.id);
    const inboxSection = inbox.length
      ? "\n\n## 来自团队的留言\n" + inbox.map((m) => `- ${m.from}：${m.text}`).join("\n")
      : "";

    let finalText = "";
    let liveSnap = { role: "assistant", content: "", at: Date.now(), streaming: true };
    let liveSaveAt = 0;
    const persistLive = async (force) => {
      const now = Date.now();
      if (!force && now - liveSaveAt < 1200) return;
      liveSaveAt = now;
      liveSnap.content = finalText;
      const base = session.messages.filter((m) => m !== liveSnap);
      session.messages = [...base, liveSnap];
      try {
        await this.store.saveSession(session);
      } catch {
        /* ignore */
      }
    };

    try {
      const result = await runAgent({
        client: this.client,
        history,
        computer: getComputer(this.store.getApp(), { botId: bot.id, workspace: bot.workspace }),
        signal: controller.signal,
        approve: this.#makeApprover({ runId, sessionId: session.id, bot, signal: controller.signal }),
        ...buildAgentContext(this.#deps(), bot, { appendToPrompt: inboxSection, text }),
        messageBot: (botName, message) => this.#sendBotMessage(bot, botName, message),
        groupChat: (topic, members) => this.#runGroupChat(bot, topic, members, controller.signal, runId, { sessionId: session.id }),
        delegate: (botName, task) => this.#delegateTo(bot, botName, task, controller.signal, runId, { sessionId: session.id }),
        emit: async (ev) => {
          if (ev.type === "text") {
            finalText += ev.delta;
            persistLive(false);
          }
          this.#emitAgent(runId, ev);
          if (ev.type === "tool_call") {
            session.messages.push({ type: "tool_call", callId: ev.callId, name: ev.name, arguments: ev.arguments, at: Date.now() });
            persistLive(true);
          } else if (ev.type === "tool_result") {
            session.messages.push({ type: "tool_result", callId: ev.callId, name: ev.name, output: ev.output, at: Date.now() });
            persistLive(true);
          }
        },
      });

      session.messages = session.messages.filter((m) => m !== liveSnap);
      if (result.maxStepsReached) {
        finalText =
          (finalText ? finalText.trimEnd() + "\n\n" : "") +
          `> ⚠️ 未完成：已用完 ${result.steps} 步（含 ${result.continuations || 0} 次自动续跑）仍未结束。任务可能卡在最后一步，请回复「继续」或指出卡点。`;
      }
      if (finalText) session.messages.push({ role: "assistant", content: finalText, at: Date.now() });
      else if (result.aborted) session.messages.push({ role: "assistant", content: "（已停止）", at: Date.now() });
      session.messages = session.messages.filter((m) => m.role || m.type);
      await this.store.saveSession(session);

      return {
        ok: !result.error && !result.maxStepsReached,
        message: result.error || (result.maxStepsReached ? "已达步数上限，任务未完成" : ""),
        text: finalText,
        aborted: Boolean(result.aborted),
        maxStepsReached: Boolean(result.maxStepsReached),
        session: { id: session.id, title: session.title },
      };
    } catch (error) {
      try {
        session.messages = session.messages.filter((m) => m !== liveSnap);
        await this.store.saveSession(session);
      } catch {
        /* ignore */
      }
      return { ok: false, message: error.message };
    } finally {
      this.running.delete(runId);
      this.approvals.forgetRun(runId);
    }
  }

  stop(runId) {
    const c = this.running.get(runId);
    if (!c) return false;
    c.abort();
    this.approvals.cancelRun(runId);
    return true;
  }

  isRunning(runId) {
    return this.running.has(runId);
  }

  dispose() {
    for (const c of this.running.values()) c.abort();
    this.running.clear();
    disposeAll();
  }
}
