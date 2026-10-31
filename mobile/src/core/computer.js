// 「计算机」抽象层。与桌面版接口契约一致。
// 手机端两种实现：
//   local  —— expo-file-system 的文档目录沙箱（无 shell / 浏览器）
//   remote —— 复用 grok-server.js 的 HTTP 契约（云计算机，含 shell / 浏览器）

export class Computer {
  constructor({ id, kind }) {
    this.id = id;
    this.kind = kind;
  }

  capabilities() {
    throw new Error("capabilities() 未实现");
  }

  async health() {
    throw new Error("health() 未实现");
  }

  async listFiles(_relPath) { throw new Error("listFiles() 未实现"); }
  async readFile(_relPath, _opts) { throw new Error("readFile() 未实现"); }
  async writeFile(_relPath, _content) { throw new Error("writeFile() 未实现"); }
  async searchText(_pattern, _opts) { throw new Error("searchText() 未实现"); }
  async exec(_command, _opts) { throw new Error("exec() 未实现"); }

  async navigate(_url) { throw new Error("这台计算机不支持浏览器"); }
  async browserSnapshot() { throw new Error("这台计算机不支持浏览器快照"); }
  async browserClick(_uid) { throw new Error("这台计算机不支持浏览器点击"); }
  async browserType(_uid, _text, _opts) { throw new Error("这台计算机不支持浏览器输入"); }
  async browserEval(_expression) { throw new Error("这台计算机不支持浏览器脚本"); }
  async browserScreenshot() { throw new Error("这台计算机不支持浏览器截图"); }
  async browserTabs() { return []; }
  async browserUseTab(_hint) { throw new Error("这台计算机不支持多标签切换"); }
  browserStatus() { return { running: false, external: false, port: null, pid: null }; }

  async requestTakeover(_reason) { return { status: "not-needed", detail: "本机模式下不需要接管" }; }
  screenUrl() { return null; }

  async dispose() {}
}
