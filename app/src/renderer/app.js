"use strict";
const $ = (id) => document.getElementById(id);

/* ---------- 工具函数 ---------- */
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const escAttr = (s) => esc(s).replace(/`/g,"&#96;");

function md(src) {
  const lines = String(src ?? "").replace(/\r\n?/g,"\n").split("\n");
  const out = []; const stack = []; let inCode=false, buf=[], para=[], quote=[];
  const flushP = () => { if(para.length){out.push(`<p>${inl(para.join(" "))}</p>`);para=[];} };
  const flushQ = () => { if(quote.length){out.push(`<blockquote>${inl(quote.join(" "))}</blockquote>`);quote=[];} };
  const closeL = () => { while(stack.length){const t=stack.pop();out.push(`</li></${t}>`);} };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) { const c=buf.join("\n"); out.push(`<pre><button class="copy-code" type="button" data-code="${escAttr(c)}">复制</button><code>${esc(c)}</code></pre>`); inCode=false; buf=[]; }
      else { flushP(); flushQ(); closeL(); inCode=true; }
      continue;
    }
    if (inCode) { buf.push(line); continue; }
    if (!line.trim()) { flushP(); flushQ(); closeL(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushP(); flushQ(); closeL(); const lv=Math.min(h[1].length,4); out.push(`<h${lv}>${inl(h[2])}</h${lv}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushP(); flushQ(); closeL(); out.push("<hr />"); continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { flushP(); quote.push(q[1]); continue; }
    flushQ();
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushP();
      const indent = Math.floor(li[1].replace(/\t/g,"  ").length/2);
      const tag = /\d/.test(li[2]) ? "ol" : "ul";
      const depth = indent + 1;
      while (stack.length > depth) { const c=stack.pop(); out.push(`</li></${c}>`); }
      if (stack.length === depth && stack[depth-1] !== tag) { const c=stack.pop(); out.push(`</li></${c}>`); }
      while (stack.length < depth) { out.push(`<${tag}>`); stack.push(tag); }
      out.push(`<li>${inl(li[3])}`);
      continue;
    }
    if (stack.length) { out.push(` ${inl(line.trim())}`); continue; }
    para.push(line.trim());
  }
  if (inCode && buf.length) { const c=buf.join("\n"); out.push(`<pre><button class="copy-code" type="button" data-code="${escAttr(c)}">复制</button><code>${esc(c)}</code></pre>`); }
  flushP(); flushQ(); closeL();
  return out.join("\n");
}

function inl(t) {
  let h = esc(t);
  h = h.replace(/`([^`]+)`/g, (_m,c)=>`<code>${c}</code>`);
  h = h.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>");
  h = h.replace(/~~([^~]+)~~/g,"<del>$1</del>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return h;
}

const shortHost = (u) => { try { return new URL(u).host; } catch { return u || "未配置"; } };
const fmtTime = (ms) => { const d=new Date(ms||Date.now()); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };

/* ---------- 状态 ---------- */
const S = window.gbState = {
  settings: null, bots: [], botId: null, sessions: [], sessionId: null,
  messages: [], connected: false,
  models: [], tools: [], editingBot: null,
  skills: [], currentSkill: null, mcp: [], routines: [], memory: [],
  // 例程后台运行快照：{ routineId: { startedAt, trigger } }
  routineRunning: {},
  // 例程编辑器当前在编辑哪一条（null = 新建）
  editingRoutineId: null,
  approvalQueue: [], currentApproval: null, approvalTimer: null,
  // 后台运行中的任务：key = `${botId}:${sessionId}`
  // 允许一边跑一边切到别的对话 / 别的 Bot，切回来还能看到进度
  runs: new Map(),
  // 上一次运行失败/停止的提示：key = `${botId}:${sessionId}`（主进程不落盘，只在本窗口展示）
  lastRunError: new Map(),
};
const E = {
  body:document.body, botList:$("botList"), sessionList:$("sessionList"), sessionLabel:$("sessionLabel"),
  botAvatar:$("botAvatar"), botName:$("botName"), botDesc:$("botDesc"),
  messages:$("messages"), empty:$("emptyState"), emptyHint:$("emptyHint"),
  input:$("input"), sendBtn:$("sendBtn"), statusLine:$("statusLine"),
  workspaceLine:$("workspaceLine"), modelChip:$("modelChip"), connDot:$("connDot"),
  computerChip:$("computerChip"),
  approvalChip:$("approvalChip"),
  toast:$("toast"),
};

let toastTimer=null;
function toast(m){ E.toast.textContent=m; E.toast.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>E.toast.hidden=true,2200); }

/* ---------- 运行态助手 ---------- */
const runKey = (botId, sessionId) => `${botId || ""}:${sessionId || ""}`;
const runFor = (botId, sessionId) => S.runs.get(runKey(botId, sessionId)) || null;
// 当前正在看的这段对话是否在跑
const currentRun = () => runFor(S.botId, S.sessionId);
// 任意位置在跑（用于侧栏标记、状态行）
const anyRunning = () => S.runs.size > 0;
// 某个 Bot 下有没有会话在跑
const botRunning = (botId) => [...S.runs.keys()].some((k) => k.startsWith(botId + ":"));

/* ---------- 渲染 ---------- */
function renderBots() {
  E.botList.innerHTML = "";
  if (!S.bots.length) {
    const d=document.createElement("div"); d.className="section-label"; d.style.padding="6px 8px"; d.textContent="还没有 Bot"; E.botList.appendChild(d); return;
  }
  // 置顶的排前面（最近置顶优先），其余按最近更新；与主进程排序保持一致
  const ordered = S.bots.slice().sort((x, y) => {
    const xp = x.pinned ? 1 : 0, yp = y.pinned ? 1 : 0;
    if (xp !== yp) return yp - xp;
    if (xp && yp) return (y.pinnedAt || 0) - (x.pinnedAt || 0);
    return (y.updatedAt || 0) - (x.updatedAt || 0);
  });
  for (const b of ordered) {
    const row=document.createElement("div");
    row.className=`bot-row${b.id===S.botId?" active":""}${b.pinned?" pinned":""}`;
    const btn=document.createElement("button");
    btn.type="button"; btn.className=`bot-item${b.id===S.botId?" active":""}`;
    const ico=document.createElement("div"); ico.className="bot-ico"; ico.style.background=b.color+"26"; ico.textContent=b.emoji||"🤖";
    const txt=document.createElement("div"); txt.className="bot-txt";
    const t=document.createElement("div"); t.className="bot-t";
    const nm=document.createElement("span"); nm.textContent=b.name; t.appendChild(nm);
    if (botRunning(b.id)) { const sp=document.createElement("span"); sp.className="run-dot"; sp.title="正在工作"; t.appendChild(sp); }
    const s=document.createElement("div"); s.className="bot-s"; s.textContent=b.description||"";
    txt.append(t,s); btn.append(ico,txt);
    btn.addEventListener("click",()=>selectBot(b.id));
    // 置顶开关：悬停显示；已置顶时常显并可点掉
    const pin=document.createElement("button");
    pin.type="button"; pin.className="bot-pin"+(b.pinned?" on":"");
    pin.title=b.pinned?"取消置顶":"置顶该 Bot";
    pin.setAttribute("aria-label", pin.title);
    pin.textContent=b.pinned?"📌":"⇧";
    const togglePin = async () => {
      const next = !b.pinned;
      const updated = await window.api.bots.pin(b.id, next);
      if (!updated) return;
      S.bots = S.bots.map((x) => (x.id === b.id ? updated : x));
      renderBots();
      toast(next ? `已置顶「${b.name}」` : `已取消置顶「${b.name}」`);
    };
    pin.addEventListener("click", (e) => { e.stopPropagation(); togglePin(); });
    row.append(btn, pin);
    E.botList.appendChild(row);
  }
}

function renderSessions() {
  E.sessionList.innerHTML="";
  E.sessionLabel.hidden = !S.botId;
  for (const s of S.sessions) {
    const btn=document.createElement("button");
    btn.type="button"; btn.className=`session-item${s.id===S.sessionId?" active":""}`;
    const t=document.createElement("span"); t.className="session-t"; t.textContent=s.title||"新对话";
    if (runFor(S.botId, s.id)) { const sp=document.createElement("span"); sp.className="run-dot"; sp.title="正在工作"; t.appendChild(sp); }
    const x=document.createElement("span"); x.className="session-x"; x.textContent="✕";
    x.addEventListener("click",(e)=>{e.stopPropagation(); removeSession(s.id);});
    btn.append(t,x);
    btn.addEventListener("click",()=>selectSession(s.id));
    E.sessionList.appendChild(btn);
  }
}

function renderMessages() {
  E.messages.innerHTML="";
  const run=currentRun();
  const has=S.messages.length>0 || Boolean(run);
  E.empty.hidden=has; E.messages.style.display=has?"":"none";
  // 有实时运行时，最后一条 user 消息之后的内容都属于「本次运行」，
  // 由下面的实时区统一呈现；这里跳过它们，避免流式盘中落盘的副本重复显示。
  let liveFrom = S.messages.length;
  if (run) {
    for (let i = S.messages.length - 1; i >= 0; i--) {
      if (S.messages[i].role === "user") { liveFrom = i + 1; break; }
      liveFrom = i;
    }
  }
  // 先把工具结果按 callId 建索引，历史里就能把「调用 + 结果」画成一条完整的工具卡
  const results = new Map();
  for (const m of S.messages) if (m.type==="tool_result" && m.callId) results.set(m.callId, m.output);
  for (let i = 0; i < S.messages.length; i++) {
    const m = S.messages[i];
    if (run && i >= liveFrom) continue;
    // 历史工具调用：已经结束，别再显示成「进行中」，并把对应结果带上
    if (m.type==="tool_call") {
      const out = results.get(m.callId);
      const blocked = out != null && /^(?:错误|已阻止)/.test(String(out));
      E.messages.appendChild(toolNode(m.name, m.arguments, out || null, blocked ? "err" : "ok"));
      continue;
    }
    if (m.type==="tool_result") { continue; }
    // 流式快照：有实时区时由实时区呈现；刷新窗口后没有实时区，就把已产出内容当成普通消息显示
    if (m.streaming) {
      if (run) continue;
      if (!String(m.content || "").trim()) continue; // 残留的空快照不显示成假「正在输入」
    }
    E.messages.appendChild(msgNode(m));
  }
  // 上一次运行失败/停止：主进程不会把它写进会话，这里补一条提示
  const failed = S.lastRunError?.get(runKey(S.botId, S.sessionId));
  if (failed && !run) E.messages.appendChild(msgNode(failed));
  // 这段对话正在后台跑：按运行里记录的数据重建实时区（切走再切回来不丢进度）
  if (run) E.messages.appendChild(buildLiveSection(run));
  E.messages.scrollTop=E.messages.scrollHeight;
}

/**
 * 根据 run 的数据重建「实时区」：一个气泡（承接流式文本）+ 工具/协作轨迹。
 * 用数据重建而不是搬 DOM，才能在切走再切回时既保住文本也保住工具轨迹。
 */
function buildLiveSection(run) {
  const wrap=document.createElement("div"); wrap.className="live";
  run.liveWrap=wrap;
  run.toolEls=new Map();
  const node=msgNode({ role:"assistant", content:run.acc, at:run.startAt, streaming:true });
  run.assistantNode=node;
  run.assistantEl=node.querySelector(".content");
  wrap.appendChild(node);
  for (const it of run.items) {
    if (it.kind==="error") { wrap.appendChild(errNode(it.message)); continue; }
    if (it.kind==="note") { wrap.appendChild(noteNode(it.text, it.level)); continue; }
    const n=toolNode(it.name, it.args, it.output||null, it.state);
    if (it.kind==="tool" && it.callId) run.toolEls.set(it.callId, n);
    wrap.appendChild(n);
  }
  return wrap;
}

function msgNode(m) {
  const wrap=document.createElement("div");
  wrap.className=`msg ${m.role==="user"?"user":"assistant"}`;
  const av=document.createElement("div"); av.className="av";
  av.textContent = m.role==="user" ? "你" : (S.bots.find(b=>b.id===S.botId)?.emoji || "🤖");
  const bub=document.createElement("div"); bub.className="bubble";
  const c=document.createElement("div"); c.className="content";
  if (m.role==="user") c.textContent=m.content;
  else if (m.streaming && !m.content) c.innerHTML='<span class="typing"><i></i><i></i><i></i></span>';
  else { c.innerHTML=md(m.content); bindCopy(c); }
  const foot=document.createElement("div"); foot.className="mfoot";
  if (m.role==="assistant") {
    const t=document.createElement("span"); t.textContent=fmtTime(m.at);
    const cp=document.createElement("button"); cp.type="button"; cp.className="copy link-btn"; cp.textContent="复制";
    cp.addEventListener("click",async()=>{await window.api.clipboard.write(m.content); toast("已复制");});
    foot.append(t,cp);
  }
  bub.append(c,foot); wrap.append(av,bub);
  return wrap;
}

function toolNode(name, args, output, state) {
  const wrap=document.createElement("div"); wrap.className="tool"; wrap.dataset.state=state||"running";
  const box=document.createElement("div"); box.className="tool-box";
  const head=document.createElement("div"); head.className="tool-head";
  const caret=document.createElement("span"); caret.className="tool-caret"; caret.hidden=!output; caret.textContent=output?"▸":"";
  const ico=document.createElement("span"); ico.className="tool-ico"; ico.textContent = state==="ok"?"✓":state==="err"?"✕":"◐";
  const nm=document.createElement("span"); nm.className="tool-name"; nm.textContent=name;
  const arg=document.createElement("span"); arg.className="tool-arg"; arg.textContent=summarizeArgs(args);
  head.append(caret,ico,nm,arg);
  box.appendChild(head);
  wrap.appendChild(box);
  // 执行输出默认折叠：卡片头只留「工具名 + 一行参数」，需要时点开看完整输出/代码。
  // 出错时自动展开，避免失败被折叠淹没。
  if (output) ensureToolBody(wrap, output, state||"running");
  head.addEventListener("click",()=>{
    const b=box.querySelector(".tool-body"); if(!b) return;
    b.hidden=!b.hidden;
    caret.textContent = b.hidden ? "▸" : "▾";
  });
  return wrap;
}

/** 给工具卡补/更新折叠体，并同步折叠箭头与「出错自动展开」 */
function ensureToolBody(n, output, state) {
  const box=n.querySelector(".tool-box"); if(!box) return;
  const caret=n.querySelector(".tool-caret");
  let body=box.querySelector(".tool-body");
  const autoOpen = state==="err";
  if(!body){ body=document.createElement("div"); body.className="tool-body"; box.appendChild(body); }
  body.textContent=output||"";
  body.hidden=!autoOpen;
  if(caret){ caret.hidden=false; caret.textContent = body.hidden ? "▸" : "▾"; }
  n.dataset.state=state||n.dataset.state;
}

function errNode(message) {
  const w=document.createElement("div"); w.className="tool";
  const b=document.createElement("div"); b.className="errbox";
  b.innerHTML=`<b>执行失败</b>${esc(message||"")}`;
  w.appendChild(b);
  return w;
}

/** 运行中的状态提示（自动续跑 / 达到步数上限），不是错误，只是让用户知道发生了什么 */
function noteNode(text, level) {
  const w=document.createElement("div"); w.className="tool";
  const b=document.createElement("div"); b.className="notebox" + (level==="warn"?" warn":"");
  b.textContent=text||"";
  w.appendChild(b);
  return w;
}

function summarizeArgs(args) {
  try {
    const o=JSON.parse(args||"{}");
    if (o.command) return o.command.slice(0,90);
    if (o.path) return o.path;
    if (o.pattern) return `/${o.pattern}/`;
    return JSON.stringify(o).slice(0,80);
  } catch { return String(args||"").slice(0,80); }
}

function bindCopy(root) {
  root.querySelectorAll(".copy-code").forEach((b)=>{
    b.addEventListener("click",async()=>{await window.api.clipboard.write(b.dataset.code||"");toast("代码已复制");});
  });
}

async function refreshComputer() {
  if (!S.botId) { E.computerChip.textContent = "无计算机"; E.computerChip.classList.remove("ok","err"); return; }
  try {
    const info = await window.api.computer.info(S.botId);
    S.computer = info;
    if (info.kind === "local") { E.computerChip.textContent = "本机"; E.computerChip.title = info.rootDir; }
    else if (info.kind === "remote") { E.computerChip.textContent = "云端"; E.computerChip.title = info.rootDir; }
    else { E.computerChip.textContent = "无计算机"; }
    E.computerChip.classList.toggle("ok", info.health?.ok === true);
    E.computerChip.classList.toggle("err", info.health?.ok === false);
  } catch {
    E.computerChip.textContent = "未知";
  }
}

function updateChrome() {
  const p=S.settings?.provider||{};
  E.modelChip.textContent = p.model || "选择模型";
  E.connDot.className = `dot ${S.connected?"ok":""}`;
  const botMode = S.bots.find(b=>b.id===S.botId)?.approvalMode || "inherit";
  const effMode = botMode !== "inherit" ? botMode : (S.settings?.approval?.mode || "balanced");
  const MODE_TEXT = { strict: "🛡 严格", balanced: "🛡 标准", relaxed: "🛡 宽松", off: "🛡 关闭" };
  E.approvalChip.textContent = MODE_TEXT[effMode] || "🛡 标准";
  E.approvalChip.classList.toggle("warn", effMode === "off");
  E.approvalChip.title = botMode === "inherit"
    ? `审批策略：${effMode}（跟随全局，点击打开设置）`
    : `审批策略：${effMode}（本 Bot 单独设置，点击打开设置）`;
  const bot=S.bots.find(b=>b.id===S.botId);
  if (bot) {
    E.botAvatar.textContent=bot.emoji||"🤖";
    E.botAvatar.style.background=bot.color+"26";
    E.botName.textContent=bot.name;
    E.botDesc.textContent=bot.description||bot.workspace;
    E.workspaceLine.textContent=bot.workspace;
  } else {
    E.botAvatar.textContent="🤖"; E.botName.textContent="未选择 Bot"; E.botDesc.textContent="从左栏选择一个 Bot 开始";
    E.workspaceLine.textContent="";
  }
  const curRun = currentRun();
  E.statusLine.textContent = curRun
    ? "这段对话工作中…（可切到别处，它会继续跑）"
    : anyRunning()
      ? `${S.runs.size} 个对话在后台工作中`
      : S.connected
        ? `${shortHost(p.baseUrl)} · ${p.model||"未选择模型"}`
        : "模型服务未连接";
  E.emptyHint.textContent = S.botId ? "下发一个任务，它会用工具在真实文件上操作。" : "先创建一个 Bot，它会拥有独立的工作目录。";
}

/* ---------- 数据操作 ---------- */
async function loadBots(selectFirst) {
  S.bots = await window.api.bots.list();
  if (!S.botId || !S.bots.some(b=>b.id===S.botId)) {
    S.botId = S.bots[0]?.id || null;
  }
  renderBots();
  if (S.botId) await loadSessions(selectFirst);
  else { S.sessions=[]; S.sessionId=null; S.messages=[]; renderSessions(); renderMessages(); }
  updateChrome();
}

async function loadSessions(createIfEmpty) {
  if (!S.botId) return;
  S.sessions = await window.api.sessions.list(S.botId);
  if (createIfEmpty && S.sessions.length === 0) {
    const s = await window.api.sessions.create(S.botId, "新对话");
    S.sessions = [s];
  }
  if (!S.sessionId || !S.sessions.some(s=>s.id===S.sessionId)) {
    S.sessionId = S.sessions[0]?.id || null;
  }
  renderSessions();
  await loadMessages();
}

async function loadMessages() {
  if (!S.botId || !S.sessionId) { S.messages=[]; renderMessages(); return; }
  const s = await window.api.sessions.get(S.botId, S.sessionId);
  // 对话可能在后台被删掉了（删会话 / 删 Bot），这时别把它当成「空对话」
  if (!s) { S.messages = []; return renderMessages(); }
  S.messages = s.messages || [];
  renderMessages();
}

/** 只刷新侧栏会话列表（不碰正文，避免后台任务结束后打断正在看的别的对话） */
async function refreshSessionList(botId) {
  if (!S.botId || botId !== S.botId) return;
  S.sessions = await window.api.sessions.list(S.botId);
  renderSessions();
}

async function selectBot(id) {
  S.botId = id; S.sessionId = null;
  renderBots();
  await loadSessions(true);
  updateChrome();
  syncComposer();
  refreshComputer();
}

async function selectSession(id) {
  S.sessionId = id;
  renderSessions();
  await loadMessages();
  updateChrome();
  syncComposer();
}

async function removeSession(id) {
  if (runFor(S.botId, id)) return toast("这个对话正在工作中，先停止再删");
  if (!confirm("删除这个对话？")) return;
  await window.api.sessions.remove(S.botId, id);
  S.sessionId = null;
  await loadSessions(true);
}

async function newSession() {
  if (!S.botId) return toast("先创建一个 Bot");
  const s = await window.api.sessions.create(S.botId, "新对话");
  S.sessionId = s.id;
  await loadSessions(false);
  syncComposer();
  E.input.focus();
}

/* ---------- 发送 ---------- */
function autoGrow() {
  const el=E.input; el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,220)+"px";
}

// 发送/停止按钮只反映「当前这段对话」是否在跑
function syncComposer() {
  const running = Boolean(currentRun());
  E.sendBtn.classList.toggle("busy", running);
  E.sendBtn.disabled = running ? false : E.input.value.trim().length===0;
  E.sendBtn.setAttribute("aria-label", running ? "停止" : "发送");
  E.sendBtn.title = running ? "停止这段对话" : "发送（Enter）";
  updateChrome();
}

async function send() {
  // 当前这段对话在跑 → 这个按钮就是「停止」
  const cur = currentRun();
  if (cur) { await window.api.agent.stop(cur.runId); return; }

  const text=E.input.value.trim();
  if (!text) return;
  if (!S.botId) return toast("先创建一个 Bot");
  if (!S.sessionId) { await loadSessions(true); if(!S.sessionId) return toast("创建对话失败"); }

  hideMention();
  const botId = S.botId, sessionId = S.sessionId;
  if (runFor(botId, sessionId)) return; // 该对话已在跑

  S.messages.push({ role:"user", content:text, at:Date.now() });
  E.input.value=""; autoGrow(); renderMessages();
  E.messages.scrollTop=E.messages.scrollHeight;

  startRun({ botId, sessionId, text });
}

/**
 * 启动一个后台运行。
 * 关键点：运行状态挂在 S.runs 上（按 botId+sessionId），而不是全局单例。
 * 于是切到别的对话/别的 Bot 都不会中断它；切回来还能接着看实时输出，
 * 因为实时区是按 run 里记录的数据「重建」的（文本 + 工具轨迹都在）。
 */
function startRun({ botId, sessionId, text }) {
  const runId = crypto.randomUUID();
  const startAt = Date.now();
  const run = {
    runId, botId, sessionId, text, startAt,
    acc: "",
    items: [],             // 事件流水：tool / delegate / message / group / error
    liveWrap: null,        // 当前挂在视图里的实时区（切走时为 null）
    assistantNode: null,
    assistantEl: null,
    toolEls: new Map(),    // callId -> 工具节点（只在实时区可见时有效）
    off: null,
    stopped: false,
  };
  S.runs.set(runKey(botId, sessionId), run);
  S.lastRunError?.delete(runKey(botId, sessionId));

  const isVisible = () => S.botId === botId && S.sessionId === sessionId;
  const scrollIfVisible = () => {
    if (run.liveWrap && run.liveWrap.parentElement === E.messages) {
      E.messages.scrollTop = E.messages.scrollHeight;
    }
  };
  // 往实时区追加一个轨迹节点；实时区不在视野里就只记数据，等切回来重建
  const pushItem = (item, makeNode) => {
    run.items.push(item);
    if (run.liveWrap && run.liveWrap.parentElement === E.messages) {
      run.liveWrap.appendChild(makeNode(item)); scrollIfVisible();
    }
  };
  const renderText = () => {
    if (!run.assistantEl || run.liveWrap?.parentElement !== E.messages) return;
    if (run.acc) { run.assistantEl.innerHTML = md(run.acc); bindCopy(run.assistantEl); }
    else run.assistantEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  };

  // 先画出实时区（切走再切回来会经由 renderMessages 依同一份数据重建）
  renderMessages();
  renderBots(); renderSessions(); syncComposer();

  run.off = window.api.agent.onEvent((ev) => {
    if (ev.runId !== runId) return;
    if (ev.type==="text") {
      run.acc += ev.delta;
      renderText(); scrollIfVisible();
    } else if (ev.type==="tool_call") {
      pushItem({ kind:"tool", callId:ev.callId, name:ev.name, args:ev.arguments, output:"", state:"running" },
        (it) => { const n=toolNode(it.name, it.args, null, "running"); run.toolEls.set(it.callId, n); return n; });
    } else if (ev.type==="tool_result") {
      const it = run.items.find((x) => x.kind==="tool" && x.callId===ev.callId);
      if (it) {
        it.state = /^(?:错误|已阻止)/.test(ev.output) ? "err" : "ok";
        it.output = ev.output;
      }
      const n = run.toolEls.get(ev.callId);
      if (n) {
        n.dataset.state = it?.state || "ok";
        n.querySelector(".tool-ico").textContent = n.dataset.state==="err" ? "✕" : "✓";
        // 结果回来时把输出放进折叠体（默认收起，出错自动展开）
        ensureToolBody(n, ev.output, n.dataset.state);
        scrollIfVisible();
      }
    } else if (ev.type==="delegate") {
      pushItem({ kind:"delegate", name:"delegate → " + ev.botName, args:"已交给该 Bot 处理", output:"", state:"ok" },
        (it) => toolNode(it.name, it.args, null, "ok"));
    } else if (ev.type==="message_sent") {
      pushItem({ kind:"message", name:"message → " + ev.botName, args:"已留言", output:"已投递到对方收件箱", state:"ok" },
        (it) => toolNode(it.name, it.args, it.output, "ok"));
    } else if (ev.type==="group_chat") {
      pushItem({ kind:"group", name:"群聊", args:ev.topic, output:"房间 " + ev.roomId, state:"running" },
        (it) => toolNode(it.name, it.args, it.output, "running"));
    } else if (ev.type==="group_reply") {
      pushItem({ kind:"group", name:ev.botName, args:"发言", output:ev.text, state:"ok" },
        (it) => toolNode(it.name, it.args, it.output, "ok"));
    } else if (ev.type==="error") {
      pushItem({ kind:"error", message:ev.message }, (it) => errNode(it.message));
    } else if (ev.type==="skill_loaded") {
      const names = (ev.skills||[]).map((s)=>"@"+s.name).join("  ");
      pushItem({ kind:"skill", name:"已加载技能", args:names, output:"本次将严格按该技能步骤执行", state:"ok" },
        (it) => toolNode(it.name, it.args, it.output, "ok"));
    } else if (ev.type==="continuing") {
      const text = `已自动继续（第 ${ev.batch}/${ev.maxContinuations} 次，累计 ${ev.steps} 步）——上一批步数用尽但任务还没做完`;
      pushItem({ kind:"note", text, level:"info" }, (it) => noteNode(it.text, it.level));
    } else if (ev.type==="max_steps") {
      const text = `⚠️ 已达步数上限（${ev.steps} 步），任务仍未完成`;
      pushItem({ kind:"note", text, level:"warn" }, (it) => noteNode(it.text, it.level));
    }
    if (isVisible()) scrollIfVisible();
  });

  window.api.agent.run({ runId, botId, sessionId, text })
    .then((r) => { run.off?.(); run.off = null; finishRun(run, r); afterRunRefresh(botId, sessionId); })
    .catch((err) => {
      run.off?.(); run.off = null;
      finishRun(run, { ok:false, message: err.message || "发送失败" });
      afterRunRefresh(botId, sessionId);
    });
}

/** 运行结束后收尾刷新：只重画「如果用户正看着这段对话」的正文，其它对话不打断 */
async function afterRunRefresh(botId, sessionId) {
  try { await refreshSessionList(botId); } catch { /* 侧栏刷新失败不影响正文 */ }
  if (S.botId === botId && S.sessionId === sessionId) {
    try { await loadMessages(); } catch { renderMessages(); }
  }
  renderBots(); renderSessions(); updateChrome(); syncComposer();
}

/**
 * 运行结束：把这段对话从「后台运行」摘掉。
 * - 成功：最终回复已由主进程写进会话文件，切回该对话时 reload 即可看到。
 * - 失败 / 停止：也给出一条错误提示，别让用户面对空白。
 * - 如果用户正看着这段对话，需要立刻重画（不必等它切走再切回）。
 */
function finishRun(run, r) {
  const key = runKey(run.botId, run.sessionId);
  S.runs.delete(key);
  run.liveWrap = null; run.assistantNode = null; run.assistantEl = null; run.toolEls.clear();
  if (r?.ok) {
    // 最终回复（含「已停止」占位）由主进程写进会话，afterRunRefresh 会重新读盘展示
    S.lastRunError?.delete(key);
    S.connected = true;
  } else if (r?.maxStepsReached) {
    // 未完成：主进程已把「⚠️ 未完成」写进会话正文，这里不再叠一个「出错」气泡
    S.lastRunError?.delete(key);
    S.connected = true;
  } else {
    S.lastRunError?.set(key, { role:"assistant", content: `**出错**\n\n${r?.message || "未知错误"}`, at: Date.now() });
    // 用户正看着这段对话：afterRunRefresh 会重画成结果提示
  }
}
/* ---------- 设置 ---------- */
function openSettings() {
  const p=S.settings.provider||{};
  $("baseUrl").value=p.baseUrl||"";
  $("apiKey").value=p.apiKey||"";
  $("modelInput").value=p.model||"";
  $("reasoning").value=p.reasoningEffort||"";
  $("themeSelect").value=S.settings.ui?.theme||"dark";
  const comp=S.settings.computer||{kind:"local"};
  $("computerKind").value=comp.kind||"local";
  $("computerBaseUrl").value=comp.baseUrl||"";
  $("computerToken").value=comp.token||"";
  $("remoteFields").hidden=(comp.kind||"local")!=="remote";
  $("approvalMode").value=S.settings.approval?.mode||"balanced";
  $("testResult").textContent=""; $("testResult").className="test-result";
  setModelHint("");
  fillModelOptions(S.models);
  closeSettingsModelPop();
  // 地址+密钥与上次成功拉取的一致时，直接复用结果，不重复打扰上游
  if (S.models.length && modelCache.key === connKey(p.baseUrl||"", p.apiKey||"")) {
    if (!$("modelInput").value.trim()) $("modelInput").value = pickDefaultModel(S.models);
    setModelHint(`已缓存 ${S.models.length} 个模型，可直接下拉选择`, "ok");
  }
  $("settingsModal").hidden=false;
  window.api.info().then(i=>{ $("envInfo").textContent=`v${i.version} · Electron ${i.electron} · ${i.platform}`; });
}

async function saveSettings() {
  S.settings = await window.api.settings.update({
    provider:{ baseUrl:$("baseUrl").value.trim(), apiKey:$("apiKey").value.trim(), model:$("modelInput").value.trim(), reasoningEffort:$("reasoning").value },
    computer:{ kind:$("computerKind").value, baseUrl:$("computerBaseUrl").value.trim(), token:$("computerToken").value.trim() },
    approval:{ mode:$("approvalMode").value },
    ui:{ theme:$("themeSelect").value },
  });
  E.body.dataset.theme = S.settings.ui.theme==="light"?"light":"dark";
  $("settingsModal").hidden=true;
  updateChrome();
  toast("已保存");
}

async function testConn() {
  const btn=$("testBtn"), out=$("testResult");
  btn.disabled=true; out.className="test-result"; out.textContent="正在测试…";
  await window.api.settings.update({ provider:{ baseUrl:$("baseUrl").value.trim(), apiKey:$("apiKey").value.trim() } });
  S.settings = await window.api.settings.get();
  const r = await window.api.model.test();
  btn.disabled=false;
  if (r.ok) {
    out.className="test-result ok";
    out.textContent=`连接成功：${r.models.length} 个模型`;
    S.connected=true; S.models=r.models;
    fillModelOptions(r.models);
    modelCache.key = connKey(S.settings.provider?.baseUrl||"", S.settings.provider?.apiKey||"");
    modelCache.list = r.models; modelCache.at = Date.now();
    if (!r.models.includes($("modelInput").value)) {
      $("modelInput").value = r.models.find(m=>/deepseek|grok/i.test(m)) || r.models[0] || "";
    }
    renderModelList("");
  } else {
    out.className="test-result err"; out.textContent=r.message||"连接失败"; S.connected=false;
  }
  updateChrome();
}

/* ---------- 从上游拉取模型 ---------- */
// 记住上次拉取用的连接参数，避免每次打开设置都打扰上游
const modelCache = { key: "", list: [], at: 0 }; // 最近一次成功拉取的连接参数与结果
let modelAttemptKey = ""; // 最近一次「发起过」拉取的参数（成功失败都算，用于去重）
let modelFetchSeq = 0;

const connKey = (baseUrl, apiKey) => `${baseUrl}\u0000${apiKey}`;

function fillModelOptions(list) {
  const dl=$("modelOptions");
  if (!dl) return;
  dl.innerHTML="";
  for (const m of list || []) {
    const o=document.createElement("option"); o.value=m; dl.appendChild(o);
  }
}

/* ---------- 设置里的模型下拉（比 datalist 可靠） ---------- */
function renderSettingsModelList(kw) {
  const box=$("modelList2");
  if (!box) return;
  box.innerHTML="";
  const q=(kw||"").trim().toLowerCase();
  const items=(S.models||[]).filter(m=>!q||m.toLowerCase().includes(q));
  if (!items.length) {
    const d=document.createElement("div");
    d.className="combo-empty";
    d.textContent=(S.models||[]).length ? "无匹配" : "还没有模型，点右上「从上游拉取」";
    box.appendChild(d);
    return;
  }
  const cur=$("modelInput").value.trim();
  for (const m of items.slice(0,500)) {
    const b=document.createElement("button");
    b.type="button";
    b.className="combo-item"+(m===cur?" active":"");
    b.textContent=m;
    b.title=m;
    b.addEventListener("click",()=>{
      $("modelInput").value=m;
      closeSettingsModelPop();
    });
    box.appendChild(b);
  }
}

function openSettingsModelPop(focusFilter=true) {
  const pop=$("modelPop");
  if (!pop) return;
  pop.hidden=false;
  $("modelCombo").classList.add("open");
  $("modelFilter").value="";
  renderSettingsModelList("");
  if (focusFilter) $("modelFilter").focus();
  const hl=$("modelList2").querySelector(".active") || $("modelList2").querySelector(".combo-item");
  hl?.scrollIntoView({block:"nearest"});
}

function closeSettingsModelPop() {
  const pop=$("modelPop");
  if (!pop || pop.hidden) return;
  pop.hidden=true;
  $("modelCombo").classList.remove("open");
}

function setModelHint(text, kind) {
  const h=$("modelHint");
  if (!h) return;
  h.textContent=text||"";
  h.className="field-hint"+(kind?` ${kind}`:"");
}

// 智能挑一个默认模型：优先 deepseek/grok，其次排除 embedding/whisper 之类的非对话模型
function pickDefaultModel(list) {
  if (!list || !list.length) return "";
  const chat = list.filter(m=>!/embed|whisper|tts|dall-e|moderation|rerank|image/i.test(m));
  const pool = chat.length ? chat : list;
  return pool.find(m=>/deepseek|grok/i.test(m)) || pool[0] || "";
}

async function fetchModelsFromUpstream({ silent = false } = {}) {
  const baseUrl=$("baseUrl").value.trim();
  const apiKey=$("apiKey").value.trim();
  const seq=++modelFetchSeq;

  if (!baseUrl) {
    setModelHint("先填模型服务地址", "err");
    if (!silent) toast("先填模型服务地址");
    return { ok:false, message:"先填模型服务地址" };
  }

  setModelHint("正在从上游拉取…");
  modelAttemptKey = connKey(baseUrl, apiKey);
  const r = await window.api.model.list({ baseUrl, apiKey });
  if (seq !== modelFetchSeq) return r; // 已有更新的请求，丢弃旧结果

  if (!r.ok) {
    setModelHint(r.message||"拉取失败", "err");
    if (!silent) toast(r.message||"拉取失败");
    return r;
  }

  S.models = r.models || [];
  modelCache.key = connKey(baseUrl, apiKey);
  modelCache.list = S.models;
  modelCache.at = Date.now();
  fillModelOptions(S.models);
  if (!$("modelPop").hidden) renderSettingsModelList($("modelFilter").value);

  // 自动挑一个可用的默认模型，省得用户自己输 ID。
  // 注意：如果输入框里是旧模型（换了地址/密钥后已不在上游列表里），也要纠正过来，
  // 否则用户会看到「拉下来了但框里还是个不存在的模型」，以为没拉到。
  const cur = $("modelInput").value.trim();
  if (S.models.length && (!cur || !S.models.includes(cur))) {
    $("modelInput").value = pickDefaultModel(S.models);
  }
  // 手动点「从上游拉取」时，把下拉展开，让用户直接看到拉到了哪些
  if (!silent && S.models.length && $("modelPop").hidden) {
    openSettingsModelPop(false);
  }

  if (S.models.length) setModelHint(`已拉取 ${S.models.length} 个模型，可直接下拉选择`, "ok");
  else setModelHint("上游没有返回模型列表（仍可手动输入模型 ID）", "err");

  return r;
}

/* ---------- 模型选择器 ---------- */
function renderModelList(kw) {
  const list=$("modelList"); list.innerHTML="";
  const q=(kw||"").toLowerCase();
  const items=S.models.filter(m=>!q||m.toLowerCase().includes(q));
  if (!items.length) { const d=document.createElement("div"); d.className="p-item muted"; d.textContent=S.models.length?"无匹配":"还没有模型，点「刷新」"; list.appendChild(d); }
  for (const m of items.slice(0,400)) {
    const b=document.createElement("button"); b.type="button";
    b.className=`p-item${m===S.settings.provider.model?" active":""}`;
    b.textContent=m;
    b.addEventListener("click",async()=>{
      S.settings=await window.api.settings.update({provider:{model:m}});
      $("modelPicker").hidden=true; updateChrome(); toast("已切换到 "+m);
    });
    list.appendChild(b);
  }
  $("modelCount").textContent=`${S.models.length} 个`;
}

function openModelPicker() {
  const p=$("modelPicker"); p.hidden=false;
  $("modelSearch").value="";
  renderModelList("");
  const r=E.modelChip.getBoundingClientRect();
  p.style.top=(r.bottom+8)+"px";
  p.style.left=Math.max(12,r.right-380)+"px";
  setTimeout(()=>$("modelSearch").focus(),20);
}

async function refreshModels() {
  const r=await window.api.model.list();
  if (r.ok) {
    S.models=r.models;
    // 记录这组参数已拉过，打开设置面板时可直接显示「已缓存」
    const sp=S.settings?.provider||{};
    modelCache.key=connKey(sp.baseUrl||"", sp.apiKey||"");
    modelCache.list=S.models; modelCache.at=Date.now();
    modelAttemptKey=modelCache.key;
    fillModelOptions(S.models);
    renderModelList($("modelSearch").value);
    toast(`已加载 ${r.models.length} 个模型`);
  }
  else toast(r.message||"加载失败");
}

/* ---------- 技能 ---------- */
async function loadSkills() {
  S.skills = await window.api.skills.list();
  renderSkillItems();
  renderBotSkillPicker();
}

/* ---------- @ 技能补全 ---------- */
const mention = { open: false, items: [], active: 0, at: -1 };

/** 光标正好处在一个 @xxx 片段里时，返回 { at, query }；否则 null */
function mentionContext() {
  const el = E.input;
  const pos = el.selectionStart == null ? el.value.length : el.selectionStart;
  const before = el.value.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null; // 中间出现空白，说明这不是补全片段
  if (!/^[0-9A-Za-z_\-\u4e00-\u9fff]*$/.test(query)) return null; // 出现标点即结束
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && /[0-9A-Za-z_\-]/.test(prev)) return null; // 邮箱之类
  if (prev === "/" || prev === "\\" || prev === "@") return null;
  return { at, query };
}

function mentionCandidates(query) {
  const q = String(query || "").toLowerCase();
  const scored = [];
  for (const sk of S.skills) {
    const name = String(sk.name || "").toLowerCase();
    const id = String(sk.id || "").toLowerCase();
    const prefix = q && (name.startsWith(q) || id.startsWith(q));
    const hit = !q || prefix || name.includes(q) || id.includes(q);
    if (hit) scored.push({ sk, score: q ? (prefix ? 0 : 1) : 0 });
  }
  scored.sort((a, b) => a.score - b.score || String(a.sk.name).localeCompare(String(b.sk.name)));
  return scored.slice(0, 8).map((x) => x.sk);
}

function mentionOpen() { return mention.open; }

function hideMention() {
  if (!mention.open) return;
  mention.open = false;
  mention.items = [];
  mention.at = -1;
  const pop = $("mentionPop");
  if (pop) pop.hidden = true;
}

function renderMentionActive() {
  const list = $("mentionList");
  if (!list) return;
  const btns = list.querySelectorAll(".mention-item");
  btns.forEach((b, i) => b.classList.toggle("active", i === mention.active));
  const cur = btns[mention.active];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

function showMention() {
  const ctx = mentionContext();
  if (!ctx) return hideMention();
  const items = mentionCandidates(ctx.query);
  if (!items.length) return hideMention();

  mention.open = true;
  mention.items = items;
  mention.at = ctx.at;
  if (mention.active >= items.length) mention.active = 0;

  const list = $("mentionList");
  list.innerHTML = "";
  items.forEach((sk, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mention-item" + (i === mention.active ? " active" : "");
    b.dataset.index = String(i);
    const nm = document.createElement("span"); nm.className = "m-name"; nm.textContent = "@" + sk.name;
    const desc = document.createElement("span"); desc.className = "m-desc"; desc.textContent = sk.description || sk.id;
    b.append(nm, desc);
    // mousedown 优先于 blur，防止点击时输入框先失焦
    b.addEventListener("mousedown", (e) => { e.preventDefault(); applyMention(i); });
    list.appendChild(b);
  });

  const pop = $("mentionPop");
  pop.hidden = false;
  const r = E.input.getBoundingClientRect();
  const width = Math.min(380, Math.max(200, r.width));
  pop.style.width = width + "px";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 8) + "px";
}

function applyMention(index) {
  if (!mention.open) return;
  const sk = mention.items[index == null ? mention.active : index];
  if (!sk) return hideMention();
  const el = E.input;
  const pos = el.selectionStart == null ? el.value.length : el.selectionStart;
  const before = el.value.slice(0, mention.at);
  const after = el.value.slice(pos);
  const insert = "@" + sk.name + " ";
  el.value = before + insert + after;
  const caret = (before + insert).length;
  el.setSelectionRange(caret, caret);
  hideMention();
  autoGrow(); syncComposer();
  el.focus();
}

function renderSkillItems() {
  const box = $("skillItems");
  box.innerHTML = "";
  if (!S.skills.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.style.padding = "10px 8px";
    d.textContent = "还没有技能";
    box.appendChild(d);
    return;
  }
  for (const sk of S.skills) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "skill-item" + (S.currentSkill?.id === sk.id ? " active" : "");
    const n = document.createElement("div");
    n.className = "skill-n";
    n.textContent = sk.name;
    const d = document.createElement("div");
    d.className = "skill-d";
    d.textContent = sk.description || "无描述";
    b.append(n, d);
    b.addEventListener("click", () => openSkill(sk.id));
    box.appendChild(b);
  }
}

function renderBotSkillPicker() {
  const box = $("botSkillList");
  if (!box) return;
  box.innerHTML = "";
  if (!S.skills.length) {
    box.innerHTML = '<span class="muted" style="font-size:11px">还没有技能，可在左栏「技能」里新建</span>';
    return;
  }
  const enabled = Array.isArray(S.editingBot?.enabledSkills) ? S.editingBot.enabledSkills : [];
  for (const sk of S.skills) {
    const label = document.createElement("label");
    label.className = "skill-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = sk.id;
    cb.checked = enabled.includes(sk.id);
    cb.dataset.skill = sk.id;
    const span = document.createElement("span");
    span.textContent = sk.name;
    label.append(cb, span);
    box.appendChild(label);
  }
}

async function openSkill(id) {
  const sk = await window.api.skills.get(id);
  if (!sk) return toast("技能不存在");
  S.currentSkill = sk;
  $("skillEmpty").hidden = true;
  $("skillEditor").hidden = false;
  $("skillId").value = sk.id;
  $("skillId").readOnly = true;
  $("skillName").value = sk.name;
  $("skillDesc").value = sk.description;
  $("skillBody").value = sk.body;
  renderSkillItems();
}

function newSkill() {
  S.currentSkill = { id: "" };
  $("skillEmpty").hidden = true;
  $("skillEditor").hidden = false;
  $("skillId").value = "";
  $("skillId").readOnly = false;
  $("skillName").value = "";
  $("skillDesc").value = "";
  $("skillBody").value = "# 步骤\n\n1. ";
  renderSkillItems();
}

async function saveSkill() {
  const id = $("skillId").value.trim();
  if (!id) return toast("请填写标识（英文，作为目录名）");
  try {
    const sk = await window.api.skills.save(id, {
      name: $("skillName").value.trim() || id,
      description: $("skillDesc").value.trim(),
      body: $("skillBody").value,
    });
    S.currentSkill = sk;
    await loadSkills();
    $("skillId").readOnly = true;
    toast("技能已保存");
  } catch (e) {
    toast(e.message || "保存失败");
  }
}

async function deleteSkill() {
  const id = $("skillId").value.trim();
  if (!id) return;
  if (!confirm("删除技能「" + id + "」？")) return;
  await window.api.skills.remove(id);
  S.currentSkill = null;
  $("skillEditor").hidden = true;
  $("skillEmpty").hidden = false;
  await loadSkills();
  toast("已删除");
}

/* ---------- 长期记忆 ---------- */
async function openMemory() {
  S.memory = await window.api.memory.list(S.botId);
  renderMemoryList();
  $("memEditor").hidden = true;
  $("memoryModal").hidden = false;
}

function renderMemoryList() {
  const box = $("memList");
  box.innerHTML = "";
  const scopeF = $("memScopeFilter").value;
  const tierF = $("memTierFilter").value;
  const kw = ($("memSearchInput").value || "").trim().toLowerCase();

  let items = S.memory || [];
  if (scopeF !== "all") items = items.filter((m) => m.scope === scopeF);
  if (tierF !== "all") items = items.filter((m) => m.tier === tierF);
  if (kw) items = items.filter((m) => (m.topic + m.content).toLowerCase().includes(kw));

  if (!items.length) {
    box.innerHTML = '<div class="muted" style="padding:16px;text-align:center">没有匹配的记忆</div>';
    return;
  }

  for (const m of items) {
    const row = document.createElement("div");
    row.className = "mem-row";
    const tag = document.createElement("span");
    tag.className = "mem-tag " + m.tier + (m.scope === "bot" ? " bot" : "");
    tag.textContent = (m.tier === "profile" ? "偏好" : "经验") + "·" + (m.scope === "user" ? "我的" : "本Bot");

    const body = document.createElement("div");
    body.className = "mem-body";
    const t = document.createElement("div");
    t.className = "mem-topic";
    t.textContent = m.topic;
    const c = document.createElement("div");
    c.className = "mem-content";
    c.textContent = m.content;
    body.append(t, c);

    const del = document.createElement("button");
    del.className = "ghost-btn small danger";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      await window.api.memory.remove(S.botId, m.scope, m.id);
      S.memory = await window.api.memory.list(S.botId);
      renderMemoryList();
    });

    row.append(tag, body, del);
    box.appendChild(row);
  }
}

function newMemory() {
  $("memEditor").hidden = false;
  $("memTopic").value = "";
  $("memContent").value = "";
  $("memTier").value = "profile";
  $("memScope").value = "user";
  $("memTopic").focus();
}

async function saveMemory() {
  const topic = $("memTopic").value.trim();
  const content = $("memContent").value.trim();
  if (!topic) return toast("请填写主题");
  if (!content) return toast("请填写内容");
  const r = await window.api.memory.add(S.botId, {
    topic,
    content,
    tier: $("memTier").value,
    scope: $("memScope").value,
  });
  if (!r.ok) return toast(r.message || "保存失败");
  S.memory = await window.api.memory.list(S.botId);
  renderMemoryList();
  $("memEditor").hidden = true;
  toast("已记住");
}

/* ---------- 例程（定时任务） ---------- */
async function openRoutines() {
  S.routines = await window.api.routines.list();
  S.routineRunning = await window.api.routines.running();
  renderRoutineList();
  S.editingRoutineId = null;
  $("rtEditor").hidden = true;
  $("routinesModal").hidden = false;
}

/** 刷新「哪条例程正在后台跑」的快照，再重画列表 */
async function refreshRoutineState() {
  try { S.routineRunning = await window.api.routines.running(); } catch { S.routineRunning = {}; }
  if (!$("routinesModal").hidden) renderRoutineList();
}

function renderRoutineList() {
  const box = $("rtList");
  box.innerHTML = "";
  if (!S.routines?.length) {
    box.innerHTML = '<div class="muted" style="padding:14px;text-align:center">还没有例程</div>';
    return;
  }
  for (const r of S.routines) {
    const running = Boolean(S.routineRunning?.[r.id]);
    const bot = S.bots.find((b) => b.id === r.botId);
    const row = document.createElement("div");
    row.className = "rt-row";
    const info = document.createElement("div");
    info.className = "rt-info";
    const n = document.createElement("div");
    n.className = "rt-n";
    n.textContent = r.name + (r.enabled ? "" : "（已暂停）") + (running ? " · 后台运行中" : "");
    const d = document.createElement("div");
    d.className = "rt-d";
    const last = r.logs?.length ? r.logs[r.logs.length - 1] : null;
    const statusWord = last
      ? `上次 ${last.stopped ? "已停止" : last.blocked ? "受阻" : last.ok ? "成功" : "失败"}`
      : "未运行";
    d.textContent = `${bot?.emoji || "🤖"} ${bot?.name || "?"} · ${r.scheduleText}` +
      (running ? " · 正在后台执行，可以关窗口" :
        last ? ` · ${statusWord} ${new Date(last.at).toLocaleTimeString("zh-CN")}` : " · 未运行");
    info.append(n, d);
    const act = document.createElement("div");
    act.className = "rt-act";

    if (running) {
      // 正在后台跑：按钮变成「停止」，点了立刻中止
      const stopBtn = document.createElement("button");
      stopBtn.className = "ghost-btn small danger";
      stopBtn.textContent = "停止";
      stopBtn.addEventListener("click", async () => {
        stopBtn.disabled = true;
        await window.api.routines.stop(r.id);
        await refreshRoutineState();
      });
      act.append(stopBtn);
    } else {
      const runBtn = document.createElement("button");
      runBtn.className = "ghost-btn small";
      runBtn.textContent = "立即运行";
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true; runBtn.textContent = "启动中…";
        const res = await window.api.routines.runNow(r.id);
        // 后台启动后会立刻返回：把按钮态交给「正在运行」快照决定，别在这里改死
        if (!res.ok) toast(res.message || "运行失败");
        else if (res.alreadyRunning) toast("这条例程已经在后台运行了");
        else toast("已在后台启动，可以随时关闭窗口");
        await refreshRoutineState();
      });
      act.append(runBtn);
    }
    const toggle = document.createElement("button");
    toggle.className = "ghost-btn small";
    toggle.textContent = r.enabled ? "暂停" : "启用";
    toggle.addEventListener("click", async () => {
      await window.api.routines.update(r.id, { enabled: !r.enabled });
      S.routines = await window.api.routines.list();
      renderRoutineList();
    });
    const edit = document.createElement("button");
    edit.className = "ghost-btn small";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => editRoutine(r.id));
    const del = document.createElement("button");
    del.className = "ghost-btn small danger";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm("删除例程「" + r.name + "」？")) return;
      await window.api.routines.remove(r.id);
      S.routines = await window.api.routines.list();
      renderRoutineList();
    });
    act.append(toggle, edit, del);
    row.append(info, act);
    box.appendChild(row);
  }
}

function syncRtFields() {
  const kind = $("rtKind").value;
  $("rtIntervalField").hidden = kind !== "interval";
  $("rtTimeField").hidden = kind === "interval";
  $("rtDowField").hidden = kind !== "weekly";
}

function newRoutine() {
  // null = 新建；否则是被编辑的例程 id
  S.editingRoutineId = null;
  $("rtEditorTitle").textContent = "新建例程";
  $("saveRtBtn").textContent = "保存";
  $("rtEditor").hidden = false;
  $("rtName").value = "";
  $("rtPrompt").value = "";
  $("rtKind").value = "interval";
  $("rtMinutes").value = "60";
  $("rtTime").value = "09:00";
  $("rtDow").value = "1";
  $("rtAllowRisky").checked = false;
  const sel = $("rtBot");
  sel.innerHTML = "";
  for (const b of S.bots) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = (b.emoji || "🤖") + " " + b.name;
    sel.appendChild(o);
  }
  if (S.botId) sel.value = S.botId;
  sel.disabled = false;
  syncRtFields();
}

/** 打开编辑：把已有例程的值回填进同一个编辑器 */
function editRoutine(id) {
  const r = (S.routines || []).find((x) => x.id === id);
  if (!r) return toast("例程不存在");
  S.editingRoutineId = id;
  $("rtEditorTitle").textContent = "编辑例程";
  $("saveRtBtn").textContent = "保存修改";

  // Bot 下拉可能还没渲染（例如直接刷新过），先保证选项齐全
  const sel = $("rtBot");
  if (!sel.options.length) {
    for (const b of S.bots) {
      const o = document.createElement("option");
      o.value = b.id;
      o.textContent = (b.emoji || "🤖") + " " + b.name;
      sel.appendChild(o);
    }
  }
  sel.value = r.botId;

  $("rtName").value = r.name || "";
  $("rtPrompt").value = r.prompt || "";
  $("rtAllowRisky").checked = Boolean(r.allowRisky);

  const s = r.schedule || { kind: "interval", minutes: 60 };
  $("rtKind").value = s.kind;
  if (s.kind === "interval") {
    $("rtMinutes").value = String(s.minutes || 60);
  } else if (s.kind === "daily") {
    $("rtTime").value = s.time || "09:00";
  } else {
    $("rtDow").value = String(s.dayOfWeek ?? 1);
    $("rtTime").value = s.time || "09:00";
  }
  syncRtFields();
  $("rtEditor").hidden = false;
  $("rtEditor").scrollIntoView({ block: "nearest" });
  $("rtName").focus();
}

async function saveRoutine() {
  const name = $("rtName").value.trim();
  const prompt = $("rtPrompt").value.trim();
  const botId = $("rtBot").value;
  if (!name) return toast("请填写名称");
  if (!prompt) return toast("请填写要做的事");
  if (!botId) return toast("请先创建一个 Bot");

  const kind = $("rtKind").value;
  const schedule =
    kind === "interval"
      ? { kind, minutes: Number($("rtMinutes").value) || 60 }
      : kind === "daily"
        ? { kind, time: $("rtTime").value || "09:00" }
        : { kind, dayOfWeek: Number($("rtDow").value), time: $("rtTime").value || "09:00" };

  const editingId = S.editingRoutineId;
  const payload = { botId, name, prompt, schedule, allowRisky: $("rtAllowRisky").checked };
  const r = editingId
    ? await window.api.routines.update(editingId, payload)
    : await window.api.routines.create(payload);
  if (!r.ok) return toast(r.message);
  S.routines = await window.api.routines.list();
  renderRoutineList();
  $("rtEditor").hidden = true;
  S.editingRoutineId = null;
  const next = r.routine?.nextRunAt;
  toast((editingId ? "已保存修改" : "已创建") +
    (next ? "，下次运行：" + new Date(next).toLocaleString("zh-CN") : ""));
}

/* ---------- MCP ---------- */
async function openMcp() {
  S.mcp = await window.api.mcp.list();
  renderMcpList();
  $("mcpEditor").hidden = true;
  $("mcpModal").hidden = false;
}

function renderMcpList() {
  const box = $("mcpList");
  box.innerHTML = "";
  if (!S.mcp?.length) {
    box.innerHTML = '<div class="muted" style="padding:14px;text-align:center">还没有配置 MCP 服务器</div>';
    return;
  }
  for (const s of S.mcp) {
    const row = document.createElement("div");
    row.className = "mcp-row";
    const dot = document.createElement("span");
    dot.className = "mcp-dot " + (s.status === "connected" ? "ok" : s.status === "error" ? "err" : "");
    const info = document.createElement("div");
    info.className = "mcp-info";
    const n = document.createElement("div");
    n.className = "mcp-n";
    n.textContent = s.name + "  (" + s.type + ")";
    const d = document.createElement("div");
    d.className = "mcp-d";
    d.textContent = s.status === "error" ? s.error : (s.toolCount + " 个工具" + (s.tools.length ? "：" + s.tools.join(", ") : ""));
    info.append(n, d);
    const act = document.createElement("div");
    act.className = "mcp-act";
    const btn = document.createElement("button");
    btn.className = "ghost-btn small";
    btn.textContent = s.status === "connected" ? "断开" : "连接";
    btn.addEventListener("click", async () => {
      if (s.status === "connected") {
        S.mcp = await window.api.mcp.disconnect(s.name);
      } else {
        const r = await window.api.mcp.connect(s.name);
        S.mcp = r.status;
        if (!r.ok) toast(r.message || "连接失败");
      }
      renderMcpList();
    });
    const del = document.createElement("button");
    del.className = "ghost-btn small danger";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm("删除 MCP 服务器「" + s.name + "」？")) return;
      const cfg = await window.api.mcp.config();
      S.mcp = await window.api.mcp.save(cfg.filter((x) => x.name !== s.name));
      renderMcpList();
    });
    act.append(btn, del);
    row.append(dot, info, act);
    box.appendChild(row);
  }
}

function newMcp() {
  $("mcpEditor").hidden = false;
  $("mcpName").value = "";
  $("mcpType").value = "stdio";
  $("mcpCommand").value = "npx";
  $("mcpArgs").value = "";
  $("mcpUrl").value = "";
  $("mcpStdioFields").hidden = false;
  $("mcpHttpFields").hidden = true;
}

async function saveMcp() {
  const name = $("mcpName").value.trim();
  if (!name) return toast("请填写名称");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return toast("名称只能用字母数字下划线短横线");
  const type = $("mcpType").value;
  const entry = { name, type };
  if (type === "http") {
    entry.url = $("mcpUrl").value.trim();
    if (!entry.url) return toast("请填写 URL");
  } else {
    entry.command = $("mcpCommand").value.trim();
    entry.args = $("mcpArgs").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!entry.command) return toast("请填写命令");
  }
  const cfg = await window.api.mcp.config();
  const next = cfg.filter((x) => x.name !== name).concat(entry);
  S.mcp = await window.api.mcp.save(next);
  renderMcpList();
  $("mcpEditor").hidden = true;
  const st = S.mcp.find((x) => x.name === name);
  toast(st?.status === "connected" ? "已连接，发现 " + st.toolCount + " 个工具" : "已保存，但连接失败：" + (st?.error || ""));
}

/* ---------- Bot 编辑器 ---------- */
function openBotModal(bot) {
  S.editingBot = bot||null;
  $("botModalTitle").textContent = bot ? "编辑 Bot" : "新建 Bot";
  $("botNameInput").value = bot?.name||"";
  $("botEmojiInput").value = bot?.emoji||"🤖";
  $("botDescInput").value = bot?.description||"";
  $("botPromptInput").value = bot?.systemPrompt||"";
  $("botWorkspaceInput").value = bot?.workspace||"(创建后自动分配)";
  $("botApprovalMode").value = bot?.approvalMode||"inherit";
  $("botPinnedInput").checked = Boolean(bot?.pinned);
  $("deleteBotBtn").hidden = !bot;
  renderBotSkillPicker();
  $("botModal").hidden=false;
  setTimeout(()=>$("botNameInput").focus(),30);
}

async function saveBot() {
  const name=$("botNameInput").value.trim();
  if (!name) return toast("请输入名称");
  const enabledSkills=[...document.querySelectorAll('#botSkillList input[type=checkbox]')]
    .filter(c=>c.checked).map(c=>c.dataset.skill);
  const patch={
    name, emoji:$("botEmojiInput").value.trim()||"🤖",
    description:$("botDescInput").value.trim(),
    systemPrompt:$("botPromptInput").value.trim(),
    enabledSkills,
    approvalMode:$("botApprovalMode").value,
    pinned: $("botPinnedInput").checked,
    pinnedAt: $("botPinnedInput").checked ? (S.editingBot?.pinnedAt || Date.now()) : null,
  };
  if (S.editingBot) {
    await window.api.bots.update(S.editingBot.id, patch);
  } else {
    const b = await window.api.bots.create(patch);
    S.botId=b.id; S.sessionId=null;
  }
  $("botModal").hidden=true;
  await loadBots(true);
  toast("已保存");
}

async function deleteBot() {
  if (!S.editingBot) return;
  if (!confirm(`删除 Bot「${S.editingBot.name}」？工作目录里的文件会保留。`)) return;
  // 删除前先把它名下还在后台跑的对话停掉，别让任务写到已删除的目录里
  for (const run of [...S.runs.values()]) {
    if (run.botId === S.editingBot.id) await window.api.agent.stop(run.runId);
  }
  await window.api.bots.remove(S.editingBot.id);
  $("botModal").hidden=true;
  S.botId=null; S.sessionId=null;
  await loadBots(true);
  toast("已删除");
}

/* ---------- 审批边界 ---------- */
const CATEGORY_NAMES = {
  exec: "执行命令",
  unknown: "未登记工具",
  script: "内联脚本",
  write: "写入文件",
  delete: "删除 / 移动",
  network: "联网 / 外发",
  secret: "读取凭据",
  system: "系统变更",
  collab: "Bot 协作",
  mcp: "MCP 工具",
  memory: "记忆变更",
};

function queueApproval(request) {
  if (S.approvalQueue.some((r) => r.id === request.id)) return;
  S.approvalQueue.push(request);
  bumpApprovalBadge();
  if (!S.currentApproval) showNextApproval();
}

function bumpApprovalBadge() {
  const b = $("approvalBadge");
  const waiting = S.approvalQueue.length + (S.currentApproval ? 1 : 0);
  b.hidden = waiting === 0;
}

function showNextApproval() {
  clearInterval(S.approvalTimer);
  const req = S.approvalQueue.shift();
  S.currentApproval = req || null;
  bumpApprovalBadge();
  if (!req) {
    $("approvalModal").hidden = true;
    return;
  }

  $("approvalWho").innerHTML = "";
  const who = document.createElement("div");
  if (req.requestedBy) {
    who.innerHTML = `<b>${esc(req.botName || "某个 Bot")}</b> 正在执行 <b>${esc(req.requestedBy)}</b> 的任务，想执行一个需要确认的操作。`;
  } else {
    who.innerHTML = `<b>${esc(req.botName || "某个 Bot")}</b> 想要执行一个需要确认的操作。`;
  }
  $("approvalWho").appendChild(who);

  const tag = CATEGORY_NAMES[req.category] || req.label || req.category;
  $("approvalTag").textContent = tag;
  const sev = $("approvalSev");
  sev.className = "approval-sev " + (req.severity || "");
  sev.textContent = req.severity === "high" ? "高风险" : req.severity === "medium" ? "中风险" : "低风险";
  $("approvalTool").textContent = req.tool || "";
  $("approvalReason").textContent = req.reason || "该操作可能改变数据或影响系统。";
  $("approvalDetail").textContent = req.detail || summarizeArgs(JSON.stringify(req.args || {}));

  const shown = S.approvalQueue.length;
  $("approvalQueue").textContent = shown ? `还有 ${shown} 个操作在排队等待确认。` : "";

  const tick = () => {
    const left = Math.max(0, Math.round(((req.expiresAt || 0) - Date.now()) / 1000));
    $("approvalCountdown").textContent = left ? `${left}s 后自动拒绝` : "正在超时…";
    if (!left) clearInterval(S.approvalTimer);
  };
  tick();
  S.approvalTimer = setInterval(tick, 1000);

  $("approvalModal").hidden = false;
  setTimeout(() => $("approvalDeny").focus(), 30);
}

async function decideApproval(decision, scope) {
  const req = S.currentApproval;
  if (!req) return;
  S.currentApproval = null;
  clearInterval(S.approvalTimer);
  $("approvalModal").hidden = true;
  bumpApprovalBadge();
  await window.api.approval.resolve(req.id, decision, scope);
  if (S.approvalQueue.length) showNextApproval();
}

/**
 * 窗口重载后，把主进程里仍在等待的审批重新弹出来。
 * fetcher 可注入，仅用于测试；生产走真实 IPC。
 */
async function restorePendingApprovals(fetcher) {
  try {
    const list = await (fetcher || (() => window.api.approval.pending()))();
    for (const req of list || []) queueApproval(req);
    return (list || []).length;
  } catch (e) {
    console.error("恢复待审批失败", e);
    return 0;
  }
}

async function openApprovalLog() {
  const r = await window.api.approval.audit(200);
  const st = r.stats || { total: 0, allowed: 0, denied: 0 };
  $("auditStats").innerHTML = "";
  for (const [label, value, cls] of [
    ["最近记录", st.total, ""],
    ["已放行", st.allowed, "allowed"],
    ["已拒绝", st.denied, "denied"],
  ]) {
    const s = document.createElement("span");
    s.textContent = `${label} ${value}`;
    if (cls) s.className = "audit-dec " + cls;
    $("auditStats").appendChild(s);
  }
  renderAudit(r.items || []);
  $("approvalLogModal").hidden = false;
}

function renderAudit(items) {
  const box = $("auditList");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<div class="muted" style="padding:16px;text-align:center">还没有记录</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "audit-row";
    const dec = document.createElement("span");
    dec.className = "audit-dec " + (it.decision === "allowed" ? "allowed" : "denied");
    dec.textContent = it.decision === "allowed" ? "放行" : "拒绝";
    const body = document.createElement("div");
    body.className = "audit-body";
    const sum = document.createElement("div");
    sum.className = "audit-sum";
    sum.textContent = it.summary || it.tool;
    const meta = document.createElement("div");
    meta.className = "audit-meta";
    const d = new Date(it.at);
    const time = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${fmtTime(it.at)}`;
    meta.textContent = [
      time,
      it.botName || "?",
      CATEGORY_NAMES[it.category] || it.category,
      it.decidedBy === "user" ? "你决定的" : it.decidedBy === "policy" ? "按策略放行" : it.decidedBy === "timeout" ? "超时拒绝" : it.decidedBy === "unattended" ? "无人值守拒绝" : it.decidedBy === "cached-deny" ? "本次运行已拒绝" : it.decidedBy === "run-allow" ? "本次运行已放行" : it.decidedBy === "session-allow" ? "本会话已放行" : it.decidedBy || "",
      it.unattended ? "无人值守" : "",
    ].filter(Boolean).join(" · ");
    body.append(sum, meta);
    row.append(dec, body);
    box.appendChild(row);
  }
}

/* ---------- 事件绑定 ---------- */
function wire() {
  $("newBotBtn").addEventListener("click",()=>openBotModal(null));
  $("botSettingsBtn").addEventListener("click",()=>{
    const b=S.bots.find(x=>x.id===S.botId);
    if (!b) return toast("先选择一个 Bot");
    openBotModal(b);
  });
  $("newSessionBtn").addEventListener("click",newSession);
  $("settingsBtn").addEventListener("click",openSettings);
  $("skillsBtn").addEventListener("click",async()=>{
    await loadSkills();
    S.currentSkill=null;
    $("skillEditor").hidden=true;
    $("skillEmpty").hidden=false;
    $("skillsModal").hidden=false;
  });
  $("closeSkills").addEventListener("click",()=>$("skillsModal").hidden=true);
  $("importSkillFolder").addEventListener("click",async()=>{
    const r = await window.api.skills.importFolder();
    if (r.ok) { await loadSkills(); toast("已导入 " + r.imported.length + " 个技能"); }
    else if (r.message) toast(r.message);
  });
  $("importSkillZip").addEventListener("click",async()=>{
    const r = await window.api.skills.importZip();
    if (r.ok) { await loadSkills(); toast("已导入 " + r.imported.length + " 个技能"); }
    else if (r.message) toast(r.message);
  });
  $("memoryBtn").addEventListener("click",openMemory);
  $("approvalBtn").addEventListener("click",openApprovalLog);
  $("closeApprovalLog").addEventListener("click",()=>$("approvalLogModal").hidden=true);
  $("clearAuditBtn").addEventListener("click",async()=>{
    if (!confirm("清空全部审批记录？")) return;
    await window.api.approval.clearAudit();
    await openApprovalLog();
  });
  $("approvalAllowOnce").addEventListener("click",()=>decideApproval("allow","once"));
  $("approvalAllowRun").addEventListener("click",()=>decideApproval("allow","run"));
  $("approvalAllowSession").addEventListener("click",()=>decideApproval("allow","session"));
  $("approvalDeny").addEventListener("click",()=>decideApproval("deny","once"));
  window.api.approval.onEvent((ev)=>{
    if (ev.type==="approval_request") queueApproval(ev.request);
    else if (ev.type==="approval_resolved" && S.currentApproval?.id===ev.id) {
      S.currentApproval=null; clearInterval(S.approvalTimer);
      $("approvalModal").hidden=true; bumpApprovalBadge();
      if (S.approvalQueue.length) showNextApproval();
    }
  });
  $("closeMemory").addEventListener("click",()=>$("memoryModal").hidden=true);
  $("addMemoryBtn").addEventListener("click",newMemory);
  $("saveMemBtn").addEventListener("click",saveMemory);
  $("cancelMemEdit").addEventListener("click",()=>$("memEditor").hidden=true);
  $("memScopeFilter").addEventListener("change",renderMemoryList);
  $("memTierFilter").addEventListener("change",renderMemoryList);
  $("memSearchInput").addEventListener("input",renderMemoryList);
  $("routinesBtn").addEventListener("click",openRoutines);
  $("closeRoutines").addEventListener("click",()=>$("routinesModal").hidden=true);
  $("addRoutineBtn").addEventListener("click",newRoutine);
  $("saveRtBtn").addEventListener("click",saveRoutine);
  $("cancelRtEdit").addEventListener("click",()=>{ $("rtEditor").hidden=true; S.editingRoutineId=null; });
  $("rtKind").addEventListener("change",syncRtFields);
  window.api.routines.onEvent((ev)=>{
    if (ev.type==="routine_started") {
      if (!$("routinesModal").hidden) {
        window.api.routines.list().then(x=>{S.routines=x; return refreshRoutineState();});
      }
      if (ev.trigger==="schedule") toast("例程「"+ev.routine.name+"」已开始后台执行");
      return;
    }
    if (ev.type==="routine_done"||ev.type==="routine_failed") {
      const stopped = ev.entry?.stopped;
      window.api.routines.list().then(x=>{S.routines=x; return refreshRoutineState();});
      const e = ev.entry || {};
      toast("例程「"+ev.routine.name+"」"+(stopped ? "已停止" : e.ok ? "完成" : e.blocked ? "受阻，待处理" : "失败")
        + (e.summary ? "：" + String(e.summary).slice(0, 80) : ""));
    }
  });
  $("mcpBtn").addEventListener("click",openMcp);
  $("closeMcp").addEventListener("click",()=>$("mcpModal").hidden=true);
  $("addMcpBtn").addEventListener("click",newMcp);
  $("saveMcpBtn").addEventListener("click",saveMcp);
  $("cancelMcpEdit").addEventListener("click",()=>$("mcpEditor").hidden=true);
  $("mcpType").addEventListener("change",(e)=>{
    const http = e.target.value === "http";
    $("mcpStdioFields").hidden = http;
    $("mcpHttpFields").hidden = !http;
  });
  $("newSkillBtn").addEventListener("click",newSkill);
  $("saveSkillBtn").addEventListener("click",saveSkill);
  $("deleteSkillBtn").addEventListener("click",deleteSkill);
  $("openSkillsDir").addEventListener("click",()=>window.api.skills.openDir(S.currentSkill?.id));
  $("closeSettings").addEventListener("click",()=>$("settingsModal").hidden=true);
  $("saveSettings").addEventListener("click",saveSettings);
  $("testBtn").addEventListener("click",testConn);
  $("fetchModels").addEventListener("click",()=>fetchModelsFromUpstream());
  // 本机浏览器：一键把它拉起来（首次人工登录一次）
  $("openBrowserBtn")?.addEventListener("click", async () => {
    const btn = $("openBrowserBtn"), out = $("browserStatus");
    btn.disabled = true; out.className = "test-result"; out.textContent = "正在启动浏览器…";
    const r = await window.api.computer.openBrowser(S.botId);
    btn.disabled = false;
    if (r.ok) {
      out.className = "test-result ok";
      out.textContent = `浏览器已启动${r.status?.external ? "（接管已有）" : ""}，端口 ${r.status?.port ?? "?"}`;
      toast("浏览器已打开，第一次请在里面登录一次 TikTok");
    } else {
      out.className = "test-result err";
      out.textContent = r.message || "启动失败";
    }
  });
  // 改完地址/密钥后自动拉一次（防抖），失焦时若参数变了也补拉
  let modelFetchTimer=null;
  const scheduleModelFetch=()=>{
    clearTimeout(modelFetchTimer);
    modelFetchTimer=setTimeout(async()=>{
      const baseUrl=$("baseUrl").value.trim(), apiKey=$("apiKey").value.trim();
      if (!baseUrl) return;
      // 这组参数刚拉过（无论成败）就不再重复打扰上游；手动点「从上游拉取」仍可强制重试
      if (modelAttemptKey === connKey(baseUrl, apiKey)) return;
      await fetchModelsFromUpstream({ silent:true });
    }, 600);
  };
  $("baseUrl").addEventListener("input",scheduleModelFetch);
  $("apiKey").addEventListener("input",scheduleModelFetch);
  $("baseUrl").addEventListener("blur",scheduleModelFetch);
  $("apiKey").addEventListener("blur",scheduleModelFetch);

  // 模型下拉：点箭头/输入框都能看到完整候选，输入即筛选
  $("modelToggle").addEventListener("click",()=>{
    $("modelPop").hidden ? openSettingsModelPop() : closeSettingsModelPop();
  });
  $("modelInput").addEventListener("click",()=>openSettingsModelPop(false));
  $("modelInput").addEventListener("input",()=>{
    if ($("modelPop").hidden) { $("modelPop").hidden=false; $("modelCombo").classList.add("open"); }
    renderSettingsModelList($("modelInput").value);
  });
  $("modelFilter").addEventListener("input",(e)=>renderSettingsModelList(e.target.value));
  $("modelFilter").addEventListener("keydown",(e)=>{
    if (e.key==="Enter") {
      e.preventDefault();
      const first=$("modelList2").querySelector(".combo-item");
      if (first) first.click();
    }
  });
  $("revealData").addEventListener("click",()=>window.api.settings.reveal());
  $("closeBotModal").addEventListener("click",()=>$("botModal").hidden=true);
  $("cancelBotModal").addEventListener("click",()=>$("botModal").hidden=true);
  $("saveBotBtn").addEventListener("click",saveBot);
  $("deleteBotBtn").addEventListener("click",deleteBot);
  $("pickWorkspace").addEventListener("click",async()=>{
    if (!S.editingBot) return toast("先保存 Bot，再选目录");
    const b=await window.api.bots.pickWorkspace(S.editingBot.id);
    if (b) $("botWorkspaceInput").value=b.workspace;
  });
  E.modelChip.addEventListener("click",openModelPicker);
  E.approvalChip.addEventListener("click",openSettings);
  $("modelSearch").addEventListener("input",(e)=>renderModelList(e.target.value));
  $("refreshModels").addEventListener("click",refreshModels);

  $("computerKind").addEventListener("change",(e)=>{ $("remoteFields").hidden = e.target.value!=="remote"; });
  E.sendBtn.addEventListener("click",send);
  E.input.addEventListener("input",()=>{autoGrow(); syncComposer(); mention.active=0; showMention();});
  E.input.addEventListener("blur",()=>{ setTimeout(hideMention,0); });
  E.input.addEventListener("keydown",(e)=>{
    // 补全面板打开时，方向键 / Tab / Enter / Esc 都先归补全用
    if (mentionOpen()) {
      if (e.key==="ArrowDown") { e.preventDefault(); mention.active=(mention.active+1)%mention.items.length; renderMentionActive(); return; }
      if (e.key==="ArrowUp")   { e.preventDefault(); mention.active=(mention.active-1+mention.items.length)%mention.items.length; renderMentionActive(); return; }
      if (e.key==="Tab" || (e.key==="Enter" && !e.shiftKey && !e.isComposing)) { e.preventDefault(); applyMention(); return; }
      if (e.key==="Escape")    { e.preventDefault(); hideMention(); return; }
    }
    if (e.key==="Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // 这段对话还在跑：Enter 不该顺手把任务停掉（停止要点按钮），只提示一下
      if (currentRun()) { toast("这段对话还在工作中，先点右边的停止再发"); return; }
      send();
    }
  });

  document.querySelectorAll(".starter").forEach(b=>b.addEventListener("click",()=>{
    E.input.value=b.dataset.prompt||""; autoGrow(); syncComposer(); E.input.focus();
  }));

  document.addEventListener("click",(e)=>{
    const p=$("modelPicker");
    if (!p.hidden && !p.contains(e.target) && e.target!==E.modelChip) p.hidden=true;
    // 设置里的模型下拉：点外面就收起
    const mp=$("modelPop");
    if (mp && !mp.hidden && !$("modelCombo").contains(e.target)) closeSettingsModelPop();
  });
  document.addEventListener("keydown",(e)=>{
    if (e.key==="Escape") {
      if(!$("modelPop").hidden){closeSettingsModelPop();return;}
      if(!$("modelPicker").hidden){$("modelPicker").hidden=true;return;}
      if(!$("settingsModal").hidden){$("settingsModal").hidden=true;return;}
      if(!$("botModal").hidden){$("botModal").hidden=true;return;}
      if(!$("skillsModal").hidden){$("skillsModal").hidden=true;return;}
      if(!$("mcpModal").hidden){$("mcpModal").hidden=true;return;}
      if(!$("routinesModal").hidden){$("routinesModal").hidden=true;return;}
      if(!$("memoryModal").hidden){$("memoryModal").hidden=true;return;}
      if(!$("approvalLogModal").hidden){$("approvalLogModal").hidden=true;return;}
      // 审批弹窗不允许用 Esc 关掉：必须明确选择「拒绝」或「允许」
      if(!$("approvalModal").hidden) return;
    }
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="n") { e.preventDefault(); newSession(); }
  });
  window.api.onThemeChanged((t)=>{E.body.dataset.theme=t==="light"?"light":"dark";});
}

/* ---------- 启动 ---------- */
async function init() {
  S.settings = await window.api.settings.get();
  E.body.dataset.theme = S.settings.ui?.theme==="light"?"light":"dark";
  S.tools = await window.api.tools.list();
  await loadSkills();
  const tl=$("toolList");
  tl.innerHTML="";
  for (const t of S.tools) {
    const tag=document.createElement("span"); tag.className="tool-tag"; tag.textContent=t.name; tag.title=t.description;
    tl.appendChild(tag);
  }
  wire();
  // 窗口刷新后把仍在等待的审批重新弹出来，否则只能干等超时
  await restorePendingApprovals();
  await loadBots(true);
  await refreshComputer();
  await refreshModels().catch(()=>{});
  window.api.model.test().then(r=>{ S.connected=!!r.ok; updateChrome(); }).catch(()=>{});
}

init().catch(e=>console.error(e));
