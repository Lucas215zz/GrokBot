// 工具注册表：与桌面版一致的内置工具定义。
// 注意：手机端「计算机」不提供 shell / 浏览器能力（除非切到云计算机），
// 但工具定义保持完整，执行器会在能力缺失时给出明确错误。

export const BUILTIN_TOOLS = [
  {
    name: "list_files",
    description:
      "列出某个目录下的文件和子目录。默认是 Bot 的工作目录；也可以传绝对路径（技能目录、应用数据目录也允许读）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径，或技能/应用数据目录下的绝对路径；默认为工作目录" },
      },
    },
  },
  {
    name: "read_file",
    description:
      "读取文本文件内容（大文件会被截断）。可读工作目录内的文件，也可读技能目录、应用数据目录下的绝对路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的文件路径，或技能/应用数据目录下的绝对路径" },
        startLine: { type: "number", description: "起始行号（1 开始），可选" },
        endLine: { type: "number", description: "结束行号，可选" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "创建或覆盖写入文本文件（仅限 Bot 工作目录内）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的文件路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "在 Bot 的工作目录中执行一条 shell 命令并返回输出。手机本机模式不支持 shell，请切换到云计算机后使用。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeoutMs: { type: "number", description: "超时毫秒，默认 60000" },
      },
      required: ["command"],
    },
  },
  {
    name: "browser_navigate",
    description: "在 Bot 的浏览器里打开一个网页（仅云计算机支持）。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要打开的网址" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "读取当前网页的可交互元素清单。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "点击当前页面上 snapshot 里某个编号的元素。",
    parameters: {
      type: "object",
      properties: { uid: { type: "string", description: "snapshot 给出的编号" } },
      required: ["uid"],
    },
  },
  {
    name: "browser_type",
    description: "往当前页面上某个输入框里填写文字（可选回车提交）。",
    parameters: {
      type: "object",
      properties: {
        uid: { type: "string", description: "snapshot 给出的编号" },
        text: { type: "string", description: "要填的内容" },
        submit: { type: "boolean", description: "填完是否按回车提交，默认否" },
      },
      required: ["uid", "text"],
    },
  },
  {
    name: "browser_eval",
    description: "在当前网页里执行一段 JavaScript 并返回结果（仅云计算机支持）。",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "要执行的 JS 表达式" } },
      required: ["expression"],
    },
  },
  {
    name: "browser_screenshot",
    description: "给当前网页截一张图（仅云计算机支持）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_tabs",
    description: "列出浏览器里当前打开的所有标签页。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_tab",
    description: "切换到指定标签页（按标题或网址里的关键字）。",
    parameters: {
      type: "object",
      properties: { hint: { type: "string", description: "标签页标题或网址里的关键字" } },
      required: ["hint"],
    },
  },
  {
    name: "list_bots",
    description: "查看团队里还有哪些 Bot 可以协调（名称与职责）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "delegate_to_bot",
    description: "把一项子任务交给团队里另一个更合适的 Bot 去做，并等待它返回结果。",
    parameters: {
      type: "object",
      properties: {
        botName: { type: "string", description: "目标 Bot 的名称" },
        task: { type: "string", description: "要交给它的完整任务描述" },
      },
      required: ["botName", "task"],
    },
  },
  {
    name: "message_bot",
    description: "给团队里另一个 Bot 留一条消息（异步，它下次对话时能看到）。",
    parameters: {
      type: "object",
      properties: {
        botName: { type: "string", description: "目标 Bot 名称" },
        message: { type: "string", description: "消息内容" },
      },
      required: ["botName", "message"],
    },
  },
  {
    name: "start_group_chat",
    description: "发起一次多 Bot 群聊：围绕一个话题，依次让每个 Bot 发表意见。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "要讨论的话题或问题" },
        members: { type: "array", items: { type: "string" }, description: "参与的 Bot 名称列表（不含自己）" },
      },
      required: ["topic", "members"],
    },
  },
  {
    name: "remember",
    description: "把一条值得长期记住的信息存下来。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "简短主题" },
        content: { type: "string", description: "具体内容" },
        tier: { type: "string", enum: ["profile", "log"], description: "profile=长期偏好，log=任务经验。默认 log" },
        scope: { type: "string", enum: ["user", "bot"], description: "user=所有 Bot 共享，bot=仅当前 Bot。默认 user" },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "recall",
    description: "检索以前记住的信息。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，留空则返回最近的记忆" },
        tier: { type: "string", enum: ["profile", "log"], description: "只看某一层，可选" },
        limit: { type: "number", description: "返回条数，默认 10" },
      },
    },
  },
  {
    name: "forget",
    description: "删除一条记错的记忆。需要先 recall 拿到 id。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
    },
  },
  {
    name: "list_skills",
    description: "列出当前可用的技能。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "use_skill",
    description: "读取某个技能的完整操作步骤。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能名（id 或 name）" } },
      required: ["name"],
    },
  },
  {
    name: "search_text",
    description: "在工作目录中递归搜索文本。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜索的文本或正则" },
        path: { type: "string", description: "搜索起点目录，可选" },
        maxResults: { type: "number", description: "最多返回多少条，默认 50" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "report_result",
    description:
      "上报本次任务真实的执行结果。任务结束前（尤其是定时例程 / 无人值守运行时）必须调用一次。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "blocked", "failed"], description: "success/blocked/failed" },
        summary: { type: "string", description: "一句话说明这轮做了什么、结果如何" },
        details: { type: "string", description: "可选的补充细节" },
      },
      required: ["status", "summary"],
    },
  },
];

export function toResponsesTools(tools) {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}
