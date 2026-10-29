"use strict";

/**
 * 本机计算机实现：直接操作本地文件系统与 PowerShell。
 *
 * 路径策略：
 * - 写操作只能落在 Bot 的 workspace（rootDir）内，防止误改系统文件；
 * - 读操作额外允许「技能目录」和「应用数据目录」，因为技能（SKILL.md / scripts）
 *   装在 <userData>/skills 下、截图存在 <userData>/screenshots 下，
 *   它们本来就不在 workspace 里，但属于 Bot 自己该读的东西。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Computer } = require("./computer");
const { LocalBrowser, findBrowserExe } = require("./browser");

const MAX_READ_BYTES = 200 * 1024;
const MAX_OUTPUT_CHARS = 20000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

class LocalComputer extends Computer {
  constructor({ id = "local", rootDir, userDataDir, browserConfig, extraReadRoots }) {
    super({ id, kind: "local" });
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.userDataDir = userDataDir || null;
    this.browserConfig = browserConfig || {};
    this._browser = null; // 懒创建：第一次真正用到浏览器时才拉起 Chrome

    // 只读白名单：技能目录、应用数据目录（截图/技能等）
    const roots = [];
    if (userDataDir) {
      roots.push(path.join(userDataDir, "skills"));
      roots.push(path.join(userDataDir, "screenshots"));
    }
    for (const r of Array.isArray(extraReadRoots) ? extraReadRoots : []) {
      if (r) roots.push(r);
    }
    this.readRoots = roots.map((r) => path.resolve(r));
  }

  capabilities() {
    return {
      terminal: true,
      filesystem: true,
      browser: Boolean(this.userDataDir) || Boolean(this.browserConfig?.attach) || Boolean(findBrowserExe()),
      screen: false,
      persistent: false,
    };
  }

  /** 懒获取本机浏览器实例 */
  #browserInstance() {
    if (!this._browser) {
      this._browser = new LocalBrowser({
        userDataDir: this.userDataDir || path.join(this.rootDir, ".grokbot-browser"),
        config: this.browserConfig,
      });
    }
    return this._browser;
  }

  browserStatus() {
    return this._browser ? this._browser.status() : { running: false, external: false, port: null, pid: null };
  }

  async health() {
    try {
      fs.accessSync(this.rootDir, fs.constants.W_OK);
      return { ok: true, detail: this.rootDir };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  /** 判断 target 是否在 root 目录内（含自身） */
  #inside(root, target) {
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * 把路径解析成真实绝对路径。
   * - 相对路径：相对 workspace；
   * - 绝对路径：写操作必须在 workspace 内；读操作还允许 readRoots 白名单；
   * - 越界直接拒绝，并在错误里说清楚「允许哪些目录」，避免模型瞎试。
   */
  resolve(relPath, { write = false } = {}) {
    const raw = String(relPath || ".").trim() || ".";
    const target = path.resolve(this.rootDir, raw);
    if (this.#inside(this.rootDir, target)) return target;

    if (!write) {
      for (const root of this.readRoots) {
        if (this.#inside(root, target)) return target;
      }
    }

    const allowed = [this.rootDir, ...(write ? [] : this.readRoots)];
    const list = allowed.map((p) => `  - ${p}`).join("\n");
    throw new Error(
      `拒绝访问工作目录之外的路径：${relPath}\n` +
        `允许的目录：\n${list}\n` +
        `提示：技能文件请用 use_skill 读取（它会给出技能目录与脚本清单），` +
        `脚本请用 run_command 以绝对路径执行；不要用 list_files/read_file 去猜别的路径。`,
    );
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
    // 图片/二进制：直接按 UTF-8 读会变成乱码，且本模型看不到图像内容。
    // 明确告诉模型「读不了」并给出路径，避免它反复重试或把乱码当数据。
    if (isBinaryFile(file, stat.size)) {
      const kind = /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(file) ? "图片" : "二进制";
      return (
        `这是${kind}文件（${Math.round(stat.size / 1024)} KB），read_file 只能读文本，无法查看其内容：\n${file}\n` +
        `如需确认页面/图像信息，请改用 browser_snapshot 读取页面结构，或用 browser_eval 读取页面数据。`
      );
    }
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
    const file = this.resolve(relPath, { write: true });
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
      // 兼容模型误用 cmd 风格变量：%APPDATA% 在 PowerShell 里不会展开，
      // 会被当成普通字符串拼进路径（踩过：E:\DATABASE\Grokbot\%APPDATA%\...）。
      // 这里统一把 %VAR% 换成环境变量值，省得模型反复踩坑。
      const cmd = isWin ? expandWindowsVars(command) : command;
      const args = isWin
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${cmd}`,
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

  // ---------------- 浏览器（本机自动化） ----------------
  async navigate(url) {
    return this.#browserInstance().navigate(url);
  }
  async browserSnapshot() {
    return this.#browserInstance().snapshot();
  }
  async browserClick(uid) {
    return this.#browserInstance().click(uid);
  }
  async browserType(uid, text, opts) {
    return this.#browserInstance().type(uid, text, opts);
  }
  async browserEval(expression) {
    return this.#browserInstance().eval(expression);
  }
  async browserScreenshot() {
    return this.#browserInstance().screenshot(this.userDataDir ? path.join(this.userDataDir, "screenshots") : undefined);
  }
  async browserTabs() {
    return this.#browserInstance().listTabs();
  }
  async browserUseTab(hint) {
    const r = await this.#browserInstance().useTab(hint);
    if (!r.ok) {
      const lines = (r.tabs || []).map((t, i) => `  ${i + 1}. ${t.title || "(无标题)"} — ${t.url}`);
      throw new Error(`${r.reason}。当前标签页：\n${lines.join("\n") || "（无）"}`);
    }
    return `已切换标签页：${r.tab ? r.tab.title || r.tab.url : "默认"}`;
  }
  /** 直接把浏览器窗口拉起来（供设置里「打开浏览器」用，首次便于人工登录） */
  async ensureBrowser() {
    await this.#browserInstance().ensure();
    return this.browserStatus();
  }

  dispose() {
    try { this._browser?.dispose?.(); } catch { /* ignore */ }
    this._browser = null;
  }
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const s = String(text ?? "");
  return s.length > limit ? `${s.slice(0, limit)}\n…（已截断，共 ${s.length} 字符）` : s;
}

/** 是否是图片/二进制文件（按扩展名或内容里的 NUL 字节判断） */
function isBinaryFile(file, size) {
  if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|exe|dll|mp4|mp3|wav|xlsx|docx|pptx)$/i.test(file)) {
    return true;
  }
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(4096, Math.max(1, size)));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch {
    /* 读不到就按文本处理，交给后续逻辑 */
  }
  return false;
}

/**
 * 把命令里的 Windows 风格环境变量 %VAR% 展开成真实值。
 * 只处理已存在的环境变量，未知的保持原样（避免误伤字符串里的 %）。
 * 注意：这是「方便模型」的兜底，不改变 PowerShell 自身的语法。
 */
function expandWindowsVars(command) {
  if (typeof command !== "string" || !command.includes("%")) return command;
  return command.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? process.env[key] : whole;
  });
}

module.exports = { LocalComputer };
