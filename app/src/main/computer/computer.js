"use strict";

/**
 * 「计算机」抽象层。
 *
 * 真实形态：一个账号共享一台持久云计算机（浏览器 + 文件系统 + 终端），
 * 所有 Bot 共用它，安全边界在账号级；每个 Bot 在上面有自己的屏幕，人可以随时接管。
 *
 * 本文件定义这台计算机的接口契约。任何实现（本机 / 云端）都必须满足它，
 * 上层 Agent 循环与工具执行器完全不需要知道背后是本地还是远程。
 */

/**
 * @typedef {object} ComputerCapabilities
 * @property {boolean} terminal   能否执行 shell 命令
 * @property {boolean} filesystem 能否读写文件
 * @property {boolean} browser    能否驱动浏览器
 * @property {boolean} screen     能否提供可观看/接管的屏幕
 * @property {boolean} persistent 关掉应用后是否继续运行
 */

class Computer {
  constructor({ id, kind }) {
    this.id = id;
    this.kind = kind; // "local" | "remote"
  }

  /** @returns {ComputerCapabilities} */
  capabilities() {
    throw new Error("capabilities() 未实现");
  }

  /** @returns {Promise<{ok:boolean, detail?:string}>} */
  async health() {
    throw new Error("health() 未实现");
  }

  // ---------------- 文件系统 ----------------
  async listFiles(_relPath) { throw new Error("listFiles() 未实现"); }
  async readFile(_relPath, _opts) { throw new Error("readFile() 未实现"); }
  /** @returns {Promise<{path:string, bytes:number}>} */
  async writeFile(_relPath, _content) { throw new Error("writeFile() 未实现"); }
  async searchText(_pattern, _opts) { throw new Error("searchText() 未实现"); }

  // ---------------- 终端 ----------------
  /**
   * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
   */
  async exec(_command, _opts) { throw new Error("exec() 未实现"); }

  // ---------------- 浏览器（云端才有） ----------------
  async navigate(_url) { throw new Error("这台计算机不支持浏览器"); }

  // 更细的浏览器操作：默认不支持，由具体实现覆盖
  async browserSnapshot() { throw new Error("这台计算机不支持浏览器快照"); }
  async browserClick(_uid) { throw new Error("这台计算机不支持浏览器点击"); }
  async browserType(_uid, _text, _opts) { throw new Error("这台计算机不支持浏览器输入"); }
  async browserEval(_expression) { throw new Error("这台计算机不支持浏览器脚本"); }
  async browserScreenshot() { throw new Error("这台计算机不支持浏览器截图"); }
  browserStatus() { return { running: false, external: false, port: null, pid: null }; }

  // ---------------- 人机接管 ----------------
  /** @returns {Promise<{status:"not-needed"|"resolved"|"pending", detail?:string}>} */
  async requestTakeover(_reason) {
    return { status: "not-needed", detail: "本机模式下不需要接管" };
  }

  /** 可观看的屏幕地址（VNC/WebRTC），本机为 null */
  screenUrl() { return null; }

  async dispose() {}
}

module.exports = { Computer };
