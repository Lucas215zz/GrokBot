"use strict";

/**
 * 审批策略：判断一次工具调用属于哪类风险。
 *
 * 原则：
 * - 纯静态判断（工具名 + 参数文本），不执行任何东西
 * - 宁可多问一次，也不把破坏性操作漏掉
 * - 有一小组「永久拒绝」，不弹窗、不可放行
 */

/** 永久拒绝：改代码才能解除 */
const HARD_DENY = [
  { re: /\bformat(?:\.com)?\s+(?:volume\b|[a-z]:)|format-volume\b/i, label: "格式化磁盘" },
  { re: /\bdiskpart\b/i, label: "磁盘分区操作" },
  { re: /\bbcdedit\b/i, label: "修改启动配置" },
  { re: /\bvssadmin\b[^\n]*\bdelete\b/i, label: "删除卷影副本" },
  { re: /\bwbadmin\b[^\n]*\bdelete\b/i, label: "删除系统备份" },
  { re: /\breg(?:\.exe)?\s+delete\s+(?:hklm|hkey_local_machine)\b/i, label: "删除系统注册表" },
  { re: /\bcipher(?:\.exe)?\s+\/w/i, label: "擦除磁盘空闲空间" },
  {
    re: /(?:^|[;&|]\s*)(?:rm|rmdir)\s+(?:-[a-z]*[rf][a-z]*\s+)+(?:\/|~|\$home)(?:\s|$)/i,
    label: "删除系统根目录",
  },
  { re: /\b(?:takeown|icacls)\b[^\n]*\b[a-z]:\\windows\b/i, label: "篡改系统目录权限" },
  // 删盘符根目录（del C:\ / Remove-Item C:\ / rd /s /q C:\ 都算）
  {
    re: /\b(?:remove-item|del|erase|rd|rmdir)\b[^\n]*["']?[a-z]:[\\/]+["']?(?:\s|$)/i,
    label: "删除盘符根目录",
  },
  // 删系统目录（cmd /c rd /s /q C:\Windows、Remove-Item C:\Windows\System32 等）
  {
    re: /\b(?:remove-item|del|erase|rd|rmdir)\b[^\n]*["']?[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata|system32)\b/i,
    label: "删除系统目录",
  },
  // 只删到盘符下的 Users 根（不能误伤 C:\Users\me\proj\node_modules）
  {
    re: /\b(?:remove-item|del|erase|rd|rmdir)\b[^\n]*["']?[a-z]:[\\/]users[\\/]*["']?(?:\s|$)/i,
    label: "删除用户目录根",
  },
  { re: /\brm\b[^\n]*--no-preserve-root\b/i, label: "绕过保护删除系统根目录" },
];

/** 删除 / 移动 / 重命名：可能造成数据丢失 */
const DELETE_RE =
  /\b(?:remove-item|del(?:ete)?|erase|rd|rmdir|rm|ri|move-item|mv|rename-item|ren)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore\b)/i;

/** 联网下载、安装、发布、外发 */
const NETWORK_RE =
  /\b(?:git\s+push|npm\s+publish|yarn\s+publish|pnpm\s+publish|npm\s+(?:i|install|ci|add)|yarn\s+(?:add|install)|pnpm\s+(?:add|install|dlx)|npx|pip3?\s+install|winget\s+install|choco\s+install|scoop\s+install|scp|sftp|ssh|telnet|ncat)\b|\b(?:curl|wget|invoke-webrequest|invoke-restmethod|irm|iwr)\b[^\n]*(?:-x\s*post|--data|-d\s|--upload-file|--form|-method\s+post)|\b(?:aws|gcloud|az)\b\s+\S+\s+(?:create|deploy|run|publish|delete)/i;

/** 修改系统设置、动服务/进程、提权 */
const SYSTEM_RE =
  /\b(?:set-executionpolicy|schtasks|taskkill|stop-process|runas|sudo|shutdown|restart-computer|stop-computer|logoff|set-service|new-service|remove-service|net\s+user|net\s+localgroup)\b|\bsc(?:\.exe)?\s+(?:delete|config|stop|start)\b|\breg(?:\.exe)?\s+(?:add|set)\b|start-process\b[^\n]*-verb\s+runas|\bset-mppreference\b[^\n]*-(?:disablerealtimemonitoring|disableioavprotection|disablebehaviormonitoring|disablescriptscanning|disablescanningnetworkfiles|disableblockatfirstseen)\b|\bnetsh\b[^\n]*\badvfirewall\b[^\n]*\bstate\s+off\b|\bwevtutil\b[^\n]*\bcl\b|\bbcdedit\b|\bvssadmin\b/i;

/** 凭据、密钥、应用自身数据 */
const SECRET_RE =
  /\.ssh\b|\.aws\b|\.gnupg\b|\.kube\b|id_rsa\b|id_ed25519\b|\.npmrc\b|\.netrc\b|credentials(?:\.json)?\b|secrets?\.(?:json|ya?ml)\b|(?<![\w$])\.env(?:\.(?:local|production|development|test))?\b|appdata[\\/]roaming[\\/]grok bot\b|grok bot[\\/]app\.json\b/i;

/**
 * 「看不透」的命令：内联脚本、编码命令、管道喂给解释器、动态构造。
 * 这类命令静态检查无法判断它到底做什么，所以默认要问。
 */
const SCRIPT_RE =
  /\binvoke-expression\b|\biex\b|\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\b|\b(?:node|deno|bun)\s+(?:-e|--eval)\b|\b(?:python|python3|py)\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b|\bscriptblock\b|\bfrombase64string\b|\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|node)\b/i;

/** 用系统自带工具下载载荷（certutil / bitsadmin 等「合法工具滥用」） */
const LIVING_OFF_LAND_RE =
  /\bcertutil(?:\.exe)?\b[^\n]*(?:-urlcache|-decode|-decodehex)|\bbitsadmin(?:\.exe)?\b[^\n]*\/transfer\b|\bmshta(?:\.exe)?\b[^\n]*(?:https?:|vbscript:|javascript:)|\brundll32(?:\.exe)?\b[^\n]*\bjavascript:|\bregsvr32(?:\.exe)?\b[^\n]*\/i:https?:/i;

/** 写文件类命令（shell 里的重定向 / Set-Content 等） */
const WRITE_RE =
  /\b(?:set-content|add-content|out-file|new-item|copy-item|mkdir|touch|tee)\b|(?:^|\s)>{1,2}(?!&)/i;

/**
 * 只读命令白名单：只看第一个词。
 *
 * shell 命令不受工作目录沙箱约束，所以「随便跑个命令」本身就值得确认。
 * 但光看目录、读文件这类只读命令如果每次都问，会把人逼到「关闭审批」，
 * 反而更不安全。白名单只放这些确凿只读的入口，其余一律按 exec 处理。
 */
const READ_ONLY_FIRST = new Set([
  "get-childitem", "gci", "dir", "ls", "get-item", "gi", "test-path", "resolve-path",
  "get-content", "gc", "cat", "type", "head", "tail", "more",
  "select-string", "findstr", "grep", "rg",
  "get-location", "pwd", "get-date", "get-host", "whoami", "hostname", "ver",
  "get-process", "tasklist", "get-service", "get-command", "get-help", "get-module",
  "get-itemproperty", "measure-object", "sort-object", "where-object", "select-object",
  "format-table", "format-list", "out-string", "write-output", "write-host", "echo",
  "node", "npm", "npx",  // 仅当子命令在 SAFE_PREFIXES 里时才放行
  "git",
]);

/**
 * 「命令 + 子命令」级别的只读白名单。
 * 解释器（node/python）和包管理器都不在这里 —— 它们能跑任意代码。
 */
const SAFE_PREFIXES = [
  "git status", "git log", "git diff", "git show", "git branch", "git remote",
  "git config --get", "git rev-parse", "git describe", "git blame", "git ls-files",
  "npm ls", "npm list", "npm view", "npm outdated", "npm config get",
  "node --version", "node -v", "npm --version", "npm -v",
];

/** 这些子命令虽然是只读入口，但会改东西 */
const NOT_READ_ONLY_ARGS =
  /\b(?:install|uninstall|add|remove|update|upgrade|publish|deploy|run|exec|start|stop|kill|clean|reset|checkout|switch|merge|rebase|push|tag|commit|apply|test)\b/i;

/** 复合命令：有连接符就不算「单一只读命令」 */
const COMPOUND_RE = /;|&&|\|\||\|/;

/** 各模式要问哪些类别 */
const ASK_MATRIX = {
  strict: new Set([
    "unknown", "exec", "script", "write", "delete", "network", "secret", "system", "collab", "mcp", "memory", "read",
  ]),
  balanced: new Set(["unknown", "exec", "script", "delete", "network", "secret", "system", "collab", "mcp"]),
  relaxed: new Set(["unknown", "delete", "network", "secret", "system"]),
  off: new Set(),
};

const SEVERITY = {
  read: "low",
  exec: "low",
  unknown: "medium",
  script: "high",
  write: "low",
  delete: "high",
  network: "high",
  secret: "high",
  system: "high",
  collab: "medium",
  mcp: "medium",
  memory: "low",
};

const LABEL = {
  read: "只读命令",
  exec: "执行命令",
  unknown: "未登记工具",
  script: "内联脚本",
  write: "写入文件",
  delete: "删除 / 移动",
  network: "联网 / 外发",
  secret: "读取凭据",
  system: "系统变更",
  collab: "Bot 协作",
  mcp: "MCP 工具",
  memory: "记忆变更",
  safe: "只读",
};

function clip(text, limit = 1500) {
  const s = String(text ?? "");
  return s.length > limit ? s.slice(0, limit) + `\n…（共 ${s.length} 字符）` : s;
}

function normalize(cmd) {
  return String(cmd || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function classifyCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { category: "safe", blocked: false, label: LABEL.safe, ruleId: null };

  for (const rule of HARD_DENY) {
    if (rule.re.test(cmd)) {
      return {
        category: "system",
        blocked: true,
        label: LABEL.system,
        reason: `永久拒绝：${rule.label}`,
        severity: "high",
        detail: clip(cmd),
        ruleId: "blocked:" + rule.label,
      };
    }
  }

  const base = { blocked: false, detail: clip(cmd) };
  if (SECRET_RE.test(cmd)) {
    return {
      ...base,
      category: "secret",
      label: LABEL.secret,
      reason: "这条命令可能读取凭据、密钥或应用自身数据",
      severity: SEVERITY.secret,
      ruleId: "cmd:" + normalize(cmd),
    };
  }
  if (DELETE_RE.test(cmd)) {
    return {
      ...base,
      category: "delete",
      label: LABEL.delete,
      reason: "这条命令会删除、移动或重命名文件，可能丢数据",
      severity: SEVERITY.delete,
      ruleId: "cmd:" + normalize(cmd),
    };
  }
  if (NETWORK_RE.test(cmd)) {
    return {
      ...base,
      category: "network",
      label: LABEL.network,
      reason: "这条命令会联网下载、安装、发布或向外发送数据",
      severity: SEVERITY.network,
      ruleId: "cmd:" + normalize(cmd),
    };
  }
  if (LIVING_OFF_LAND_RE.test(cmd)) {
    return {
      ...base,
      category: "network",
      label: LABEL.network,
      reason: "这条命令在借用系统自带工具（certutil / bitsadmin / mshta / rundll32 等）下载或解码载荷，是常见的绕过手法",
      severity: SEVERITY.network,
      ruleId: "cmd:" + normalize(cmd),
    };
  }
  if (SCRIPT_RE.test(cmd)) {
    return {
      ...base,
      category: "script",
      label: LABEL.script,
      reason: "这条命令含内联脚本 / 编码内容 / 管道，静态检查无法确认它到底做什么",
      severity: SEVERITY.script,
      ruleId: "cmd:" + normalize(cmd),
    };
  }
  if (SYSTEM_RE.test(cmd)) {
    return {
      ...base,
      category: "system",
      label: LABEL.system,
      reason: "这条命令会修改系统设置、服务或进程",
      severity: SEVERITY.system,
      ruleId: "cmd:" + normalize(cmd),
    };
  }

  // 命令本身无害但会写文件：按「写」档处理，让「写文件」有一致的确认体验
  if (WRITE_RE.test(cmd)) {
    return {
      ...base,
      category: "write",
      label: LABEL.write,
      reason: "这条命令会创建或修改文件",
      severity: SEVERITY.write,
      ruleId: "cmd:" + normalize(cmd),
    };
  }
  return {
    ...base,
    category: isReadOnlyCommand(cmd) ? "read" : "exec",
    label: isReadOnlyCommand(cmd) ? LABEL.read : LABEL.exec,
    reason: isReadOnlyCommand(cmd)
      ? "只读查询命令"
      : "这条命令会在这台计算机上执行（shell 不受工作目录限制）",
    severity: isReadOnlyCommand(cmd) ? SEVERITY.read : SEVERITY.exec,
    ruleId: "cmd:" + normalize(cmd),
  };
}

/**
 * 判断是否「确凿只读」。
 * 规则故意保守：拿不准就当不是。
 */
function isReadOnlyCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (COMPOUND_RE.test(cmd)) return false;
  if (/(?:^|\s)>{1,2}(?!&)/.test(cmd)) return false;

  const first = /^["']?([^\s"'|;&]+)/.exec(cmd)?.[1] || "";
  const name = first.replace(/^.*[\\/]/, "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  const rest = cmd.slice(first.length).trim();

  if (!READ_ONLY_FIRST.has(name)) return false;

  // git / npm / node：只认明确的只读子命令，且不允许再带「会改东西」的词
  if (name === "git" || name === "npm" || name === "node" || name === "npx") {
    const lower = (name + " " + rest).toLowerCase().replace(/\s+/g, " ");
    const hit = SAFE_PREFIXES.find((p) => lower === p || lower.startsWith(p + " "));
    if (!hit) return false;
    return !NOT_READ_ONLY_ARGS.test(rest);
  }

  if (NOT_READ_ONLY_ARGS.test(rest)) return false;
  return true;
}

/** 工具 + 参数 → 风险分类 */
function classifyTool(tool, args = {}) {
  if (tool === "run_command") return classifyCommand(args.command);

  // 文件类工具：路径落在凭据 / 应用配置上时，风险比「普通读写」高
  const filePath = String(args.path ?? args.relPath ?? "");
  const sensitivePath = SECRET_RE.test(filePath) || /(?:^|[\\/])\.(?:ssh|aws|gnupg|kube)(?:[\\/]|$)/i.test(filePath);

  if (tool === "read_file" || tool === "list_files" || tool === "search_text") {
    if (sensitivePath) {
      return {
        category: "secret",
        blocked: false,
        label: LABEL.secret,
        reason: "这个路径可能是凭据、密钥或应用自身数据",
        severity: SEVERITY.secret,
        detail: `路径：${filePath}`,
        ruleId: "secret:" + tool + ":" + normalize(filePath),
      };
    }
    return { category: "safe", blocked: false, label: LABEL.safe, ruleId: null };
  }

  if (tool === "write_file") {
    if (sensitivePath) {
      return {
        category: "secret",
        blocked: false,
        label: LABEL.secret,
        reason: "这个路径可能是凭据、密钥或应用自身数据，写入可能造成泄露或劫持",
        severity: SEVERITY.secret,
        detail: `路径：${filePath}\n\n${clip(args.content, 800)}`,
        ruleId: "secret:write:" + normalize(filePath),
      };
    }
    return {
      category: "write",
      blocked: false,
      label: LABEL.write,
      reason: "会在工作目录里创建或覆盖文件",
      severity: SEVERITY.write,
      detail: `路径：${args.path ?? ""}\n\n${clip(args.content, 800)}`,
      ruleId: "write:" + String(args.path ?? ""),
    };
  }

  if (tool === "browser_navigate") {
    return {
      category: "network",
      blocked: false,
      label: LABEL.network,
      reason: "会打开外部网页，可能把本机上下文带出去",
      severity: SEVERITY.network,
      detail: `网址：${String(args.url ?? "")}`,
      ruleId: "browser:" + String(args.url ?? ""),
    };
  }

  if (tool === "browser_click" || tool === "browser_type") {
    return {
      category: "network",
      blocked: false,
      label: LABEL.network,
      reason: tool === "browser_click" ? "会在网页上点击，可能提交表单或触发外部操作" : "会往网页里输入内容并可能提交",
      severity: SEVERITY.network,
      detail: tool === "browser_click" ? `元素：${String(args.uid ?? "")}` : `元素：${String(args.uid ?? "")}\n内容：${clip(args.text, 500)}`,
      ruleId: "browser:" + tool + ":" + String(args.uid ?? ""),
    };
  }

  if (tool === "browser_eval") {
    return {
      category: "script",
      blocked: false,
      label: LABEL.script,
      reason: "会在网页里执行任意 JavaScript，静态检查无法确认其行为",
      severity: SEVERITY.script,
      detail: clip(args.expression, 1000),
      ruleId: "browser:eval",
    };
  }

  if (tool === "browser_snapshot" || tool === "browser_screenshot" || tool === "browser_tabs") {
    return { category: "safe", blocked: false, label: LABEL.safe, ruleId: null };
  }

  if (tool === "browser_tab") {
    return { category: "safe", blocked: false, label: LABEL.safe, ruleId: null };
  }

  // 纯本地、只读、不触达外部世界的工具：确凿安全
  // report_result 只是把结果记给调度器，不产生任何副作用，也不需要审批
  if (
    tool === "list_bots" ||
    tool === "list_skills" ||
    tool === "use_skill" ||
    tool === "recall" ||
    tool === "report_result"
  ) {
    return { category: "safe", blocked: false, label: LABEL.safe, ruleId: null };
  }

  if (tool === "remember") {
    // profile 层每轮都会注入，等于往系统提示里塞内容，是提示注入的落点，必须让人看见
    if (args.tier === "profile") {
      return {
        category: "memory",
        blocked: false,
        label: LABEL.memory,
        reason: "会写入长期偏好（profile），以后每轮对话都会带上",
        severity: SEVERITY.memory,
        detail: `主题：${args.topic ?? ""}\n\n${clip(args.content, 800)}`,
        ruleId: "memory:profile:" + String(args.topic ?? ""),
      };
    }
    return { category: "safe", blocked: false, label: LABEL.safe, ruleId: null };
  }

  if (tool === "delegate_to_bot") {
    return {
      category: "collab",
      blocked: false,
      label: LABEL.collab,
      reason: `会把任务交给「${args.botName || "?"}」并让它执行`,
      severity: SEVERITY.collab,
      detail: `目标：${args.botName || "?"}\n\n${clip(args.task, 800)}`,
      ruleId: "collab:delegate:" + String(args.botName ?? ""),
    };
  }

  if (tool === "message_bot") {
    return {
      category: "collab",
      blocked: false,
      label: LABEL.collab,
      reason: `会给「${args.botName || "?"}」投递一条消息`,
      severity: SEVERITY.collab,
      detail: `目标：${args.botName || "?"}\n\n${clip(args.message, 800)}`,
      ruleId: "collab:message:" + String(args.botName ?? ""),
    };
  }

  if (tool === "start_group_chat") {
    const members = Array.isArray(args.members) ? args.members.join("、") : "";
    return {
      category: "collab",
      blocked: false,
      label: LABEL.collab,
      reason: "会发起多 Bot 群聊并让它们逐一发言",
      severity: SEVERITY.collab,
      detail: `成员：${members || "?"}\n\n${clip(args.topic, 800)}`,
      ruleId: "collab:group:" + members,
    };
  }

  if (tool === "forget") {
    return {
      category: "memory",
      blocked: false,
      label: LABEL.memory,
      reason: "会删除一条长期记忆",
      severity: SEVERITY.memory,
      detail: `记忆 id：${args.id ?? ""}`,
      ruleId: "memory:forget",
    };
  }

  if (/^mcp__/.test(tool)) {
    let detail = "";
    try {
      detail = clip(JSON.stringify(args, null, 2), 1200);
    } catch {
      detail = clip(String(args));
    }
    return {
      category: "mcp",
      blocked: false,
      label: LABEL.mcp,
      reason: "外部 MCP 工具，可能访问网络、数据库或产生费用",
      severity: SEVERITY.mcp,
      detail,
      ruleId: "mcp:" + tool,
    };
  }

  // 没登记过的工具一律按「未知」处理，不能默认放行——
  // 新增工具若忘了在这里加分支，宁可多问一次，也不要悄悄越过边界。
  return {
    category: "unknown",
    blocked: false,
    label: LABEL.unknown,
    reason: "这个工具还没有登记风险等级，为安全起见先问一下",
    severity: SEVERITY.unknown,
    detail: clip(JSON.stringify(args, null, 2), 800),
    ruleId: "unknown:" + tool,
  };
}

function shouldAsk(mode, category) {
  const set = ASK_MATRIX[mode] || ASK_MATRIX.balanced;
  return set.has(category);
}

module.exports = {
  classifyTool,
  classifyCommand,
  isReadOnlyCommand,
  shouldAsk,
  normalize,
  clip,
  HARD_DENY,
  ASK_MATRIX,
  SEVERITY,
  LABEL,
};
