"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const exe = path.resolve(__dirname, "..", "dist", "app", "Grok Bot.exe");
// 端口可被环境变量覆盖：9333 常被本机 Chrome 的调试端口占用（踩过），默认改用 9360
const PORT = Number(process.env.GROKBOT_CDP_PORT || 9360);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      const list = await res.json();
      // 只认我们这个应用自己的页面（file:// 加载的渲染层），
      // 防止端口恰好被别的浏览器占用时连错目标
      const page = list.find((t) => t.type === "page" && /^file:/.test(t.url || ""));
      if (page) return page;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error("CDP 未就绪");
}

function attach(ws) {
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, events };
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error("找不到 " + exe);
  // 用独立的临时 userData，避免读到本机真实配置（例如用户把审批调成了 relaxed，
  // 让「默认策略 balanced」这条断言误报）
  const userDataDir = path.join(os.tmpdir(), "grokbot-smoke-" + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  // 预置一条例程，便于验证「后台执行」相关界面（提示文案 / 立即运行按钮）
  fs.writeFileSync(path.join(userDataDir, "routines.json"), JSON.stringify({
    routines: [{
      id: "rt-smoke", botId: "bot-smoke", name: "冒烟例程", prompt: "随便说一句",
      schedule: { kind: "interval", minutes: 60 }, enabled: true, allowRisky: false,
      createdAt: Date.now(), updatedAt: Date.now(), lastRunAt: null,
      nextRunAt: Date.now() + 3600e3, logs: [],
    }],
  }, null, 2));
  const child = spawn(exe, ["--remote-debugging-port=" + PORT, "--user-data-dir=" + userDataDir], { stdio: "ignore" });

  let failures = 0;
  const ok = (name, cond, extra) => {
    console.log("  " + (cond ? "✓" : "✗") + " " + name + (extra ? "  " + extra : ""));
    if (!cond) failures++;
  };

  try {
    const target = await findPage();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const { send, evaluate, events } = attach(ws);
    await send("Runtime.enable");
    await send("Log.enable");
    await sleep(2600);

    console.log("\n[界面冒烟]");
    ok("标题正确", (await evaluate("document.title")) === "Grok Bot");

    // 长对话不能把输入框挤出视口（曾经因 flex min-height:auto 踩过）
    await evaluate(
      // 空会话时 .messages 因 :empty 规则 display:none，先恢复成可见（真实场景里必然有消息）
      "(()=>{const m=document.getElementById('messages');m.style.display='';const d=document.createElement('div');d.style.height='3000px';m.appendChild(d);m.scrollTop=0;})()",
    );
    const composerBox = await evaluate(
      "(()=>{const r=document.querySelector('.composer').getBoundingClientRect();return JSON.stringify({top:Math.round(r.top),bottom:Math.round(r.bottom),vh:innerHeight});})()",
    );
    const cb = JSON.parse(composerBox);
    ok("长内容下输入框仍在视口内", cb.bottom <= cb.vh && cb.top >= 0 && cb.bottom - cb.top > 20, composerBox);
    ok("消息区自身滚动而不是撑开整页", await evaluate("(()=>{const m=document.getElementById('messages');const a=document.querySelector('.app');return m.scrollHeight>m.clientHeight && a.scrollHeight<=a.clientHeight+1;})()"));
    await evaluate("(()=>{const m=document.getElementById('messages');m.lastElementChild.remove();m.scrollTop=m.scrollHeight;})()");

    const errors = events.filter(
      (e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error"),
    );
    ok("渲染层无 JS 异常", errors.length === 0, errors.length ? JSON.stringify(errors[0]).slice(0, 400) : "");

    ok("preload 暴露 approval API", await evaluate("typeof window.api.approval.resolve === 'function'"));
    ok("审批按钮存在", await evaluate("!!document.getElementById('approvalBtn')"));
    ok("审批弹窗默认隐藏", await evaluate("document.getElementById('approvalModal').hidden === true"));
    ok("审计面板存在", await evaluate("!!document.getElementById('approvalLogModal')"));
    const chipText = await evaluate("document.getElementById('approvalChip').textContent");
    ok("顶栏审批徽章已渲染", /标准|严格|宽松|关闭/.test(chipText || ""), JSON.stringify(chipText));
    ok("设置内有 4 档策略", await evaluate("document.querySelectorAll('#approvalMode option').length === 4"));
    ok("Bot 内有 5 档策略", await evaluate("document.querySelectorAll('#botApprovalMode option').length === 5"));
    ok("例程有允许危险操作开关", await evaluate("!!document.getElementById('rtAllowRisky')"));

    // ---- 例程：必须是后台执行（不能有「运行中…」卡死的老毛病） ----
    ok("例程接口暴露 stop/running", await evaluate(
      "typeof window.api.routines.stop === 'function' && typeof window.api.routines.running === 'function'"
    ));
    await evaluate("openRoutines()");
    await sleep(400);
    ok("例程列表已渲染", (await evaluate("document.querySelectorAll('#rtList .rt-row').length")) === 1);
    ok("例程弹窗有后台执行提示", /后台运行/.test(await evaluate("document.querySelector('#routinesModal .field-hint')?.textContent || ''")));
    ok("例程按钮是「立即运行」", (await evaluate("document.querySelector('#rtList .rt-row .rt-act button').textContent")) === "立即运行");
    // 运行态快照来自主进程：伪造一个运行中的 id，列表应变成「停止」+ 提示可关窗口
    await evaluate("window.gbState.routineRunning = { 'rt-smoke': { startedAt: Date.now(), trigger: 'manual' } }; window.renderRoutineList()");
    ok("运行中按钮变「停止」", (await evaluate("document.querySelector('#rtList .rt-row .rt-act button').textContent")) === "停止");
    ok("运行中提示可以关窗口", /可以关窗口/.test(await evaluate("document.querySelectorAll('#rtList .rt-row .rt-d')[0].textContent")));
    ok("运行中显示「后台运行中」", /后台运行中/.test(await evaluate("document.querySelector('#rtList .rt-row .rt-n').textContent")));
    await evaluate("window.gbState.routineRunning = {}; window.renderRoutineList()");
    await evaluate("document.getElementById('routinesModal').hidden = true");

    // ---- 设置面板：从上游拉取模型 ----
    ok("设置内有「从上游拉取」按钮", await evaluate("!!document.getElementById('fetchModels')"));
    ok("模型字段是可输入的 input", await evaluate("document.getElementById('modelInput').tagName === 'INPUT'"));
    ok("模型下拉面板存在", await evaluate("!!document.getElementById('modelPop')"));
    ok("模型下拉默认收起", await evaluate("document.getElementById('modelPop').hidden === true"));

    // 点一下箭头就要能看见全部候选（datalist 在 Electron 里不点不弹，这是用户踩的坑）
    await evaluate("window.openSettings()");
    await evaluate("window.gbState.models = ['deepseek-v4-pro','glm-5.3','kimi-k2.8-preview']");
    await evaluate("document.getElementById('modelToggle').click()");
    ok("点箭头后下拉展开", (await evaluate("document.getElementById('modelPop').hidden")) === false);
    ok("下拉里列出候选", (await evaluate("document.querySelectorAll('#modelList2 .combo-item').length")) === 3);
    await evaluate("[...document.querySelectorAll('#modelList2 .combo-item')].find(b=>b.textContent==='glm-5.3').click()");
    ok("点候选会填进输入框", (await evaluate("document.getElementById('modelInput').value")) === "glm-5.3");
    ok("选中后下拉收起", (await evaluate("document.getElementById('modelPop').hidden")) === true);
    // 输入即筛选
    await evaluate("document.getElementById('modelToggle').click()");
    await evaluate("(()=>{const f=document.getElementById('modelFilter');f.value='kimi';f.dispatchEvent(new Event('input',{bubbles:true}));})()");
    ok("筛选框能过滤候选", (await evaluate("document.querySelectorAll('#modelList2 .combo-item').length")) === 1);
    await evaluate("document.getElementById('settingsModal').hidden = true");

    // 拉取结果要能填进 datalist
    const optCount = await evaluate("(window.fillModelOptions(['mock-a','mock-b','mock-c']), document.querySelectorAll('#modelOptions option').length)");
    ok("拉取结果能填入 datalist", optCount === 3, String(optCount));

    // 自动挑默认模型：应跳过 embedding，优先 deepseek/grok
    const picked = await evaluate("window.pickDefaultModel(['text-embedding-3-small','glm-5.1','deepseek-v4-pro'])");
    ok("自动挑默认跳过 embedding", picked === "deepseek-v4-pro", JSON.stringify(picked));
    const picked2 = await evaluate("window.pickDefaultModel(['text-embedding-3-small','glm-5.1'])");
    ok("无对话模型时也能兜底", picked2 === "glm-5.1", JSON.stringify(picked2));

    // 关键：override 必须真的生效。指向一个必然连不上的地址，
    // 如果主进程忽略 override 用了已保存地址，就会返回 ok:true 而判失败。
    const badConn = await evaluate("window.api.model.list({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x' })");
    ok("拉取支持未保存的临时 baseUrl", badConn && badConn.ok === false && !!badConn.message, JSON.stringify(badConn).slice(0, 160));

    // 空地址要直接报错，而不是回落到已保存配置
    await evaluate("document.getElementById('baseUrl').value=''");
    const emptyConn = await evaluate("window.fetchModelsFromUpstream({silent:true})");
    ok("空地址不静默回落到旧配置", emptyConn && emptyConn.ok === false && /地址/.test(emptyConn.message || ""), JSON.stringify(emptyConn));

    const policy = await evaluate("window.api.approval.policy()");
    ok("默认策略 balanced", policy.mode === "balanced", JSON.stringify(policy));

    // ---- @ 技能补全 ----
    ok("补全面板存在", await evaluate("!!document.getElementById('mentionPop')"));
    ok("补全面板默认隐藏", (await evaluate("document.getElementById('mentionPop').hidden")) === true);
    const mentionRes = await evaluate(`(() => {
      const S = window.gbState;
      const saved = S.skills;
      S.skills = [
        { id: 'git-commit', name: '规范提交', description: '提交信息规范' },
        { id: 'write-daily-report', name: '写日报', description: '生成日报' },
        { id: 'tiktok-store-information', name: 'tiktok-store-information', description: 'TikTok 店铺' },
      ];
      const el = document.getElementById('input');
      const out = {};
      // 输入 @ 应弹出候选
      el.value = '@';
      el.setSelectionRange(1, 1);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      out.openAtEmpty = document.getElementById('mentionPop').hidden === false;
      out.countAll = document.querySelectorAll('#mentionList .mention-item').length;
      // 输入中文前缀应过滤
      el.value = '@写';
      el.setSelectionRange(2, 2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      out.countDaily = document.querySelectorAll('#mentionList .mention-item').length;
      out.firstName = document.querySelector('#mentionList .mention-item .m-name')?.textContent || '';
      // 应用第一个候选
      applyMention(0);
      out.afterApply = el.value;
      out.caret = el.selectionStart;
      out.closedAfterApply = document.getElementById('mentionPop').hidden === true;
      // 邮箱里的 @ 不该弹
      el.value = 'abc@qq.com';
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      out.emailNoPop = document.getElementById('mentionPop').hidden === true;
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      S.skills = saved;
      return out;
    })()`);
    ok("输入 @ 就弹出候选", mentionRes.openAtEmpty === true, JSON.stringify(mentionRes));
    ok("列出全部候选", mentionRes.countAll === 3, String(mentionRes.countAll));
    ok("按前缀过滤候选", mentionRes.countDaily === 1, String(mentionRes.countDaily));
    ok("候选名带 @", mentionRes.firstName === "@写日报", JSON.stringify(mentionRes.firstName));
    ok("选中后填入 @技能名", mentionRes.afterApply === "@写日报 ", JSON.stringify(mentionRes.afterApply));
    ok("选中后光标落在名字后", mentionRes.caret === 5, String(mentionRes.caret));
    ok("选中后补全面板收起", mentionRes.closedAfterApply === true);
    ok("邮箱里的 @ 不弹补全", mentionRes.emailNoPop === true);

    // 「已加载技能」轨迹项能正确渲染（skill_loaded 事件走的就是这个分支）
    const skillItemRes = await evaluate(`(() => {
      const S = window.gbState;
      const saved = { botId:S.botId, sessionId:S.sessionId, sessions:S.sessions, messages:S.messages };
      S.botId='b-sk'; S.sessionId='s-sk'; S.sessions=[{id:'s-sk',title:'技能'}]; S.messages=[];
      S.runs.set('b-sk:s-sk',{runId:'r-sk',botId:'b-sk',sessionId:'s-sk',text:'t',startAt:Date.now(),
        acc:'',items:[{kind:'skill',name:'已加载技能',args:'@写日报',output:'本次将严格按该技能步骤执行',state:'ok'}],
        liveWrap:null,assistantNode:null,assistantEl:null,toolEls:new Map(),off:null,stopped:false});
      renderMessages();
      const el = document.querySelector('#messages .live .tool');
      const out = { has: !!el, name: el?.querySelector('.tool-name')?.textContent || '', state: el?.dataset.state || '' };
      S.runs.delete('b-sk:s-sk');
      S.botId=saved.botId; S.sessionId=saved.sessionId; S.sessions=saved.sessions; S.messages=saved.messages;
      renderMessages();
      return out;
    })()`);
    ok("已加载技能轨迹能渲染", skillItemRes.has && skillItemRes.name === "已加载技能" && skillItemRes.state === "ok", JSON.stringify(skillItemRes));

    // ---- Bot 置顶：渲染顺序 + 图钉按钮 ----
    const pinRes = await evaluate(`(() => {
      const S = window.gbState;
      const saved = { bots: S.bots, botId: S.botId };
      S.bots = [
        { id: 'b3', name: '普通3', emoji: '🤖', color: '#6b4eff', description: '', pinned: false },
        { id: 'b1', name: '置顶1', emoji: '🤖', color: '#35d07f', description: '', pinned: true, pinnedAt: Date.now() },
        { id: 'b2', name: '普通2', emoji: '🤖', color: '#ffb020', description: '', pinned: false },
      ];
      S.botId = 'b1';
      renderBots();
      const rows = [...document.querySelectorAll('#botList .bot-row')];
      const out = {
        order: rows.map(r => r.querySelector('.bot-t span:last-child')?.textContent || ''),
        pinBtns: document.querySelectorAll('#botList .bot-pin').length,
        pinnedOn: document.querySelectorAll('#botList .bot-pin.on').length,
        firstRowPinned: rows[0]?.classList.contains('pinned') || false,
        firstActive: rows[0]?.classList.contains('active') || false,
      };
      S.bots = saved.bots; S.botId = saved.botId; renderBots();
      return out;
    })()`);
    ok("每个 Bot 都有置顶按钮", pinRes.pinBtns === 3, String(pinRes.pinBtns));
    ok("已置顶的 Bot 显示为已固定态", pinRes.pinnedOn === 1, String(pinRes.pinnedOn));
    ok("置顶的 Bot 排在最前", pinRes.order[0] === "置顶1", JSON.stringify(pinRes.order));
    ok("置顶行带 pinned 样式", pinRes.firstRowPinned === true);
    ok("当前选中的置顶行仍是 active", pinRes.firstActive === true);

    // ---- 后台运行：切走不阻断、侧栏有标记、切回来能看到实时内容 ----
    const bg = await evaluate(`(() => {
      const S = window.gbState;
      const saved = { botId:S.botId, sessionId:S.sessionId, sessions:S.sessions, messages:S.messages };
      S.botId='b-bg'; S.sessionId='s-bg';
      S.sessions=[{id:'s-bg',title:'跑着的对话'},{id:'s-other',title:'别的对话'}];
      S.messages=[{role:'user',content:'跑个任务',at:Date.now()}];
      S.runs.set('b-bg:s-bg',{runId:'run-bg',botId:'b-bg',sessionId:'s-bg',text:'t',startAt:Date.now(),
        acc:'正在干活',items:[{kind:'tool',callId:'c1',name:'run_command',args:{command:'Get-ChildItem'},output:'a.txt',state:'ok'}],
        liveWrap:null,assistantNode:null,assistantEl:null,toolEls:new Map(),off:null,stopped:false});
      renderMessages(); renderSessions(); syncComposer();
      const out = {};
      out.live = !!document.querySelector('#messages .live');
      out.text = document.querySelector('#messages .live .content')?.textContent || '';
      out.toolState = document.querySelector('#messages .live .tool')?.dataset.state || '';
      out.dot = document.querySelectorAll('#sessionList .run-dot').length;
      out.status = document.getElementById('statusLine').textContent;
      out.sendBusy = document.getElementById('sendBtn').classList.contains('busy');
      S.sessionId='s-other'; renderMessages(); renderSessions();
      out.stillRunning = S.runs.has('b-bg:s-bg');
      out.otherEmpty = !document.querySelector('#messages .live');
      S.sessionId='s-bg'; renderMessages();
      out.backLive = !!document.querySelector('#messages .live');
      out.backText = document.querySelector('#messages .live .content')?.textContent || '';
      S.runs.delete('b-bg:s-bg');
      S.botId=saved.botId; S.sessionId=saved.sessionId; S.sessions=saved.sessions; S.messages=saved.messages;
      renderMessages(); renderSessions();
      return out;
    })()`);
    ok("运行中实时区已渲染", bg.live === true, JSON.stringify(bg));
    ok("实时文本可见", /正在干活/.test(bg.text || ""), JSON.stringify(bg.text));
    ok("工具轨迹状态为已完成", bg.toolState === "ok", bg.toolState);
    ok("侧栏会话显示运行小圆点", bg.dot === 1, String(bg.dot));
    ok("状态行提示可切走", /工作中/.test(bg.status || ""), JSON.stringify(bg.status));
    ok("发送按钮变为停止态", bg.sendBusy === true);
    ok("切到别的对话不打断运行", bg.stillRunning === true && bg.otherEmpty === true);
    ok("切回来能看到实时文本", bg.backLive === true && /正在干活/.test(bg.backText || ""), JSON.stringify(bg.backText));

    const audit = await evaluate("window.api.approval.audit(10)");
    ok("审计接口可用", Array.isArray(audit.items));

    // 「刷新后恢复待审批」：接口要在，且没待审批时要返回空数组（不能抛）
    ok("pending 接口可用", await evaluate("typeof window.api.approval.pending === 'function'"));
    const pending0 = await evaluate("window.api.approval.pending()");
    ok("无待审批时返回数组", Array.isArray(pending0), JSON.stringify(pending0));

    await evaluate("document.getElementById('approvalBtn').click()");
    await sleep(500);
    ok("点击后审计面板打开", (await evaluate("document.getElementById('approvalLogModal').hidden")) === false);
    ok("统计区已填充", (await evaluate("document.getElementById('auditStats').textContent")).indexOf("最近记录") >= 0);

    // 关掉审计面板，直接驱动渲染层的审批队列（app.js 是普通脚本，函数挂在 window 上）
    await evaluate("document.getElementById('approvalLogModal').hidden = true");
    await evaluate(`window.queueApproval({
      id: "smoke-1", runId: "smoke-run", botName: "冒烟 Bot",
      requestedBy: "父 Bot 的委派", tool: "run_command",
      category: "delete", label: "删除 / 移动", severity: "high",
      reason: "这条命令会删除、移动或重命名文件，可能丢数据",
      detail: "Remove-Item note.txt -Force",
      args: { command: "Remove-Item note.txt -Force" },
      expiresAt: Date.now() + 60000
    })`);
    await sleep(300);

    // 通过主进程真实通道投递（更贴近实际）
    const shown = await evaluate("document.getElementById('approvalModal').hidden === false");
    ok("审批请求能弹出窗口", shown);
    if (shown) {
      ok("弹窗显示 Bot 名", (await evaluate("document.getElementById('approvalWho').textContent")).indexOf("冒烟 Bot") >= 0);
      ok("弹窗显示委派来源", (await evaluate("document.getElementById('approvalWho').textContent")).indexOf("父 Bot") >= 0);
      ok("弹窗显示命令内容", (await evaluate("document.getElementById('approvalDetail').textContent")).indexOf("Remove-Item") >= 0);
      ok("显示高风险标签", (await evaluate("document.getElementById('approvalSev').textContent")).indexOf("高") >= 0);
      const countdown = await evaluate("document.getElementById('approvalCountdown').textContent");
      ok("有倒计时", /\d+s 后自动拒绝/.test(countdown || ""), JSON.stringify(countdown));
      ok("四个按钮齐全", (await evaluate(
        "['approvalAllowOnce','approvalAllowRun','approvalAllowSession','approvalDeny'].every(id => !!document.getElementById(id))"
      )));
      // 拒绝它（对应的 promise 不存在，接口应返回 false 而不是崩）
      await evaluate("document.getElementById('approvalDeny').click()");
      await sleep(200);
      ok("点拒绝后弹窗关闭", await evaluate("document.getElementById('approvalModal').hidden === true"));
    }

    // 重载：init() 里会调 approval.pending 把挂起的审批重新弹出来，不能报错
    const beforeReload = events.length;
    await send("Page.enable");
    await send("Page.reload", { ignoreCache: true });
    await sleep(3000);
    const reloadErrors = events
      .slice(beforeReload)
      .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error"));
    ok("重载后无 JS 异常", reloadErrors.length === 0, reloadErrors.length ? JSON.stringify(reloadErrors[0]).slice(0, 400) : "");
    ok("重载后审批弹窗仍默认隐藏", (await evaluate("document.getElementById('approvalModal').hidden")) === true);

    // 真正恢复：把 approval.pending 打桩成返回一条挂起请求，调用真实的恢复函数，
    // 确认窗口重载后待审批会被重新弹出来（这是原来未覆盖的路径）
    // window.api 是 contextBridge 冻结对象，不能打桩；restorePendingApprovals 支持注入 fetcher
    const restored = await evaluate(`window.restorePendingApprovals(async () => [{
      id: "smoke-restore", runId: "smoke-run-2", botName: "恢复 Bot",
      tool: "run_command", category: "network", label: "联网 / 外发", severity: "high",
      reason: "重载后恢复", detail: "curl -X POST https://x.dev -d @a.json",
      args: { command: "curl -X POST https://x.dev -d @a.json" },
      expiresAt: Date.now() + 60000
    }])`);
    ok("恢复函数拿到 1 条待审批", restored === 1, JSON.stringify(restored));
    await sleep(300);
    ok("恢复的审批能弹出", (await evaluate("document.getElementById('approvalModal').hidden")) === false);
    ok("恢复的审批显示 Bot 名", (await evaluate("document.getElementById('approvalWho').textContent")).indexOf("恢复 Bot") >= 0);
    await evaluate("document.getElementById('approvalDeny').click()");
    await sleep(200);
    ok("处理完恢复的审批后弹窗关闭", (await evaluate("document.getElementById('approvalModal').hidden")) === true);

    ws.close();
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? "\n✓ 冒烟通过\n" : "\n✗ " + failures + " 项失败\n");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
