// 为一个 Bot 组装运行上下文（技能过滤 / MCP 过滤 / 留言 / 记忆）。

import { parseSkillMentions } from "./mentions";

export function visibleSkills(skillStore, bot) {
  const all = skillStore.list();
  const enabled = Array.isArray(bot.enabledSkills) ? bot.enabledSkills : null;
  return enabled && enabled.length ? all.filter((s) => enabled.includes(s.id)) : all;
}

export function resolveForcedSkills(skillStore, bot, text) {
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

export function visibleMcpTools(mcpManager, bot) {
  const all = mcpManager.allTools();
  const allowed = Array.isArray(bot.enabledMcp) && bot.enabledMcp.length ? new Set(bot.enabledMcp) : null;
  if (!allowed) return all;
  return all.filter((t) => {
    const m = /^mcp__([^_].*?)__/.exec(t.name);
    return m && allowed.has(m[1]);
  });
}

export function buildAgentContext(deps, bot, extra = {}) {
  const { skillStore, mcpManager, memoryStore } = deps;
  const skills = visibleSkills(skillStore, bot);
  const memoryBlock = memoryStore ? memoryStore.profileBlock(bot.id) : "";
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
    forcedSkills: mentions.skills,
    mentionMissing: mentions.missing,
    mcpTools: visibleMcpTools(mcpManager, bot),
    mcpCall: (name, args) => mcpManager.handleCall(name, args),
    listBots: () => deps.store.listBots().filter((b) => b.id !== bot.id),
    remember: memoryStore ? (input) => memoryStore.write({ ...input, botId: bot.id, source: extra.source || "user" }) : undefined,
    recall: memoryStore ? (query, opts) => memoryStore.search(bot.id, query, opts) : undefined,
    forget: memoryStore
      ? (id) => {
          if (memoryStore.remove("bot", bot.id, id)) return true;
          return memoryStore.remove("user", null, id);
        }
      : undefined,
  };
}

export function renderForcedSkills(skills, missing) {
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
