"use strict";

/**
 * 回归：@技能名 直接调用。
 *
 * 覆盖：
 *   1) 解析器：中文名 / 英文名 / 大小写 / 长名优先 / 连续 @ / 缺失 / 正文保留
 *   2) resolveForcedSkills：读正文、Bot 未启用也加载
 *   3) runAgent：强制正文真的进入系统提示；缺技能时给出提示
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseSkillMentions } = require("../app/src/main/agent/mentions");
const { resolveForcedSkills, renderForcedSkills } = require("../app/src/main/agent/context");
const { runAgent } = require("../app/src/main/agent/loop");
const { SkillStore } = require("../app/src/main/skills/skill-store");

let failures = 0;
let total = 0;
function ok(name, cond, extra) {
  total++;
  console.log("  " + (cond ? "✓" : "✗") + " " + name + (extra && !cond ? "  → " + extra : ""));
  if (!cond) failures++;
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, "实际 " + a + "，期望 " + e);
}

const SKILLS = [
  { id: "git-commit", name: "规范提交", description: "提交信息规范" },
  { id: "write-daily-report", name: "写日报", description: "生成日报" },
  { id: "huashu-flash-master", name: "huashu-flash", description: "画说" },
  { id: "tiktok-store-information", name: "tiktok-store-information", description: "TikTok 店铺" },
  { id: "creatorpicks-batch-upload-products", name: "creatorpicks-batch-upload-products", description: "批量上传" },
  { id: "short", name: "creatorpicks", description: "短名，用于长名优先测试" },
];

function ids(r) {
  return r.hits.map((h) => h.id);
}

console.log("\n[1] 解析器：基本命中");
{
  const r = parseSkillMentions("@写日报", SKILLS);
  eq("中文名命中", ids(r), ["write-daily-report"]);
  eq("正文为空", r.rest, "");
}
{
  const r = parseSkillMentions("用@规范提交 把改动提一下", SKILLS);
  eq("中文紧贴 @ 也能识别", ids(r), ["git-commit"]);
  eq("正文保留（剥掉 @名）", r.rest, "用 把改动提一下");
}
{
  const r = parseSkillMentions("@tiktok-store-information 采集", SKILLS);
  eq("英文 id 命中", ids(r), ["tiktok-store-information"]);
}
{
  const r = parseSkillMentions("@TikTok-Store-Information 采集", SKILLS);
  eq("大小写不敏感", ids(r), ["tiktok-store-information"]);
}
{
  const r = parseSkillMentions("@huashu-flash 讲讲", SKILLS);
  eq("name 与 id 不同也能按 name 命中", ids(r), ["huashu-flash-master"]);
}

console.log("\n[2] 解析器：长名优先 / 多个 / 缺失");
{
  const r = parseSkillMentions("@creatorpicks-batch-upload-products", SKILLS);
  eq("长名优先（不吃成 @creatorpicks）", ids(r), ["creatorpicks-batch-upload-products"]);
}
{
  const r = parseSkillMentions("@creatorpicks 看看", SKILLS);
  eq("短名单独出现时命中短名", ids(r), ["short"]);
}
{
  const r = parseSkillMentions("@写日报@规范提交 一起做", SKILLS);
  eq("连续 @a@b 两条都解析", ids(r), ["write-daily-report", "git-commit"]);
}
{
  const r = parseSkillMentions("@写日报 @写日报 @规范提交", SKILLS);
  eq("重复 @ 同一技能只算一次", ids(r), ["write-daily-report", "git-commit"]);
}
{
  const r = parseSkillMentions("@不存在的技能 你好 @也缺", SKILLS);
  eq("不存在的技能不崩，进 missing", r.missing, ["不存在的技能", "也缺"]);
  eq("缺失时没有命中", ids(r), []);
}

console.log("\n[3] 解析器：不该误伤的场景");
{
  const r = parseSkillMentions("发到 abc@qq.com 吧", SKILLS);
  eq("邮箱里的 @ 不算技能引用", ids(r), []);
  eq("邮箱场景 missing 为空", r.missing, []);
}
{
  const r = parseSkillMentions("看 https://x.com/@写日报", SKILLS);
  eq("URL 里的 @ 不算引用", ids(r), []);
}
{
  const r = parseSkillMentions("普通文字没有艾特", SKILLS);
  eq("没有 @ 时 rest 原样保留", r.rest, "普通文字没有艾特");
}

console.log("\n[4] resolveForcedSkills：读正文 + 未启用也加载");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mention-"));
const store = new SkillStore(tmp);
store.save("demo-skill", { name: "演示技能", description: "用于测试", body: "第一步：做事。\n第二步：汇报。" });
store.save("other-skill", { name: "别的技能", description: "", body: "别的正文" });
{
  const botAll = { id: "b1", enabledSkills: [] };
  const r = resolveForcedSkills(store, botAll, "@演示技能 开始");
  ok("读到正文", r.skills.length === 1 && r.skills[0].body.includes("第一步：做事"));
  ok("enabled=true（Bot 未限制）", r.skills[0].enabled === true);
}
{
  const botLimited = { id: "b2", enabledSkills: ["other-skill"] };
  const r = resolveForcedSkills(store, botLimited, "@演示技能 开始");
  ok("未被 Bot 启用但仍加载", r.skills.length === 1 && r.skills[0].id === "demo-skill");
  ok("enabled=false 被标记", r.skills[0].enabled === false);
  const block = renderForcedSkills(r.skills, r.missing);
  ok("提示里注明未启用", block.includes("未在本 Bot 的启用列表里"));
  ok("提示里含正文", block.includes("第一步：做事"));
}

console.log("\n[5] runAgent：强制正文真的进系统提示");
(async () => {
  let capturedPrompt = "";
  const client = {
    stream: async ({ systemPrompt }) => {
      capturedPrompt = systemPrompt;
      return { text: "好的", toolCalls: [], model: "mock", usage: {} };
    },
  };
  const events = [];
  const r = resolveForcedSkills(store, { id: "b1", enabledSkills: [] }, "@演示技能");
  const res = await runAgent({
    client,
    history: [{ role: "user", content: "@演示技能" }],
    systemPrompt: "你是测试 Bot。",
    forcedSkills: r.skills,
    mentionMissing: r.missing,
    emit: (ev) => events.push(ev),
    tools: [],
  });
  ok("运行完成", res.text === "好的");
  ok("系统提示含强制技能标题", capturedPrompt.includes("本次已强制加载的技能"));
  ok("系统提示含技能正文", capturedPrompt.includes("第二步：汇报"));
  ok("发出了 skill_loaded 事件", events.some((e) => e.type === "skill_loaded" && e.skills[0].name === "演示技能"));

  capturedPrompt = "";
  await runAgent({
    client,
    history: [{ role: "user", content: "普通消息" }],
    systemPrompt: "你是测试 Bot。",
    forcedSkills: [],
    emit: () => {},
    tools: [],
  });
  ok("没有 @ 时不注入强制段", !capturedPrompt.includes("本次已强制加载的技能"));

  capturedPrompt = "";
  await runAgent({
    client,
    history: [{ role: "user", content: "@没有这个" }],
    systemPrompt: "x",
    forcedSkills: [],
    mentionMissing: ["没有这个"],
    emit: () => {},
    tools: [],
  });
  ok("缺失技能在提示里提示已忽略", capturedPrompt.includes("没有匹配到任何技能"));


console.log("\n[6] buildAgentContext：入口只要传 text 就自动解析");
{
  const { buildAgentContext } = require("../app/src/main/agent/context");
  const deps = {
    skillStore: store,
    mcpManager: { allTools: () => [], handleCall: () => "" },
    store: { listBots: () => [] },
    memoryStore: null,
  };
  const ctx = buildAgentContext(deps, { id: "b9", enabledSkills: [], systemPrompt: "S" }, { text: "@演示技能 干活" });
  ok("调用入口传 text 即得到 forcedSkills", ctx.forcedSkills.length === 1 && ctx.forcedSkills[0].id === "demo-skill");
  const ctx2 = buildAgentContext(deps, { id: "b9", enabledSkills: [], systemPrompt: "S" }, {});
  ok("不传 text 时没有 forcedSkills", ctx2.forcedSkills.length === 0);
}
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n" + (failures ? `✗ ${failures} 项失败` : "✓ 全部通过") + `（共 ${total} 项）`);
  process.exit(failures ? 1 : 0);
})();



