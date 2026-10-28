"use strict";

/**
 * 为一个 Bot 组装运行上下文。
 *
 * 把「技能过滤 / MCP 过滤 / 留言读取」这些重复逻辑收敛到一处，
 * 交互对话、委派、群聊、定时例程都复用同一份实现。
 */

const { parseSkillMentions } = require("./mentions");

function visibleSkills(skillStore, bot) {
  const all = skillStore.list();
  const enabled = Array.isArray(bot.enabledSkills) ? bot.enabledSkills : null;
  return enabled && enabled.length ? all.filter((s) => enabled.includes(s.id)) : all;
}

/**
 * 解析文本里的 `@技能名`，并把正文一起读出来。
 *
 * 注意：这里对着 `skillStore.list()` 的全集匹配，而不是 Bot 的可见列表 ——
 * 用户显式 @ 的技能即便没在该 Bot 的启用清单里，也应该被加载（用户意图优先），
 * 只是要在提示里注明「该技能不在本 Bot 启用列表内」。
 *
 * @returns {{ hits, missing, rest, skills: Array<{id,name,description,body,enabled}> }}
 */
function resolveForcedSkills(skillStore, bot, text) {
  const all = skillStore ? skillStore.list() : [];
  const enabled = Array.isArray(bot?.enabledSkills) ? bot.enabledSkills : null;
  const isEnabled = (id) => !enabled || !enabled.length || enabled.includes(id);

  const { hits, missing, rest } = parseSkillMentions(text, all);
  const skills = [];
  for (const h of hits) {
    const full = skillStore.read(h.id);
    if (!full) continue;
    skills.push({
      id: full.id,
      name: full.name,
      description: full.description || "",
      body: full.body || "",
      enabled: isEnabled(full.id),
    });
  }
  return { hits, missing, rest, skills };
}

function visibleMcpTools(mcpManager, bot) {
  const all = mcpManager.allTools();
  const allowed =
    Array.isArray(bot.enabledMcp) && bot.enabledMcp.length ? new Set(bot.enabledMcp) : null;
  if (!allowed) return all;
  return all.filter((t) => {
    const m = /^mcp__([^_].*?)__/.exec(t.name);
    return m && allowed.has(m[1]);
  });
}

/**
 * @param {object} deps { skillStore, mcpManager, store }
 * @param {object} bot
 * @param {object} [extra] 额外上下文（如收件箱文本、事件发送器）
 */
function buildAgentContext(deps, bot, extra = {}) {
  const { skillStore, mcpManager, memoryStore } = deps;
  const skills = visibleSkills(skillStore, bot);

  // 长期记忆：profile 层注入提示，log 层靠 recall 检索
  const memoryBlock = memoryStore ? memoryStore.profileBlock(bot.id) : "";

  // 用户用 @ 指定的技能：跨入口统一解析，强制加载正文
  const mentions = extra.text
    ? resolveForcedSkills(skillStore, bot, extra.text)
    : { hits: [], missing: [], rest: extra.text || "", skills: [] };

  return {
    systemPrompt: (bot.systemPrompt || "") + memoryBlock + (extra.appendToPrompt || ""),
    listSkills: () => skills,
    readSkill: (name) => {
      const hit = skills.find((s) => s.id === name || s.name === name);
      return hit ? skillStore.read(hit.id) : null;
    },
    // 供 runAgent 强制注入正文（不塞进 systemPrompt，保持单一职责、便于测试）
    forcedSkills: mentions.skills,
    mentionMissing: mentions.missing,
    mcpTools: visibleMcpTools(mcpManager, bot),
    mcpCall: (name, args) => mcpManager.handleCall(name, args),
    listBots: () => deps.store.listBots().filter((b) => b.id !== bot.id),
    remember: memoryStore
      ? (input) => memoryStore.write({ ...input, botId: bot.id, source: extra.source || "user" })
      : undefined,
    recall: memoryStore
      ? (query, opts) => memoryStore.search(bot.id, query, opts)
      : undefined,
    forget: memoryStore
      ? (id) => {
          // 两个作用域都试一次
          if (memoryStore.remove("bot", bot.id, id)) return true;
          return memoryStore.remove("user", null, id);
        }
      : undefined,
  };
}

/**
 * 把被 @ 的技能渲染成一段强制指令，拼进系统提示。
 * 没指定技能时返回空串。
 */
function renderForcedSkills(skills, missing) {
  const list = Array.isArray(skills) ? skills : [];
  const miss = Array.isArray(missing) ? missing : [];
  if (!list.length && !miss.length) return "";
  const parts = ["", "## 本次已强制加载的技能（用户用 @ 指定）"];
  if (list.length) {
    parts.push("以下是用户明确指定的技能，**必须严格按其步骤执行**，不要跳过、不要自行替换流程：");
    for (const s of list) {
      const offNote = s.enabled ? "" : "（该技能未在本 Bot 的启用列表里，但因用户 @ 指定而加载）";
      parts.push(`\n### ${s.name}${offNote}\n${s.body}`);
    }
  }
  if (miss.length) {
    parts.push(`\n注意：以下 @ 名称没有匹配到任何技能，已忽略：${miss.map((m) => "@" + m).join("、")}`);
  }
  return parts.join("\n");
}

module.exports = {
  buildAgentContext,
  visibleSkills,
  visibleMcpTools,
  resolveForcedSkills,
  renderForcedSkills,
};
