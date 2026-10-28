"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, handler) => {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("api", {
  info: () => ipcRenderer.invoke("app:info"),

  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    reveal: () => ipcRenderer.invoke("settings:reveal"),
  },

  model: {
    // override 可选：{ baseUrl, apiKey }，用设置面板里尚未保存的值去拉取
    list: (override) => ipcRenderer.invoke("model:list", override),
    test: (override) => ipcRenderer.invoke("model:test", override),
  },

  bots: {
    list: () => ipcRenderer.invoke("bots:list"),
    create: (input) => ipcRenderer.invoke("bots:create", input),
    get: (id) => ipcRenderer.invoke("bots:get", id),
    update: (id, patch) => ipcRenderer.invoke("bots:update", id, patch),
    pin: (id, pinned) => ipcRenderer.invoke("bots:pin", id, pinned),
    remove: (id) => ipcRenderer.invoke("bots:delete", id),
    openWorkspace: (id) => ipcRenderer.invoke("bots:openWorkspace", id),
    pickWorkspace: (id) => ipcRenderer.invoke("bots:pickWorkspace", id),
  },

  sessions: {
    list: (botId) => ipcRenderer.invoke("sessions:list", botId),
    create: (botId, title) => ipcRenderer.invoke("sessions:create", botId, title),
    get: (botId, id) => ipcRenderer.invoke("sessions:get", botId, id),
    remove: (botId, id) => ipcRenderer.invoke("sessions:delete", botId, id),
    rename: (botId, id, title) => ipcRenderer.invoke("sessions:rename", botId, id, title),
  },

  agent: {
    run: (payload) => ipcRenderer.invoke("agent:run", payload),
    stop: (runId) => ipcRenderer.invoke("agent:stop", runId),
    onEvent: (handler) => on("agent:event", handler),
  },

  tools: { list: () => ipcRenderer.invoke("tools:list") },

  computer: {
    info: (botId) => ipcRenderer.invoke("computer:info", botId),
    screenUrl: (botId) => ipcRenderer.invoke("computer:screen", botId),
  },

  approval: {
    policy: () => ipcRenderer.invoke("approval:policy"),
    resolve: (id, decision, scope) => ipcRenderer.invoke("approval:resolve", id, decision, scope),
    pending: (runId) => ipcRenderer.invoke("approval:pending", runId),
    audit: (limit) => ipcRenderer.invoke("approval:audit", limit),
    clearAudit: () => ipcRenderer.invoke("approval:clearAudit"),
    onEvent: (handler) => on("approval:event", handler),
  },

  skills: {
    list: () => ipcRenderer.invoke("skills:list"),
    get: (id) => ipcRenderer.invoke("skills:get", id),
    save: (id, payload) => ipcRenderer.invoke("skills:save", id, payload),
    remove: (id) => ipcRenderer.invoke("skills:remove", id),
    openDir: (id) => ipcRenderer.invoke("skills:openDir", id),
    importFolder: () => ipcRenderer.invoke("skills:importFolder"),
    importZip: () => ipcRenderer.invoke("skills:importZip"),
  },

  mcp: {
    list: () => ipcRenderer.invoke("mcp:list"),
    config: () => ipcRenderer.invoke("mcp:config"),
    save: (servers) => ipcRenderer.invoke("mcp:save", servers),
    connect: (name) => ipcRenderer.invoke("mcp:connect", name),
    disconnect: (name) => ipcRenderer.invoke("mcp:disconnect", name),
  },

  routines: {
    list: (botId) => ipcRenderer.invoke("routines:list", botId),
    create: (input) => ipcRenderer.invoke("routines:create", input),
    update: (id, patch) => ipcRenderer.invoke("routines:update", id, patch),
    remove: (id) => ipcRenderer.invoke("routines:remove", id),
    runNow: (id) => ipcRenderer.invoke("routines:runNow", id),
    onEvent: (handler) => on("routine:event", handler),
  },

  memory: {
    list: (botId) => ipcRenderer.invoke("memory:list", botId),
    search: (botId, query, opts) => ipcRenderer.invoke("memory:search", botId, query, opts),
    add: (botId, input) => ipcRenderer.invoke("memory:add", botId, input),
    remove: (botId, scope, id) => ipcRenderer.invoke("memory:remove", botId, scope, id),
    clear: (botId, scope) => ipcRenderer.invoke("memory:clear", botId, scope),
  },

  clipboard: { write: (t) => ipcRenderer.invoke("clipboard:write", t) },
  onThemeChanged: (handler) => on("theme:changed", handler),
});
