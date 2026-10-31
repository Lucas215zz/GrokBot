// 计算机工厂：按配置决定用本机沙箱还是云计算机。

import { LocalComputer } from "./local-computer";
import { RemoteComputer } from "./remote-computer";

const instances = new Map();

export function getComputer(config, { botId, workspace }) {
  const cfg = config?.computer || { kind: "local" };

  if (cfg.kind === "remote") {
    const key = `remote:${cfg.baseUrl}:${botId || "default"}`;
    if (!instances.has(key)) {
      instances.set(key, new RemoteComputer({ baseUrl: cfg.baseUrl, token: cfg.token, botId: botId || "default" }));
    }
    return instances.get(key);
  }

  const key = `local:${botId || "default"}`;
  if (!instances.has(key)) {
    instances.set(key, new LocalComputer({ id: botId || "local", rootDir: workspace }));
  }
  return instances.get(key);
}

export function disposeAll() {
  for (const c of instances.values()) c.dispose?.();
  instances.clear();
}
