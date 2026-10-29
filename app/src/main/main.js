"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, clipboard, screen, Tray, Notification } = require("electron");
const { Store } = require("./store/store");
const { ModelClient } = require("./agent/model-client");
const { runAgent } = require("./agent/loop");
const { BUILTIN_TOOLS } = require("./tools/registry");
const { getComputer, disposeAll, setUserDataDir } = require("./computer/factory");
const { SkillStore } = require("./skills/skill-store");
const { McpManager } = require("./mcp/mcp-manager");
const { CollabBus } = require("./collab/collab-bus");
const { buildAgentContext } = require("./agent/context");
const { RoutineStore, describeSchedule } = require("./routines/routine-store");
const { MemoryStore } = require("./memory/memory-store");
const { RoutineScheduler } = require("./routines/scheduler");
const { ApprovalManager } = require("./approval/approval-manager");
const { AuditLog } = require("./approval/audit");

const isDev = !app.isPackaged;
app.setAppUserModelId("com.grokbot.agent");

let mainWindow = null;
let store = null;
let client = null;
let skillStore = null;
let mcpManager = null;
let collab = null;
let memoryStore = null;
let routineStore = null;
let scheduler = null;
let approvals = null;
let audit = null;
let tray = null;
// 关窗口 = 收进托盘（后台继续跑例程），只有显式「退出」才真正结束进程
let isQuitting = false;
const running = new Map(); // runId -> AbortController

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 820;

/**
 * 把恢复的窗口尺寸/位置钳制到「一块显示的可用工作区」内。
 *
 * 以前的实现只判断「窗口还露出 80px 就算可见」，所以只要上次保存的窗口比当前屏幕高
 * （换过显示器、改过缩放、或上次是在更大的屏幕上最大化后关闭的），窗口底部就会伸到
 * 屏幕外 —— 而输入框正好贴在窗口最底部，于是「输入框不见了、内容被从中间截断」。
 *
 * 现在的规则：
 *   1) 先确定目标屏幕（有坐标就取包含该点的屏，否则取重叠面积最大的屏，再否则主屏）；
 *   2) 宽高不超过该屏工作区，且不低于最小尺寸（屏幕本身更小时以屏幕为准）；
 *   3) 位置整体夹回工作区内，保证整扇窗（含底部输入框）永远可见。
 */
function clampToDisplays({ width, height, x, y }) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const hasPos = Number.isInteger(x) && Number.isInteger(y);

  let target = null;
  if (hasPos) {
    target =
      displays.find(
        (d) =>
          x >= d.workArea.x &&
          x < d.workArea.x + d.workArea.width &&
          y >= d.workArea.y &&
          y < d.workArea.y + d.workArea.height,
      ) || null;
    if (!target) {
      // 不在任何屏内：挑重叠面积最大的一块，避免把窗口拉回主屏时丢掉用户原本的意图
      let best = -1;
      for (const d of displays) {
        const a = d.workArea;
        const ox = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
        const oy = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
        const area = Math.max(0, ox) * Math.max(0, oy);
        if (area > best) {
          best = area;
          target = d;
        }
      }
    }
  }
  if (!target) target = primary;

  const a = target.workArea;
  const wantW = Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_WIDTH;
  const wantH = Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_HEIGHT;
  const w = Math.max(Math.min(MIN_WIDTH, a.width), Math.min(wantW, a.width));
  const h = Math.max(Math.min(MIN_HEIGHT, a.height), Math.min(wantH, a.height));

  let nx = hasPos ? x : a.x + Math.round((a.width - w) / 2);
  let ny = hasPos ? y : a.y + Math.round((a.height - h) / 2);
  nx = Math.min(Math.max(nx, a.x), a.x + a.width - w);
  ny = Math.min(Math.max(ny, a.y), a.y + a.height - h);

  return { width: w, height: h, x: nx, y: ny };
}

function createWindow() {
  const w = store.getApp().window || {};
  const bounds = clampToDisplays({
    width: w.width || 1180, height: w.height || 820,
    x: Number.isInteger(w.x) ? w.x : undefined,
    y: Number.isInteger(w.y) ? w.y : undefined,
  });
  const theme = store.getApp().ui?.theme || "dark";
  nativeTheme.themeSource = theme === "light" ? "light" : "dark";

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT,
    show: false,
    title: "Grok Bot",
    backgroundColor: theme === "light" ? "#f7f7f9" : "#0b0b0d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    // 上次是最大化关的：恢复最大化。用 normalBounds 恢复尺寸，避免把「大屏最大化后的尺寸」
    // 当成普通窗口尺寸带到小屏上（那样底部输入框会被顶出屏幕）。
    if (w.maximized) mainWindow.maximize();
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("close", (e) => {
    if (!mainWindow) return;
    const maximized = mainWindow.isMaximized();
    // 最大化时 getSize() 返回的是屏幕尺寸；必须用 getNormalBounds() 才能拿到「还原后」的尺寸
    const b = mainWindow.getNormalBounds();
    store.updateApp({ window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized } });
    // 点窗口右上角 X 不退出：收进托盘，让定时例程继续在后台跑。
    // 真正退出走托盘菜单「退出」或菜单栏，那里会置 isQuitting=true。
    // 没有托盘图标时不能拦——否则窗口藏了却再也叫不出来，只能杀进程。
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
      notifyHiddenToTray();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

/** 从托盘 / 二次启动把窗口调出来 */
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 第一次收进托盘时提示一次，避免用户以为「应用没了」 */
let trayHintShown = false;
function notifyHiddenToTray() {
  if (trayHintShown) return;
  trayHintShown = true;
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: "Grok Bot 仍在后台运行",
        body: "窗口已收进系统托盘，定时例程会继续执行。右键托盘图标可退出。",
        silent: true,
      }).show();
    }
  } catch { /* 通知失败不影响主流程 */ }
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(__dirname, "..", "..", "assets", "tray.png"));
  } catch {
    return; // 没有图标就不做托盘，退出逻辑回落到正常关闭
  }
  const menu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "退出 Grok Bot",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Grok Bot");
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
}

/* ---------------- 协作（供交互 / 例程共用） ---------------- */

/**
 * 生成一个「审批函数」交给工具执行器。
 *
 * 决定与审计都在这里收口，保证任何入口（对话 / 委派 / 群聊 / 例程）
 * 都走同一套边界，不会因为新入口忘接而漏掉。
 */
function makeApprover({ runId, sessionId, bot, requestedBy = "", unattended = false, autoApprove = false, signal }) {
  return async (tool, args) => {
    const verdict = await approvals.ask({
      runId,
      sessionId,
      botId: bot?.id,
      botName: bot?.name,
      requestedBy,
      tool,
      args,
      mode: bot?.approvalMode,
      unattended,
      autoApprove,
      signal,
    });

    // 只读操作不写审计，避免日志被噪音淹没
    if (verdict.classification?.category !== "safe") {
      audit.record({
        botId: bot?.id,
        botName: bot?.name,
        runId,
        sessionId,
        tool,
        args,
        category: verdict.category,
        severity: verdict.classification?.severity,
        decision: verdict.allowed ? "allowed" : "denied",
        decidedBy: verdict.decidedBy || (verdict.allowed ? "policy" : "policy"),
        reason: verdict.reason || "",
        unattended,
      });
    }
    return verdict;
  };
}

/** 给另一个 Bot 异步留言 */
function sendBotMessage(fromBot, botName, message, runId, sender) {
  const target = collab.findBot(botName);
  if (!target) return `错误：团队里没有名为「${botName}」的 Bot`;
  if (target.id === fromBot.id) return "错误：不能给自己留言";
  collab.deliver(target.id, { from: fromBot.name, fromId: fromBot.id, text: message });
  if (sender && !sender.isDestroyed()) {
    sender.send("agent:event", { runId, type: "message_sent", botName: target.name });
  }
  return `已给「${target.name}」留言，它下次对话时会看到。`;
}

/** 把子任务委派给另一个 Bot，等它做完 */
async function delegateTo(fromBot, botName, task, signal, runId, sender, opts = {}) {
  const target = collab.findBot(botName);
  if (!target) return `错误：团队里没有名为「${botName}」的 Bot`;
  if (target.id === fromBot.id) return "错误：不能把任务委派给自己";
  if (sender && !sender.isDestroyed()) {
    sender.send("agent:event", { runId, type: "delegate", botName: target.name });
  }
  const sub = await runAgent({
    client,
    history: [{ role: "user", content: task }],
    computer: getComputer(store.getApp(), { botId: target.id, workspace: target.workspace }),
    signal,
    approve: makeApprover({
      runId,
      sessionId: opts.sessionId,
      bot: target,
      // 界面要能看出这是「谁替谁干活」，否则弹窗只显示子 Bot 名字会让人困惑
      requestedBy: `${fromBot.name} 的委派`,
      unattended: Boolean(opts.unattended),
      autoApprove: Boolean(opts.autoApprove),
      signal,
    }),
    ...buildAgentContext({ store, skillStore, mcpManager, memoryStore }, target, { text: task }),
    emit: () => {},
  });
  return sub.text || sub.error || "（对方没有返回内容）";
}

/** 多 Bot 群聊：依次让成员就同一话题发言 */
async function runGroupChat(fromBot, topic, members, signal, runId, sender, opts = {}) {
  const names = Array.isArray(members) ? members.slice(0, 5) : [];
  if (!names.length) return "错误：需要至少一个参与 Bot";
  const roomId = "room-" + Date.now().toString(36);
  const lines = [];
  collab.appendRoom(roomId, { from: fromBot.name, text: `【话题】${topic}` });
  if (sender && !sender.isDestroyed()) {
    sender.send("agent:event", { runId, type: "group_chat", topic, roomId });
  }

  for (const name of names) {
    const target = collab.findBot(name);
    if (!target) {
      lines.push(`${name}：未找到该 Bot`);
      continue;
    }
    const sub = await runAgent({
      client,
      history: [{
        role: "user",
        content: `你是「${target.name}」。请就以下话题，从你的职责角度给出简洁意见（3-5 句，不要客套）：\n\n${topic}`,
      }],
      computer: getComputer(store.getApp(), { botId: target.id, workspace: target.workspace }),
      signal,
      approve: makeApprover({
        runId,
        sessionId: opts.sessionId,
        bot: target,
        requestedBy: `${fromBot.name} 发起的群聊`,
        unattended: Boolean(opts.unattended),
        autoApprove: Boolean(opts.autoApprove),
        signal,
      }),
      ...buildAgentContext({ store, skillStore, mcpManager, memoryStore }, target, { text: topic }),
      emit: () => {},
    });
    const reply = (sub.text || sub.error || "（无回应）").trim();
    collab.appendRoom(roomId, { from: target.name, text: reply });
    lines.push(`${target.name}：${reply}`);
    if (sender && !sender.isDestroyed()) {
      sender.send("agent:event", { runId, type: "group_reply", botName: target.name, text: reply.slice(0, 400) });
    }
  }
  return `群聊记录（房间 ${roomId}）：\n\n${lines.join("\n\n")}`;
}

/**
 * 跑一条例程（定时任务用，无界面事件）。
 * @param {object} routine
 * @param {AbortSignal} [signal] 由调度器传入，手动停止时中止整轮
 */
async function executeRoutine(routine, signal) {
  const bot = store.getBot(routine.botId);
  if (!bot) throw new Error("例程绑定的 Bot 不存在");
  const inbox = collab.takeInbox(bot.id);
  const inboxSection = inbox.length
    ? "\n\n## 来自团队的留言\n" + inbox.map((m) => `- ${m.from}：${m.text}`).join("\n")
    : "";

  // 例程是无人值守的：审批默认拒绝，只有例程显式允许时才放行
  const runId = "routine-" + routine.id + "-" + Date.now().toString(36);
  // 结果上报容器：模型调用 report_result 时写入，调度器据此判定成功/失败
  const report = { status: null, summary: "", details: "", reportedAt: null };
  return await runAgent({
    client,
    history: [{ role: "user", content: routine.prompt }],
    computer: getComputer(store.getApp(), { botId: bot.id, workspace: bot.workspace }),
    signal,
    report,
    approve: makeApprover({
      runId,
      sessionId: null,
      bot,
      unattended: !routine.allowRisky,
      autoApprove: Boolean(routine.allowRisky),
      signal,
    }),
    ...buildAgentContext({ store, skillStore, mcpManager, memoryStore }, bot, { appendToPrompt: inboxSection, text: routine.prompt }),
    messageBot: (botName, message) => sendBotMessage(bot, botName, message, runId, null),
    groupChat: (topic, names) =>
      runGroupChat(bot, topic, names, signal, runId, null, {
        unattended: !routine.allowRisky,
        autoApprove: Boolean(routine.allowRisky),
      }),
    delegate: (botName, task) =>
      delegateTo(bot, botName, task, signal, runId, null, {
        unattended: !routine.allowRisky,
        autoApprove: Boolean(routine.allowRisky),
      }),
    emit: () => {},
  });
}

function registerIpc() {
  // ---- 应用 ----
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath("userData"),
  }));

  ipcMain.handle("settings:get", () => store.getApp());
  ipcMain.handle("settings:update", (_e, patch) => {
    const next = store.updateApp(patch);
    if (patch?.ui?.theme) {
      nativeTheme.themeSource = patch.ui.theme === "light" ? "light" : "dark";
      mainWindow?.webContents.send("theme:changed", patch.ui.theme);
    }
    return next;
  });
  ipcMain.handle("settings:reveal", () => { shell.showItemInFolder(path.join(app.getPath("userData"), "app.json")); return true; });

  // ---- 模型 ----
  // 可选 override { baseUrl, apiKey }：设置面板里刚填、还没保存的值，
  // 传了就按它连，不传则回落到已保存配置。
  const connOverride = (o) =>
    o && typeof o === "object"
      ? { baseUrl: String(o.baseUrl || ""), apiKey: String(o.apiKey || "") }
      : undefined;
  ipcMain.handle("model:list", async (_e, override) => {
    try { return { ok: true, models: await client.listModels(connOverride(override)) }; }
    catch (e) { return { ok: false, message: e.message, code: e.code || "" }; }
  });
  ipcMain.handle("model:test", async (_e, override) => {
    try {
      const models = await client.listModels(connOverride(override));
      return { ok: true, models };
    } catch (e) {
      return { ok: false, message: e.message, code: e.code || "" };
    }
  });

  // ---- Bot ----
  ipcMain.handle("bots:list", () => store.listBots());
  ipcMain.handle("bots:create", (_e, input) => store.createBot(input || {}));
  ipcMain.handle("bots:get", (_e, id) => store.getBot(id));
  ipcMain.handle("bots:update", (_e, id, patch) => store.updateBot(id, patch));
  ipcMain.handle("bots:pin", (_e, id, pinned) => store.setBotPinned(id, pinned));
  ipcMain.handle("bots:delete", (_e, id) => store.deleteBot(id));
  ipcMain.handle("bots:openWorkspace", (_e, id) => {
    const bot = store.getBot(id);
    if (!bot) return false;
    shell.openPath(bot.workspace);
    return true;
  });
  ipcMain.handle("bots:pickWorkspace", async (_e, id) => {
    const bot = store.getBot(id);
    if (!bot) return null;
    const { dialog } = require("electron");
    const r = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return store.updateBot(id, { workspace: r.filePaths[0] });
  });

  // ---- 会话 ----
  ipcMain.handle("sessions:list", (_e, botId) => store.listSessions(botId));
  ipcMain.handle("sessions:create", (_e, botId, title) => store.createSession(botId, title));
  ipcMain.handle("sessions:get", (_e, botId, id) => store.getSession(botId, id));
  ipcMain.handle("sessions:delete", (_e, botId, id) => store.deleteSession(botId, id));
  ipcMain.handle("sessions:rename", (_e, botId, id, title) => {
    const s = store.getSession(botId, id);
    if (!s) return null;
    s.title = String(title || "新对话").slice(0, 80);
    return store.saveSession(s);
  });

  // ---- Agent 运行 ----
  ipcMain.handle("agent:run", async (event, payload) => {
    const { runId, botId, sessionId, text } = payload || {};
    const bot = store.getBot(botId);
    if (!bot) return { ok: false, message: "Bot 不存在" };

    const session = store.getSession(botId, sessionId);
    if (!session) return { ok: false, message: "会话不存在" };

    const controller = new AbortController();
    running.set(runId, controller);

    // 上次异常退出可能留下「流式中」的半截快照，开跑前先清掉，免得污染历史
    session.messages = session.messages.filter((m) => !(m && m.streaming));
    session.messages.push({ role: "user", content: text, at: Date.now() });
    if (session.messages.length === 1) {
      session.title = String(text).replace(/\\s+/g, " ").slice(0, 40) || "新对话";
    }
    store.saveSession(session);

    const history = session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const inbox = collab.takeInbox(bot.id);
    const inboxSection = inbox.length
      ? "\n\n## 来自团队的留言\n" + inbox.map((m) => `- ${m.from}：${m.text}`).join("\n")
      : "";

    let finalText = "";
    // 把「正在生成的回复」也落盘：切到别的对话、甚至刷新窗口，
    // 回来都能看到已经产出的内容，而不是一片空白。
    let liveSnap = { role: "assistant", content: "", at: Date.now(), streaming: true };
    let liveSaveAt = 0;
    const persistLive = (force) => {
      const now = Date.now();
      if (!force && now - liveSaveAt < 1200) return; // 限流，避免频繁写盘
      liveSaveAt = now;
      liveSnap.content = finalText;
      const base = session.messages.filter((m) => m !== liveSnap);
      session.messages = [...base, liveSnap];
      try { store.saveSession(session); } catch { /* 写盘失败不影响运行 */ }
    };
    try {
      const result = await runAgent({
        client,
        history,
        computer: getComputer(store.getApp(), { botId: bot.id, workspace: bot.workspace }),
        signal: controller.signal,
        approve: makeApprover({
          runId,
          sessionId: session.id,
          bot,
          signal: controller.signal,
        }),
        ...buildAgentContext({ store, skillStore, mcpManager, memoryStore }, bot, { appendToPrompt: inboxSection, text }),
        messageBot: (botName, message) => sendBotMessage(bot, botName, message, runId, event.sender),
        groupChat: (topic, members) =>
          runGroupChat(bot, topic, members, controller.signal, runId, event.sender, { sessionId: session.id }),
        delegate: (botName, task) =>
          delegateTo(bot, botName, task, controller.signal, runId, event.sender, { sessionId: session.id }),
        emit: (ev) => {
          if (ev.type === "text") { finalText += ev.delta; persistLive(false); }
          if (!event.sender.isDestroyed()) event.sender.send("agent:event", { runId, ...ev });
          if (ev.type === "tool_call") {
            session.messages.push({ type: "tool_call", callId: ev.callId, name: ev.name, arguments: ev.arguments, at: Date.now() });
            persistLive(true);
          } else if (ev.type === "tool_result") {
            session.messages.push({ type: "tool_result", callId: ev.callId, name: ev.name, output: ev.output, at: Date.now() });
            persistLive(true);
          }
        },
      });

      // 收尾：去掉临时快照，写入真正的最终回复
      session.messages = session.messages.filter((m) => m !== liveSnap);
      if (finalText) session.messages.push({ role: "assistant", content: finalText, at: Date.now() });
      // 被停止又还没来得及产出内容：写一条明确的「已停止」，别让界面只剩用户那句
      else if (result.aborted) session.messages.push({ role: "assistant", content: "（已停止）", at: Date.now() });
      session.messages = session.messages.filter((m) => m.role || m.type);
      store.saveSession(session);

      return {
        ok: !result.error,
        message: result.error,
        text: finalText,
        steps: result.steps,
        aborted: Boolean(result.aborted),
        session: { id: session.id, title: session.title },
      };
    } catch (error) {
      // 异常：别把「还在流式」的快照留在磁盘上
      try {
        session.messages = session.messages.filter((m) => m !== liveSnap);
        store.saveSession(session);
      } catch { /* ignore */ }
      return { ok: false, message: error.message };
    } finally {
      running.delete(runId);
      // 清掉这次运行的「本次运行都允许 / 已拒绝」记忆，避免常驻进程越攒越多
      approvals.forgetRun(runId);
    }
  });

  ipcMain.handle("agent:stop", (_e, runId) => {
    const c = running.get(runId);
    if (!c) return false;
    c.abort();
    approvals.cancelRun(runId);
    return true;
  });

  ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(String(text ?? "")); return true; });
  ipcMain.handle("tools:list", () => BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description })));

  // ---- 审批 ----
  ipcMain.handle("approval:resolve", (_e, id, decision, scope) => {
    return approvals.resolve(id, decision, scope || "once");
  });
  ipcMain.handle("approval:pending", (_e, runId) => approvals.pendingFor(runId));
  ipcMain.handle("approval:audit", (_e, limit) => ({
    items: audit.recent(limit || 100),
    stats: audit.stats(),
  }));
  ipcMain.handle("approval:clearAudit", () => { audit.clear(); return true; });
  ipcMain.handle("approval:policy", () => {
    return {
      mode: store.getApp().approval?.mode || "balanced",
      timeoutMs: approvals.timeoutMs,
    };
  });

  // ---- 计算机（本机 / 云端） ----
  // ---- 技能 ----
  // ---- MCP ----
  // ---- 例程（定时任务） ----
  // ---- 记忆 ----
  ipcMain.handle("memory:list", (_e, botId) => memoryStore.listAll(botId));
  ipcMain.handle("memory:search", (_e, botId, query, opts) => memoryStore.search(botId, query, opts || {}));
  ipcMain.handle("memory:add", (_e, botId, input) => {
    try {
      return { ok: true, item: memoryStore.write({ ...input, botId, source: "user" }) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle("memory:remove", (_e, botId, scope, id) => {
    const ok = memoryStore.remove(scope, scope === "user" ? null : botId, id);
    return ok;
  });
  ipcMain.handle("memory:clear", (_e, botId, scope) => {
    memoryStore.clear(scope, scope === "user" ? null : botId);
    return true;
  });

  ipcMain.handle("routines:list", (_e, botId) => {
    return routineStore.list(botId).map((r) => ({
      ...r,
      scheduleText: describeSchedule(r.schedule),
    }));
  });
  ipcMain.handle("routines:create", (_e, input) => {
    try {
      const r = routineStore.create(input);
      return { ok: true, routine: { ...r, scheduleText: describeSchedule(r.schedule) } };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle("routines:update", (_e, id, patch) => {
    const r = routineStore.update(id, patch);
    if (!r) return { ok: false, message: "例程不存在" };
    return { ok: true, routine: { ...r, scheduleText: describeSchedule(r.schedule) } };
  });
  ipcMain.handle("routines:remove", (_e, id) => routineStore.remove(id));
  // 立即运行 = 后台启动后立刻返回（不阻塞界面），完成后走 routine:event 通知
  ipcMain.handle("routines:runNow", (_e, id) => {
    try {
      const r = scheduler.runNow(id);
      if (r.alreadyRunning) return { ok: true, alreadyRunning: true };
      return { ok: true, started: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle("routines:stop", (_e, id) => ({ ok: scheduler.stopRoutine(id) }));
  ipcMain.handle("routines:running", () => scheduler.runningInfo());

  ipcMain.handle("mcp:list", () => mcpManager.status());
  ipcMain.handle("mcp:config", () => mcpManager.servers);
  ipcMain.handle("mcp:save", async (_e, servers) => {
    mcpManager.save(Array.isArray(servers) ? servers : []);
    await mcpManager.disconnectAll();
    await mcpManager.connectAll();
    return mcpManager.status();
  });
  ipcMain.handle("mcp:connect", async (_e, name) => {
    try {
      await mcpManager.connect(name);
      return { ok: true, status: mcpManager.status() };
    } catch (error) {
      return { ok: false, message: error.message, status: mcpManager.status() };
    }
  });
  ipcMain.handle("mcp:disconnect", async (_e, name) => {
    await mcpManager.disconnect(name);
    return mcpManager.status();
  });

  ipcMain.handle("skills:list", () => skillStore.list());
  ipcMain.handle("skills:get", (_e, id) => skillStore.read(id));
  ipcMain.handle("skills:save", (_e, id, payload) => skillStore.save(id, payload || {}));
  ipcMain.handle("skills:remove", (_e, id) => skillStore.remove(id));
  ipcMain.handle("skills:openDir", (_e, id) => {
    const dir = id ? path.join(app.getPath("userData"), "skills", id) : path.join(app.getPath("userData"), "skills");
    shell.openPath(dir);
    return true;
  });
  ipcMain.handle("skills:importFolder", async () => {
    const { dialog } = require("electron");
    const r = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try {
      const imported = skillStore.importFolder(r.filePaths[0]);
      return { ok: true, imported: imported.map((s) => ({ id: s.id, name: s.name })) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle("skills:importZip", async () => {
    const { dialog } = require("electron");
    const r = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name: "技能包", extensions: ["zip"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try {
      const imported = await skillStore.importZip(r.filePaths[0]);
      return { ok: true, imported: imported.map((s) => ({ id: s.id, name: s.name })) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle("computer:info", async (_e, botId) => {
    const bot = botId ? store.getBot(botId) : store.listBots()[0];
    if (!bot) return { kind: "none" };
    const cfg = store.getApp().computer || { kind: "local" };
    const computer = getComputer(store.getApp(), { botId: bot.id, workspace: bot.workspace });
    return {
      kind: computer.kind,
      id: computer.id,
      capabilities: computer.capabilities(),
      health: await computer.health(),
      screenUrl: computer.screenUrl(),
      browser: typeof computer.browserStatus === "function" ? computer.browserStatus() : null,
      rootDir: computer.kind === "local" ? bot.workspace : (cfg.baseUrl || ""),
      persistent: computer.kind === "remote",
    };
  });

  /** 以后接云端时，界面上「打开 Bot 的电脑」就走这里 */
  ipcMain.handle("computer:screen", async (_e, botId) => {
    const bot = store.getBot(botId);
    if (!bot) return { url: null };
    const computer = getComputer(store.getApp(), { botId: bot.id, workspace: bot.workspace });
    if (typeof computer.refreshScreenUrl === "function") await computer.refreshScreenUrl();
    return { url: computer.screenUrl() };
  });

  /** 本机浏览器：在界面上点一下就把它拉起来（首次便于人工登录一次） */
  ipcMain.handle("computer:browser-open", async (_e, botId) => {
    const bot = botId ? store.getBot(botId) : store.listBots()[0];
    if (!bot) return { ok: false, message: "没有可用的 Bot" };
    const computer = getComputer(store.getApp(), { botId: bot.id, workspace: bot.workspace });
    if (typeof computer.ensureBrowser !== "function") {
      return { ok: false, message: "当前执行环境不支持本机浏览器（请切回本机模式）" };
    }
    try {
      const status = await computer.ensureBrowser();
      return { ok: true, status };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle("computer:browser-status", async (_e, botId) => {
    const bot = botId ? store.getBot(botId) : store.listBots()[0];
    if (!bot) return { running: false };
    const computer = getComputer(store.getApp(), { botId: bot.id, workspace: bot.workspace });
    return typeof computer.browserStatus === "function" ? computer.browserStatus() : { running: false };
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" }, { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
        { type: "separator" }, { role: "togglefullscreen", label: "全屏" },
      ],
    },
  ]));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    setUserDataDir(app.getPath("userData"));
    store = new Store(app.getPath("userData"));
    client = new ModelClient(() => store.getApp());
    skillStore = new SkillStore(app.getPath("userData"));
    mcpManager = new McpManager(app.getPath("userData"));
    mcpManager.load();
    collab = new CollabBus(app.getPath("userData"), { getBots: () => store.listBots() });
    memoryStore = new MemoryStore(app.getPath("userData"));
    routineStore = new RoutineStore(app.getPath("userData"));
    audit = new AuditLog(app.getPath("userData"));
    approvals = new ApprovalManager({
      getGlobalMode: () => store.getApp().approval?.mode || "balanced",
      send: (ev) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("approval:event", ev);
      },
    });
    scheduler = new RoutineScheduler({
      store: routineStore,
      runRoutine: executeRoutine,
      onEvent: (ev) => mainWindow?.webContents.send("routine:event", ev),
    });
    scheduler.start();
    // 后台连接，不阻塞启动
    mcpManager.connectAll().catch(() => {});
    registerIpc();
    buildMenu();
    createWindow();
    createTray();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // 有关窗口关闭的两种情形：
  // - 有托盘：X 只是 hide，不会触发本事件
  // - 没有托盘（图标缺失等）：正常关闭 → 必须退出，否则会留下没有窗口的僵尸进程
  app.on("window-all-closed", () => {
    if (isQuitting || !tray) app.quit();
  });
  app.on("before-quit", () => {
    isQuitting = true;
    for (const c of running.values()) c.abort();
    disposeAll();
    scheduler?.shutdown();
    mcpManager?.disconnectAll?.();
    tray?.destroy?.();
    tray = null;
  });
}

process.on("unhandledRejection", (r) => console.error("[app] unhandledRejection", r));
process.on("uncaughtException", (e) => console.error("[app] uncaughtException", e));
