"use strict";
/**
 * 本机计算机路径策略自检（纯本地，不启动应用）
 *   node scripts/verify-path-sandbox.js
 *
 * 覆盖用户报的问题：技能装在 <userData>/skills，而 Bot 工作区是别的目录，
 * list_files / read_file 读技能文件被「拒绝访问工作目录之外的路径」。
 *
 * 期望：
 * 1. 工作目录内：读写都允许
 * 2. 技能目录：读允许（list/read），写拒绝
 * 3. 应用数据目录下的 screenshots：读允许
 * 4. 工作区之外、又不在白名单里的路径：读也拒绝，且错误里列出允许目录
 * 5. 用 ".." 想越界：拒绝
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LocalComputer } = require(path.join(__dirname, "..", "app/src/main/computer/local-computer"));

let fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-path-"));
  const userData = path.join(tmp, "Grok Bot");
  const workspace = path.join(tmp, "workspace");
  const skillDir = path.join(userData, "skills", "demo-skill");
  const shots = path.join(userData, "screenshots");
  const outside = path.join(tmp, "outside");
  for (const d of [workspace, path.join(skillDir, "scripts"), shots, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\n---\n# demo\n");
  fs.writeFileSync(path.join(skillDir, "scripts", "run.mjs"), "console.log(1)\n");
  fs.writeFileSync(path.join(shots, "shot-1.png"), "x");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");

  const c = new LocalComputer({ id: "t", rootDir: workspace, userDataDir: userData });

  console.log("\n[1] 工作目录内：读写都允许");
  await c.writeFile("a.txt", "hello");
  ok("写工作目录", fs.existsSync(path.join(workspace, "a.txt")));
  ok("读工作目录", (await c.readFile("a.txt")).includes("hello"));
  ok("列工作目录", (await c.listFiles(".")).includes("a.txt"));

  console.log("\n[2] 技能目录：读允许、写拒绝");
  const absSkill = path.join(skillDir, "SKILL.md");
  const skillText = await c.readFile(absSkill);
  ok("read_file 读技能 SKILL.md（绝对路径）", /# demo/.test(skillText), JSON.stringify(skillText.slice(0, 30)));
  const ls = await c.listFiles(skillDir);
  ok("list_files 列技能目录", /SKILL\.md/.test(ls) && /scripts/.test(ls));
  const wErr = await throws(() => c.writeFile(path.join(skillDir, "hack.txt"), "x"));
  ok("写技能目录被拒绝", Boolean(wErr), wErr ? String(wErr.message).split("\n")[0] : "竟然成功了");

  console.log("\n[3] 截图目录：读允许");
  const pngRead = await c.readFile(path.join(shots, "shot-1.png"));
  ok("读 screenshots 下的截图", pngRead !== null);
  ok("图片文件给出「无法查看」提示而非乱码", /图片文件|二进制/.test(pngRead) && /browser_snapshot/.test(pngRead));

  console.log("\n[4] 白名单之外：读也拒绝，且列出允许目录");
  const oErr = await throws(() => c.readFile(path.join(outside, "secret.txt")));
  ok("读白名单外被拒绝", Boolean(oErr));
  ok("错误里列出允许目录", oErr && /允许的目录/.test(oErr.message) && oErr.message.includes(workspace), oErr ? oErr.message.split("\n")[1] : "");
  ok("错误里给出 use_skill 提示", oErr && /use_skill/.test(oErr.message));

  console.log("\n[5] 用 .. 越界：拒绝");
  const dotErr = await throws(() => c.readFile("../../outside/secret.txt"));
  ok(".. 越界被拒绝", Boolean(dotErr));

  console.log("\n[6] 工作目录内的 .. 仍算越界（不能靠 .. 逃出根）");
  const inner = await throws(() => c.readFile("../workspace/a.txt"));
  // ../workspace/a.txt 解析后仍在 workspace 内，属于允许；这里只验证不会误报
  ok(".. 解析后仍在根内的可读", inner === null);

  console.log("\n[7] cmd 风格 %VAR% 自动展开（%APPDATA% 在 PowerShell 里不展开）");
  process.env.GROKBOT_PATH_TEST = "expanded-value";
  const echo = await c.exec("echo %GROKBOT_PATH_TEST%");
  ok("命令里的 %VAR% 被展开", echo.code === 0 && /expanded-value/.test(echo.stdout), JSON.stringify(echo.stdout.trim()));
  delete process.env.GROKBOT_PATH_TEST;

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* ignore */ }

  console.log(fail === 0 ? "\n✓ 路径策略自检通过\n" : `\n✗ ${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
