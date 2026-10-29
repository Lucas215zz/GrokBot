"use strict";

/**
 * 技能 frontmatter 解析回归。
 * 目标：从 Codex 原样导入的多行 description / 嵌套 metadata 也能被正确读取，
 * 且简单的 key: value 旧格式继续工作，保存后再读回不丢信息。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SkillStore, parseFrontmatter } = require("../app/src/main/skills/skill-store.js");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  console.log("  " + (cond ? "✓" : "✗") + " " + name + (extra ? "  " + extra : ""));
  if (cond) pass++;
  else fail++;
};
const eq = (name, actual, expected, extra) =>
  ok(name, actual === expected, extra || (actual === expected ? "" : "got=" + JSON.stringify(actual) + " want=" + JSON.stringify(expected)));

console.log("\n[1] 块标量 |（字面，多行）");
{
  const t = ["---", "name: demo", "description: |", "  第一行", "  第二行", "   第三行带缩进", "metadata:", "  short-description: 简版", "---", "", "# 正文", "内容"].join("\n");
  const { meta, body } = parseFrontmatter(t);
  eq("name", meta.name, "demo");
  eq("description 换行保留", meta.description, "第一行\n第二行\n 第三行带缩进");
  eq("metadata 是对象", typeof meta.metadata, "object");
  eq("metadata.short-description", meta.metadata && meta.metadata["short-description"], "简版");
  eq("body 未被 metadata 污染", body.replace(/^\s*\n/, ""), "# 正文\n内容");
}

console.log("\n[2] 折叠标量 >（折成空格）");
{
  const t = ["---", "name: x", "description: >", "  aaa", "  bbb", "", "  ccc", "---", "", "body"].join("\n");
  const { meta } = parseFrontmatter(t);
  eq("折叠成一空格分段", meta.description, "aaa bbb\nccc");
}

console.log("\n[3] 引号与行内注释");
{
  const t = ["---", 'name: "带 冒号: 的名字"', "description: 正常描述 # 这是注释", "q2: '单引号 it''s ok'", "---", "", "b"].join("\n");
  const { meta } = parseFrontmatter(t);
  eq("双引号去引号", meta.name, "带 冒号: 的名字");
  eq("行内注释被去掉", meta.description, "正常描述");
  eq("单引号转义", meta.q2, "单引号 it's ok");
}

console.log("\n[4] CRLF + BOM + 末尾无换行");
{
  const t = "\uFEFF---\r\nname: crlf\r\ndescription: 一行\r\n---\r\n\r\n# 正文\r\n结尾";
  const { meta, body } = parseFrontmatter(t);
  eq("CRLF name", meta.name, "crlf");
  eq("CRLF description", meta.description, "一行");
  ok("body 含正文", body.includes("# 正文") && body.includes("结尾"));
}

console.log("\n[5] 正文里的 --- 不当作 frontmatter 结束（只看首个块）");
{
  const t = ["---", "name: n", "description: d", "---", "# 标题", "", "分隔线：", "---", "后面内容"].join("\n");
  const { meta, body } = parseFrontmatter(t);
  eq("name", meta.name, "n");
  ok("body 保留正文里的 ---", body.includes("分隔线：") && body.includes("---"));
}

console.log("\n[6] 无 frontmatter 时整体当正文");
{
  const { meta, body } = parseFrontmatter("# 只有正文\n没有头部");
  eq("meta 空", Object.keys(meta).length, 0);
  ok("body 原样", body.startsWith("# 只有正文"));
}

console.log("\n[7] 真实 Codex 技能原文（未改写的源目录）");
{
  const srcDir = "C:/Users/phlus/.codex/skills";
  const cases = [
    { id: "munger-perspective", mustMeta: "short-description" },
    { id: "sun-yuchen-perspective", mustMeta: "short-description" },
    { id: "creatorpicks-batch-upload-products", mustMeta: "short-description" },
    { id: "creatorpicks-batch-add-brands" },
  ];
  for (const c of cases) {
    const f = path.join(srcDir, c.id, "SKILL.md");
    if (!fs.existsSync(f)) {
      ok("源技能存在：" + c.id, false, "文件缺失（跳过）");
      continue;
    }
    const { meta, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    ok(c.id + ": name 正确", meta.name === c.id, "name=" + meta.name);
    ok(c.id + ": description 非空且多行被完整保留", typeof meta.description === "string" && meta.description.length > 30, "len=" + String(meta.description || "").length);
    ok(c.id + ": 顶层 description 没有吞掉 metadata", !/^\s*short-description:/m.test(String(meta.description || "")));
    ok(c.id + ": body 以 # 开头", /^#\s/m.test(body));
    if (c.mustMeta) {
      ok(c.id + ": metadata." + c.mustMeta + " 解析成功", !!(meta.metadata && meta.metadata[c.mustMeta]), JSON.stringify(meta.metadata && meta.metadata[c.mustMeta]));
    }
  }
}

console.log("\n[8] 保存往返（save -> read）保留嵌套 metadata 与多行描述");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-fm-"));
  const store = new SkillStore(tmp);
  const longDesc = "第一段描述。\n第二段描述，含 : 冒号与 # 井号。";
  store.save("rt", { name: "往返", description: longDesc, body: "# 正文\n\n步骤" });

  const file = path.join(tmp, "skills", "rt", "SKILL.md");
  let txt = fs.readFileSync(file, "utf8");
  txt = txt.replace(/\n---\n/, "\nmetadata:\n  short-description: 简短\n  author: 某人\n---\n");
  fs.writeFileSync(file, txt, "utf8");

  const got = store.read("rt");
  eq("往返 name", got.name, "往返");
  eq("往返 description 多行保留", got.description, longDesc);
  ok("往返 metadata 保留", !!(got.meta.metadata && got.meta.metadata["short-description"] === "简短"), JSON.stringify(got.meta.metadata));

  store.save("rt", { name: "往返2", description: longDesc, body: "# 正文\n\n步骤改" });
  const got2 = store.read("rt");
  eq("二次保存 name", got2.name, "往返2");
  ok("二次保存后 metadata 仍在", !!(got2.meta.metadata && got2.meta.metadata.author === "某人"), JSON.stringify(got2.meta.metadata));

  const listed = store.list().find((s) => s.id === "rt");
  ok("list() 描述压成单行", listed && !listed.description.includes("\n") && listed.description.length > 10, JSON.stringify(listed && listed.description));

  // read() 应带上技能内文件清单（供 use_skill 直接告知模型，避免用 list_files 猜路径）
  fs.mkdirSync(path.join(tmp, "skills", "rt", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "skills", "rt", "scripts", "run.mjs"), "console.log(1)\n");
  const withFiles = store.read("rt");
  ok("read() 带文件清单", Array.isArray(withFiles.files) && withFiles.files.includes("SKILL.md") && withFiles.files.includes("scripts/run.mjs"), JSON.stringify(withFiles.files));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n[9] 旧格式向后兼容（key: value 单行）");
{
  const t = "---\nname: 规范提交\ndescription: 需要提交 git 改动时使用。\n---\n\n# 正文";
  const { meta } = parseFrontmatter(t);
  eq("旧格式 name", meta.name, "规范提交");
  eq("旧格式 description", meta.description, "需要提交 git 改动时使用。");
}

console.log("\n[10] 现有已装技能仍可被 SkillStore 列出");
{
  const dataDir = path.join(process.env.APPDATA || "", "Grok Bot");
  if (fs.existsSync(path.join(dataDir, "skills"))) {
    const store = new SkillStore(dataDir);
    const list = store.list();
    ok("列出技能非空", list.length >= 3, "count=" + list.length);
    ok("每条都有 name", list.every((s) => s.name && s.name.length > 0));
    ok("每条 description 都是单行", list.every((s) => !String(s.description).includes("\n")));
  } else {
    ok("跳过（无数据目录）", true);
  }
}

console.log("\n" + (fail === 0 ? "✓ 全部通过" : "✗ 有失败") + "：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
