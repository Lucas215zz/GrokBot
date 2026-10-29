"use strict";

/**
 * 打包 Grok Bot 为独立应用。
 * 复用已安装的 Electron 运行时，把我们的 app.asar 装进去。
 *
 *   node scripts/build-app.js            构建到 dist/app
 *   node scripts/build-app.js --install  构建并安装到 %LOCALAPPDATA%\Programs\GrokBot
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const appDir = path.join(root, "app");
const distDir = path.join(root, "dist");
const runtimeSrc = process.env.GROKBOT_RUNTIME || "D:\\Program Files\\grokbot\\Grok Bot";
const installDir = path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs", "GrokBot");

function log(m) {
  console.log("[build] " + m);
}

function packAsar() {
  const out = path.join(distDir, "app.asar");
  fs.mkdirSync(distDir, { recursive: true });
  if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  execFileSync("npx", ["--yes", "@electron/asar@4.3.0", "pack", appDir, out], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: root,
  });
  log("app.asar " + (fs.statSync(out).size / 1024).toFixed(0) + " KB");
  return out;
}

function writeFuse(exe) {
  const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!fs.existsSync(npxCli)) throw new Error("找不到 npx-cli.js");
  execFileSync(
    process.execPath,
    [npxCli, "--yes", "@electron/fuses@1.8.0", "write", "--app", exe, "EnableEmbeddedAsarIntegrityValidation=off"],
    { stdio: "inherit" },
  );
}

function build(targetDir) {
  if (!fs.existsSync(path.join(runtimeSrc, "Grok Bot.exe"))) {
    throw new Error("找不到 Electron 运行时：" + runtimeSrc + "（可用 GROKBOT_RUNTIME 指定）");
  }
  const asar = packAsar();
  const res = path.join(targetDir, "resources");
  const official = path.join(res, "app.asar");
  const targetExe = path.join(targetDir, "Grok Bot.exe");

  // 目标已存在时「就地覆盖 asar」，不删除整个 targetDir。
  // 某些机器上 dist/app/resources/app.asar 会被残留进程占着 delete 句柄
  // （文件本身可写，但 unlink/rename 会被拒），整体 rm/cp 会把 dist 删一半。
  if (fs.existsSync(targetExe)) {
    log("目标已存在，就地覆盖 asar → " + official);
    fs.mkdirSync(path.dirname(official), { recursive: true });
    fs.copyFileSync(asar, official); // copyFileSync 会 truncate 写入，不受 unlink 限制
    writeFuse(targetExe);
    log("完成：" + targetDir);
    return targetDir;
  }

  log("复制运行时 → " + targetDir);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(runtimeSrc, targetDir, {
    recursive: true,
    // 源目录里可能残留历史备份，不复制进产物
    filter: (src) => !/[\\/]app\.asar\.original$/.test(src),
  });

  // 只保留一份官方备份；重复构建时不覆盖、不堆积 48.9 MB 副本
  const backup = path.join(res, "official.asar.bak");
  if (fs.existsSync(official) && !fs.existsSync(backup)) {
    fs.renameSync(official, backup);
  } else if (fs.existsSync(official)) {
    fs.rmSync(official, { force: true });
  }
  fs.copyFileSync(asar, path.join(res, "app.asar"));

  writeFuse(targetExe);
  log("完成：" + targetDir);
  return targetDir;
}

const wantInstall = process.argv.includes("--install");
const out = build(wantInstall ? installDir : path.join(distDir, "app"));
if (wantInstall) {
  log("安装位置：" + out);
  log("可执行文件：" + path.join(out, "Grok Bot.exe"));
}
