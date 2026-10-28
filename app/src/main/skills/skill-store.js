"use strict";

/**
 * 技能（Skill）存储。
 *
 * 布局（与 Codex 的 skill 格式保持兼容）：
 *   <dataDir>/skills/<skill-name>/SKILL.md
 *
 * SKILL.md 结构：
 *   ---
 *   name: 技能名
 *   description: 什么时候该用它（模型靠这句话判断是否加载）
 *   ---
 *   正文：具体步骤、命令、注意事项
 *
 * 另外支持 scripts/ 子目录放辅助脚本。
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * YAML frontmatter 解析（Codex 兼容子集）。
 *
 * 支持：
 *   - key: value 普通标量
 *   - 单 / 双引号字符串（去引号；双引号内支持 \n \r \t \" \\ 转义）
 *   - 块标量：key: | / |- / |+ / > / >- / >+（字面 / 折叠）
 *   - 嵌套映射：metadata:\n  short-description: ...
 *   - 行内注释：# 之后（引号内与块内容除外）
 *   - CRLF / 末尾无换行 / BOM
 * 解析结果是嵌套对象；顶层 name / description 一定是字符串。
 * 这样从 Codex 原样导入的多行 description / metadata 也能被正确读取，无需预先改写。
 */
function parseFrontmatter(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(src);
  if (!m) return { meta: {}, body: src, raw: "" };
  const fmText = m[1];
  const body = m[2] == null ? "" : m[2];
  return { meta: parseYamlMapping(fmText), body, raw: fmText };
}

function indentWidth(line) {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** 去掉引号外的行内注释并裁剪首尾空白 */
function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function unquote(value) {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      const inner = value.slice(1, -1);
      if (q === '"') {
        return inner.replace(/\\(["\\nrt])/g, (_all, ch) =>
          ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch,
        );
      }
      return inner.replace(/''/g, "'");
    }
  }
  return value;
}

/** 解析一段 YAML 映射（行数组），按缩进递归 */
function parseYamlMapping(fmText) {
  const lines = fmText.split(/\r?\n/);
  let i = 0;

  function parseBlock(minIndent) {
    const obj = {};
    while (i < lines.length) {
      const line = lines[i];
      if (isBlankOrComment(line)) { i++; continue; }
      const ind = indentWidth(line);
      if (ind < minIndent) break;
      const content = line.slice(ind);
      // 只认 key: 形式；块内容由 readBlockScalar 消费，嵌套由递归消费
      const km = /^([A-Za-z0-9_.\-\/]+)[ \t]*:[ \t]*(.*)$/.exec(content);
      if (!km) { i++; continue; }
      const key = km[1];
      const rest = km[2];
      i++;

      // 块标量
      const bm = /^([|>])([+-]?)[ \t]*(?:#.*)?$/.exec(rest.trim());
      if (bm) {
        obj[key] = readBlockScalar(bm[1], bm[2], ind);
        continue;
      }

      const scalar = stripInlineComment(rest);
      if (scalar === "") {
        // 可能是嵌套映射（后续有效行缩进更深）
        let j = i;
        while (j < lines.length && isBlankOrComment(lines[j])) j++;
        const nextInd = j < lines.length ? indentWidth(lines[j]) : -1;
        obj[key] = nextInd > ind ? parseBlock(nextInd) : "";
      } else {
        obj[key] = unquote(scalar);
      }
    }
    return obj;
  }

  function readBlockScalar(style, chomp, keyIndent) {
    const collected = [];
    let blockIndent = null;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") { collected.push(""); i++; continue; }
      const ind = indentWidth(line);
      if (ind <= keyIndent) break;
      if (blockIndent === null) blockIndent = ind;
      collected.push(ind >= blockIndent ? line.slice(blockIndent) : line.slice(ind));
      i++;
    }
    let text;
    if (style === "|") {
      text = collected.join("\n");
    } else {
      // 折叠：普通换行折成空格，空行保留为换行
      const parts = [];
      for (const ln of collected) {
        if (ln === "") parts.push("\n");
        else {
          if (parts.length && parts[parts.length - 1] !== "\n") parts.push(" ");
          parts.push(ln);
        }
      }
      text = parts.join("");
    }
    if (chomp !== "+") text = text.replace(/\n+$/, "");
    return text;
  }

  return parseBlock(0);
}

/** 把可能多行的文本压成单行（用于系统提示里的简介） */
function collapseYamlText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/** 序列化标量：含换行用块标量，含特殊字符用引号 */
function serializeScalar(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes("\n")) {
    return "|\n" + s.split("\n").map((l) => "  " + l).join("\n");
  }
  if (s === "" || /^\s|\s$/.test(s) || /[:#]/.test(s) || /^[|>&*!%@`"'\[\]{}]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** 把（可能嵌套的）对象序列化成 YAML 文本 */
function serializeYaml(obj, indent) {
  const pad = " ".repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = /^[A-Za-z0-9_.\-\/]+$/.test(k) ? k : JSON.stringify(k);
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      out.push(`${pad}${key}:`);
      out.push(serializeYaml(v, indent + 2));
    } else {
      out.push(`${pad}${key}: ${serializeScalar(v)}`);
    }
  }
  return out.join("\n");
}

class SkillStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "skills");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 列出所有技能（只读元数据，不读正文） */
  list() {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(this.dir, e.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      try {
        const raw = fs.readFileSync(file, "utf8");
        const { meta } = parseFrontmatter(raw);
        const metaObj = meta && typeof meta === "object" ? meta : {};
        out.push({
          id: e.name,
          name: typeof metaObj.name === "string" && metaObj.name ? metaObj.name : e.name,
          description: collapseYamlText(metaObj.description),
          dir: path.join(this.dir, e.name),
          hasScripts: fs.existsSync(path.join(this.dir, e.name, "scripts")),
        });
      } catch {
        /* 跳过损坏的技能 */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 读取某个技能的完整内容 */
  read(id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) return null;
    const file = path.join(this.dir, id, "SKILL.md");
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const metaObj = meta && typeof meta === "object" ? meta : {};
    return {
      id,
      name: typeof metaObj.name === "string" && metaObj.name ? metaObj.name : id,
      description: typeof metaObj.description === "string" ? metaObj.description : collapseYamlText(metaObj.description),
      body,
      dir: path.join(this.dir, id),
      hasScripts: fs.existsSync(path.join(this.dir, id, "scripts")),
      meta: metaObj, // 保留原始嵌套元数据（metadata 等），供界面查看
    };
  }

  /** 新建/更新技能 */
  save(id, { name, description, body }) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("技能名只能包含字母、数字、点、下划线、短横线");
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    // 保留导入时已有的嵌套 metadata（若本次保存没有清掉），再写入 name/description。
    // UI 只编辑 name/description/body，其它 frontmatter 字段读回后原样保留。
    const file = path.join(dir, "SKILL.md");
    let existingMeta = {};
    if (fs.existsSync(file)) {
      try {
        existingMeta = parseFrontmatter(fs.readFileSync(file, "utf8")).meta || {};
      } catch {
        existingMeta = {};
      }
    }
    const metaObj = Object.assign({}, existingMeta, {
      name: name || id,
      description: description || "",
    });
    const content = ["---", serializeYaml(metaObj, 0), "---", "", body || ""].join("\n");
    fs.writeFileSync(file, content, "utf8");
    return this.read(id);
  }

  remove(id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) return false;
    const dir = path.join(this.dir, id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  scriptsDir(id) {
    return path.join(this.dir, id, "scripts");
  }

  /**
   * 从文件夹导入技能。
   * 支持两种结构：
   *   <目录>/SKILL.md            → 目录名作为技能 id
   *   <目录>/<name>/SKILL.md     → 批量导入子目录
   */
  importFolder(folderPath) {
    const imported = [];
    const root = path.resolve(folderPath);
    if (!fs.existsSync(root)) throw new Error("目录不存在");

    const hasOwn = fs.existsSync(path.join(root, "SKILL.md"));
    const targets = hasOwn
      ? [root]
      : fs
          .readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "SKILL.md")))
          .map((e) => path.join(root, e.name));

    if (!targets.length) throw new Error("没找到 SKILL.md");

    for (const src of targets) {
      const id = sanitizeId(path.basename(src));
      const dst = path.join(this.dir, id);
      fs.cpSync(src, dst, { recursive: true });
      imported.push(this.read(id));
    }
    return imported.filter(Boolean);
  }

  /** 从 .zip 导入（依赖系统解压能力） */
  async importZip(zipPath, extractTo) {
    const fsPath = path.resolve(zipPath);
    if (!fs.existsSync(fsPath)) throw new Error("文件不存在");
    const target = extractTo || path.join(this.dir, ".import-" + Date.now());
    fs.mkdirSync(target, { recursive: true });

    try {
      const { execFileSync } = require("node:child_process");
      if (process.platform === "win32") {
        execFileSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `Expand-Archive -LiteralPath '${fsPath.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`,
        ], { stdio: "pipe" });
      } else {
        execFileSync("unzip", ["-o", fsPath, "-d", target], { stdio: "pipe" });
      }
    } catch (error) {
      throw new Error(`解压失败：${error.message}`);
    }

    const result = this.importFolder(target);
    fs.rmSync(target, { recursive: true, force: true });
    return result;
  }
}

function sanitizeId(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

module.exports = { SkillStore, parseFrontmatter };
