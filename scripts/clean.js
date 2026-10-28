"use strict";
/**
 * 清理构建残留。
 * Windows 上 build/app.asar 有时被系统索引/杀软短暂占用，导致删除失败。
 *   node scripts/clean.js
 *   node scripts/clean.js --force   被占用时重试几次
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const force = process.argv.includes("--force");
const targets = ["build", ".dev", "dist/app.asar", "dist/out.log", "dist/err.log", "dist/o.log", "dist/e.log"];

let freed = 0;
let busy = [];

for (const rel of targets) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const size = sizeOf(p);
  const ok = removeWithRetry(p, force ? 8 : 2);
  if (ok) {
    freed += size;
    console.log("已删除 " + rel);
  } else {
    busy.push(rel);
    console.log("跳过 " + rel + "（被占用）");
  }
}

console.log(freed > 0 ? `\n释放 ${(freed / 1048576).toFixed(1)} MB` : "\n没有需要清理的内容");
if (busy.length) {
  console.log("\n以下项目被占用：" + busy.join(", "));
  console.log("处理办法：");
  console.log("  1. 完全退出 Grok Bot（含托盘图标）");
  console.log("  2. 稍等几秒后重试，或加 --force 多试几次");
  console.log("  3. 仍失败可忽略——build/ 是构建中间产物，不影响已打包的 dist/app");
}

function removeWithRetry(p, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch {
      if (i < attempts - 1) sleep(400);
    }
  }
  return false;
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 同步等待，脚本场景够用 */
  }
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      total += sizeOf(path.join(p, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}
