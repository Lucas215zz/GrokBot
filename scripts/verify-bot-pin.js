"use strict";
/**
 * 回归：Bot 置顶
 *   1) 默认不置顶；新建 Bot 带 pinned:false
 *   2) 置顶后排在最前；多个置顶按「最近置顶」排
 *   3) 取消置顶回到「最近更新」排序
 *   4) 置顶不改变 updatedAt（不该插队到最近更新）
 *   5) 置顶状态能持久化（新开 Store 读回）
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../app/src/main/store/store");

let fail = 0, total = 0;
const ok = (n, c, x) => { total++; console.log("  " + (c ? "✓" : "✗") + " " + n + (x && !c ? "  → " + x : "")); if (!c) fail++; };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), "实际 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-pin-"));
  const store = new Store(tmp);

  const a = store.createBot({ name: "A" }); await sleep(5);
  const b = store.createBot({ name: "B" }); await sleep(5);
  const c = store.createBot({ name: "C" });

  console.log("\n[1] 默认状态");
  ok("新建 Bot 默认 pinned=false", store.getBot(a.id).pinned === false);
  eq("默认按最近更新倒序", store.listBots().map((x) => x.name), ["C", "B", "A"]);

  console.log("\n[2] 置顶排序");
  store.setBotPinned(a.id, true); await sleep(5);
  eq("置顶的 A 排最前", store.listBots().map((x) => x.name), ["A", "C", "B"]);
  store.setBotPinned(b.id, true); await sleep(5);
  eq("多个置顶按最近置顶排（B 在 A 前）", store.listBots().map((x) => x.name), ["B", "A", "C"]);

  console.log("\n[3] 置顶不改 updatedAt");
  const beforeUpdated = store.getBot(a.id).updatedAt;
  store.setBotPinned(a.id, true);
  ok("重复置顶不改 updatedAt", store.getBot(a.id).updatedAt === beforeUpdated);

  console.log("\n[4] 取消置顶");
  store.setBotPinned(b.id, false);
  eq("取消置顶后 B 回到最近更新位（C 更新更晚 → C 在 B 前）", store.listBots().map((x) => x.name), ["A", "C", "B"]);
  ok("取消置顶后 pinned=false、pinnedAt=null",
    store.getBot(b.id).pinned === false && store.getBot(b.id).pinnedAt === null);

  console.log("\n[5] 持久化");
  const store2 = new Store(tmp);
  const reloaded = store2.listBots();
  ok("新开 Store 仍能读回置顶", reloaded[0].name === "A" && reloaded[0].pinned === true);
  eq("读回顺序仍正确", reloaded.map((x) => x.name), ["A", "C", "B"]);

  console.log("\n[6] 通过 updateBot 也能设置（编辑面板走这条路）");
  store2.updateBot(c.id, { pinned: true, pinnedAt: Date.now() });
  eq("updateBot 设置置顶生效", store2.listBots().map((x) => x.name)[0], "C");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + (fail ? "✗ " + fail + " 项失败" : "✓ 全部通过") + "（共 " + total + " 项）");
  process.exit(fail ? 1 : 0);
})();
