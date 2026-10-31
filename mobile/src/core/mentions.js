// 解析输入文本里的 `@技能名` 引用。与桌面版一致。

function isWordChar(ch) {
  if (!ch) return false;
  return /[0-9A-Za-z_\-\u4e00-\u9fff]/.test(ch);
}

function canStartMention(prev) {
  if (!prev) return true;
  if (prev === "/" || prev === "\\" || prev === "@") return false;
  return !/[0-9A-Za-z_\-]/.test(prev);
}

function canEndMention(next) {
  return !isWordChar(next);
}

export function parseSkillMentions(text, skills) {
  const src = String(text == null ? "" : text);
  const list = Array.isArray(skills) ? skills : [];
  const lower = src.toLowerCase();

  const candidates = [];
  for (const s of list) {
    for (const key of [s.name, s.id]) {
      if (typeof key === "string" && key.trim()) candidates.push({ key, skill: s });
    }
  }
  candidates.sort((a, b) => b.key.length - a.key.length);

  const hits = [];
  const missing = [];
  const seenIds = new Set();
  const seenMissing = new Set();
  const spans = [];

  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "@") continue;
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
        hits.push({ id: cand.skill.id, name: cand.skill.name, start: i, end, matchedText: src.slice(i, end) });
      }
      i = end - 1;
      continue;
    }

    let j = afterAt;
    while (j < src.length && isWordChar(src[j])) j++;
    if (j > afterAt) {
      const name = src.slice(afterAt, j);
      if (!seenMissing.has(name)) {
        seenMissing.add(name);
        missing.push(name);
      }
      spans.push([i, j]);
      i = j - 1;
    }
  }

  return { hits, missing, rest: stripSpans(src, spans) };
}

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
