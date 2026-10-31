// 本机计算机：手机上的文档目录沙箱。
// 能力：文件读写 / 文本搜索；不支持 shell 与浏览器（调用时给出明确错误）。

import * as FileSystem from "expo-file-system";
import { Computer } from "./computer";
import { clip, truncate } from "./util";

const MAX_READ_BYTES = 200 * 1024;
const MAX_OUTPUT_CHARS = 20000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

const BINARY_RE = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|exe|dll|dylib|mp4|mp3|wav|xlsx|docx|pptx)$/i;

export class LocalComputer extends Computer {
  constructor({ id = "local", rootDir }) {
    super({ id, kind: "local" });
    this.root = FileSystem.documentDirectory + "workspaces/" + sanitize(id);
    this.botId = id;
  }

  capabilities() {
    return {
      terminal: false,
      filesystem: true,
      browser: false,
      screen: false,
      persistent: false,
    };
  }

  async health() {
    return { ok: true, detail: "本机沙箱（文档目录）" };
  }

  async ensureDir() {
    await FileSystem.makeDirectoryAsync(this.root, { intermediates: true }).catch(() => {});
  }

  #resolve(relPath) {
    const raw = String(relPath || ".").trim() || ".";
    if (raw.startsWith("/")) {
      // 绝对路径：只允许落在应用文档目录内（技能目录 / 数据目录）
      if (raw.startsWith(FileSystem.documentDirectory)) return raw;
      throw new Error(`拒绝访问应用目录之外的路径：${relPath}`);
    }
    const parts = raw.split("/").filter((p) => p && p !== ".");
    const stack = [];
    for (const p of parts) {
      if (p === "..") stack.pop();
      else stack.push(p);
    }
    return this.root + "/" + stack.join("/");
  }

  async listFiles(relPath = ".") {
    await this.ensureDir();
    const target = this.#resolve(relPath);
    let entries;
    try {
      entries = await FileSystem.readDirectoryAsync(target);
    } catch {
      return `目录不存在：${relPath}`;
    }
    if (!entries.length) return `${relPath === "." ? "工作目录" : relPath}：\n（空）`;
    const lines = [];
    for (const name of entries.slice(0, 300)) {
      const full = target + "/" + name;
      const info = await FileSystem.getInfoAsync(full).catch(() => null);
      if (info?.isDirectory) lines.push(`${name}/`);
      else lines.push(`${name}  (${info?.size ?? "?"} B)`);
    }
    return `${relPath === "." ? "工作目录" : relPath}：\n${lines.join("\n")}`;
  }

  async readFile(relPath, opts = {}) {
    await this.ensureDir();
    const target = this.#resolve(relPath);
    const info = await FileSystem.getInfoAsync(target).catch(() => null);
    if (!info?.exists) return `文件不存在：${relPath}`;
    if (info.isDirectory) return `这是一个目录，请用 list_files：${relPath}`;
    if (BINARY_RE.test(relPath)) {
      return `这是二进制/图片文件（${Math.round(info.size / 1024)} KB），read_file 只能读文本。`;
    }
    if (info.size > MAX_READ_BYTES) {
      return `文件过大（${Math.round(info.size / 1024)} KB），请指定行范围或用 search_text 定位。`;
    }
    const text = await FileSystem.readAsStringAsync(target, { encoding: "utf8" });
    if (!opts.startLine && !opts.endLine) return truncate(text, MAX_OUTPUT_CHARS);
    const lines = text.split("\n");
    const from = Math.max(1, Number(opts.startLine) || 1);
    const to = Math.min(lines.length, Number(opts.endLine) || lines.length);
    return `（第 ${from}-${to} 行，共 ${lines.length} 行）\n` + truncate(lines.slice(from - 1, to).join("\n"), MAX_OUTPUT_CHARS);
  }

  async writeFile(relPath, content) {
    await this.ensureDir();
    const target = this.#resolve(relPath);
    const existed = (await FileSystem.getInfoAsync(target).catch(() => null))?.exists ?? false;
    const dir = target.slice(0, target.lastIndexOf("/"));
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const text = String(content ?? "");
    await FileSystem.writeAsStringAsync(target, text, { encoding: "utf8" });
    return { path: relPath, bytes: byteLength(text), existed };
  }

  async searchText(pattern, opts = {}) {
    await this.ensureDir();
    if (!pattern) return "错误：pattern 不能为空";
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      return `错误：正则无效（${pattern}）`;
    }
    const base = this.#resolve(opts.relPath || ".");
    const limit = Math.min(Number(opts.maxResults) || 50, 200);
    const results = [];
    await this.#walk(base, base, re, results, limit);
    return results.length ? results.join("\n") : `未找到匹配「${pattern}」的内容`;
  }

  async #walk(root, dir, re, results, limit) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await FileSystem.readDirectoryAsync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (results.length >= limit) return;
      const full = dir + "/" + name;
      const info = await FileSystem.getInfoAsync(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory) {
        if (SKIP_DIRS.has(name)) continue;
        await this.#walk(root, full, re, results, limit);
        continue;
      }
      if (info.size > 512 * 1024) continue;
      let text;
      try {
        text = await FileSystem.readAsStringAsync(full, { encoding: "utf8" });
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      text.split("\n").forEach((line, i) => {
        if (results.length >= limit) return;
        if (re.test(line)) results.push(`${full.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }

  async exec() {
    return {
      code: null,
      stdout: "",
      stderr: "手机本机模式不支持 shell。请在「设置 → 执行环境」切到云计算机后再运行命令。",
      timedOut: false,
    };
  }

  async navigate() {
    throw new Error("手机本机模式不支持浏览器。请切到云计算机。");
  }
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "-") || "default";
}

function byteLength(s) {
  // UTF-8 字节长度近似
  return Array.from(String(s ?? "")).reduce((n, ch) => {
    const c = ch.codePointAt(0);
    return n + (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);
  }, 0);
}
