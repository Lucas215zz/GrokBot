"use strict";

/**
 * 解析输入文本里的 `@技能名` 引用。
 *
 * 设计目标：
 *   - 用户不必等模型自己「猜」该不该用某个技能，打 `@技能名` 就是明确指定；
 *   - 支持中文名（`@写日报`）与英文/带连字符名（`@tiktok-store-information`）；
 *   - 大小写不敏感；长名优先，避免 `@a` 抢先吃掉 `@abc`；
 *   - 同一个技能被 @ 多次只算一次；
 *   - 不认识的名字不算报错，收进 missing 由调用方提示。
 *
 * 返回 { hits, missing, rest }：
 *   hits:    [{ id, name, start, end, matchedText }]，按在文本中出现的顺序
 *   missing: ["xxx"]（打了 @ 但没有对应技能的名字，去重）
 *   rest:    去掉已识别 `@名字` 之后的正文（空白做了收敛）
 */

// 组成「技能名」的字符：ASCII 字母 / 数字 / 下划线 / 连字符 / 中文
function isWordChar(ch) {
  if (!ch) return false;
  return /[0-9A-Za-z_\-\u4e00-\u9fff]/.test(ch);
}

/**
 * `@` 前允许出现的字符。
 * 只拦「ASCII 字母/数字/下划线/连字符」紧贴在前的情况（`abc@qq.com` 这类邮箱），
 * 中文紧贴（`用@写日报`）和跟在 `/` `\` `@` 后面则不允许（保护 URL / 路径 / 连续 @）。
 */
function canStartMention(prev) {
  if (!prev) return true;
  if (prev === "/" || prev === "\\" || prev === "@") return false;
  return !/[0-9A-Za-z_\-]/.test(prev);
}

/** `@名字` 之后允许的字符：行尾、空白、标点，不能再接名字字符（防前缀误吞） */
function canEndMention(next) {
  return !isWordChar(next);
}

function parseSkillMentions(text, skills) {
  const src = String(text == null ? "" : text);
  const list = Array.isArray(skills) ? skills : [];
  const lower = src.toLowerCase();

  // 候选：每个技能可被 id 或 name 两种写法引用
  const candidates = [];
  for (const s of list) {
    for (const key of [s.name, s.id]) {
      if (typeof key === "string" && key.trim()) candidates.push({ key, skill: s });
    }
  }
  // 长名优先：先尝试更长的写法，命中后跳过该区间
  candidates.sort((a, b) => b.key.length - a.key.length);

  const hits = [];
  const missing = [];
  const seenIds = new Set();
  const seenMissing = new Set();
  const spans = [];

  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "@") continue;
    // 紧跟在上一段已识别引用之后（`@a@b`）也算合法起点
    const afterPrevMention = spans.length > 0 && spans[spans.length - 1][1] === i;
    if (!afterPrevMention && !canStartMention(src[i - 1])) continue;

    const afterAt = i + 1;
    let matched = null;
    for (const c of candidates) {
      if (!lower.startsWith(c.key.toLowerCase(), afterAt)) continue;
      const end = afterAt + c.key.length;
      if (!canEndMention(src[end])) continue;
      matched = { cand: c, end };
      break;
    }

    if (matched) {
      const { cand, end } = matched;
      spans.push([i, end]);
      if (!seenIds.has(cand.skill.id)) {
        seenIds.add(cand.skill.id);
        hits.push({
          id: cand.skill.id,
          name: cand.skill.name,
          start: i,
          end,
          matchedText: src.slice(i, end),
        });
      }
      i = end - 1; // 跳过已消费的区间
      continue;
    }

    // 没匹配到技能：把 @ 后面连续的名字字符当作「缺失的技能名」
    let j = afterAt;
    while (j < src.length && isWordChar(src[j])) j++;
    if (j > afterAt) {
      const name = src.slice(afterAt, j);
      if (!seenMissing.has(name)) {
        seenMissing.add(name);
        missing.push(name);
      }
      // 缺失的名字也算消费掉，rest 里不再保留
      spans.push([i, j]);
      i = j - 1;
    }
  }

  return { hits, missing, rest: stripSpans(src, spans) };
}

/** 从原文里挖掉若干 [start,end) 区间，并把留下的多余空白收敛成单空格 */
function stripSpans(src, spans) {
  if (!spans.length) return src;
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    out += src.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  out += src.slice(cursor);
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { parseSkillMentions, isWordChar, canStartMention, canEndMention };
