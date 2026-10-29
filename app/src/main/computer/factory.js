"use strict";

/**
 * 计算机工厂：按配置决定用本机还是云端。
 *
 * app.json 里：
 *   "computer": { "kind": "local" }                          // 现在
 *   "computer": { "kind": "remote", "baseUrl": "...", "token": "..." }  // 以后
 */

const { LocalComputer } = require("./local-computer");
const { RemoteComputer } = require("./remote-computer");

const instances = new Map();

// 应用数据目录在 app.whenReady() 后才知道，这里由一个 setter 注入，
// 供本机计算机存放浏览器 profile / 截图（不塞进每个调用点）。
let userDataDir = "";
function setUserDataDir(dir) {
  userDataDir = dir || "";
}

/**
 * 取得某个 Bot 使用的计算机。
 * - local：每个 Bot 一个独立的根目录（互不干扰）
 * - remote：整个账号共用同一台云计算机（与官方设计一致）
 */
function getComputer(config, { botId, workspace }) {
  const cfg = config?.computer || { kind: "local" };

  if (cfg.kind === "remote") {
    const key = `remote:${cfg.baseUrl}`;
    if (!instances.has(key)) {
      instances.set(key, new RemoteComputer({ baseUrl: cfg.baseUrl, token: cfg.token }));
    }
    return instances.get(key);
  }

  const key = `local:${workspace}`;
  if (!instances.has(key)) {
    instances.set(
      key,
      new LocalComputer({
        id: botId || "local",
        rootDir: workspace,
        userDataDir,
        browserConfig: config?.browser || {},
      }),
    );
  }
  return instances.get(key);
}

function disposeAll() {
  for (const c of instances.values()) c.dispose?.();
  instances.clear();
}

module.exports = { getComputer, disposeAll, setUserDataDir };
