"use strict";

/**
 * 本机计算机实现：直接操作本地文件系统与 PowerShell。
 * 所有路径都被限制在 rootDir 内。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Computer } = require("./computer");

const MAX_READ_BYTES = 200 * 1024;
const MAX_OUTPUT_CHARS = 20000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

class LocalComputer extends Computer {
  constructor({ id = "local", rootDir }) {
    super({ id, kind: "local" });
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  capabilities() {
    return {
      terminal: true,
      filesystem: true,
      browser: false,
      screen: false,
      persistent: false,
    };
  }

  async health() {
    try {
      fs.accessSync(this.rootDir, fs.constants.W_OK);
      return { ok: true, detail: this.rootDir };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  /** 把相对路径解析到根目录内，越界直接拒绝 */
  resolve(relPath) {
    const target = path.resolve(this.rootDir, relPath || ".");
    const rel = path.relative(this.rootDir, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`拒绝访问工作目录之外的路径：${relPath}`);
    }
    return target;
  }

  // ---------------- 文件 ----------------
  async listFiles(relPath = ".") {
    const dir = this.resolve(relPath);
    if (!fs.existsSync(dir)) return `目录不存在：${relPath}`;
    if (!fs.statSync(dir).isDirectory()) return `不是目录：${relPath}`;

    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 300);
    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        return `${e.name}  (${fs.statSync(path.join(dir, e.name)).size} B)`;
      } catch {
        return e.name;
      }
    });
    return `${relPath === "." ? "工作目录" : relPath}：\n${lines.join("\n") || "（空）"}`;
  }

  async readFile(relPath, { startLine, endLine } = {}) {
    const file = this.resolve(relPath);
    if (!fs.existsSync(file)) return `文件不存在：${relPath}`;
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return `这是一个目录，请用 list_files：${relPath}`;
    if (stat.size > MAX_READ_BYTES) {
      return `文件过大（${Math.round(stat.size / 1024)} KB），请指定行范围或用 search_text 定位。`;
    }
    const text = fs.readFileSync(file, "utf8");
    if (!startLine && !endLine) return truncate(text);
    const lines = text.split("\n");
    const from = Math.max(1, startLine || 1);
    const to = Math.min(lines.length, endLine || lines.length);
    return `（第 ${from}-${to} 行，共 ${lines.length} 行）\n` + truncate(lines.slice(from - 1, to).join("\n"));
  }

  async writeFile(relPath, content) {
    const file = this.resolve(relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    const before = existed ? fs.readFileSync(file, "utf8") : "";
    const text = content ?? "";
    fs.writeFileSync(file, text, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(text), existed, before };
  }

  async searchText(pattern, { relPath = ".", maxResults = 50 } = {}) {
    const root = this.resolve(relPath);
    if (!pattern) return "错误：pattern 不能为空";
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      return `错误：正则无效（${pattern}）`;
    }

    const results = [];
    const limit = Math.min(Number(maxResults) || 50, 200);

    const walk = (dir) => {
      if (results.length >= limit) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          walk(full);
          continue;
        }
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        if (!stat || stat.size > 512 * 1024) continue;
        let text;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        text.split("\n").forEach((line, i) => {
          if (results.length >= limit) return;
          if (re.test(line)) results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
      }
    };

    walk(root);
    return results.length ? results.join("\n") : `未找到匹配「${pattern}」的内容`;
  }

  // ---------------- 终端 ----------------
  exec(command, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve) => {
      if (!command || typeof command !== "string") {
        return resolve({ code: null, stdout: "", stderr: "错误：command 不能为空", timedOut: false });
      }
      const isWin = process.platform === "win32";
      const shell = isWin ? "powershell.exe" : "/bin/bash";
      const args = isWin
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
          ]
        : ["-lc", command];

      const child = spawn(shell, args, {
        cwd: this.rootDir,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          PAGER: "cat",
          PYTHONIOENCODING: "utf-8",
          ...(isWin ? { PYTHONUTF8: "1" } : {}),
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString();
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, Math.min(Number(timeoutMs) || 60000, 300000));

      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: `命令启动失败：${e.message}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const s = String(text ?? "");
  return s.length > limit ? `${s.slice(0, limit)}\n…（已截断，共 ${s.length} 字符）` : s;
}

module.exports = { LocalComputer };
