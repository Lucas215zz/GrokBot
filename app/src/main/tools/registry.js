"use strict";

/**
 * 工具注册表。每个 Bot 的工具集由「电脑」的权限决定。
 */

const BUILTIN_TOOLS = [
  {
    name: "list_files",
    description: "列出某个目录下的文件和子目录。用于了解工作区结构。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径，默认为根目录" },
      },
    },
  },
  {
    name: "read_file",
    description: "读取文本文件内容。大文件会被截断。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的文件路径" },
        startLine: { type: "number", description: "起始行号（1 开始），可选" },
        endLine: { type: "number", description: "结束行号，可选" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "创建或覆盖写入文本文件。会显示在界面上供用户确认。",
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
    description: "在 Bot 的工作目录中执行一条 shell 命令并返回输出。适合运行脚本、构建、测试。",
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
    description: "在 Bot 的计算机上打开一个网页（需要该计算机支持浏览器，云端可用）。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要打开的网址" } },
      required: ["url"],
    },
  },
  {
    name: "list_bots",
    description: "查看团队里还有哪些 Bot 可以协调（名称与职责）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "delegate_to_bot",
    description:
      "把一项子任务交给团队里另一个更合适的 Bot 去做，并等待它返回结果。适合分工协作。",
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
    description: "给团队里另一个 Bot 留一条消息（异步，它下次对话时能看到）。适合转交线索、同步进度，不需要等它做完。",
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
    description: "发起一次多 Bot 群聊：围绕一个话题，依次让每个 Bot 发表意见。适合需要多个角色共同决策的场合。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "要讨论的话题或问题" },
        members: {
          type: "array",
          items: { type: "string" },
          description: "参与的 Bot 名称列表（不含自己）",
        },
      },
      required: ["topic", "members"],
    },
  },
  {
    name: "remember",
    description:
      "把一条值得长期记住的信息存下来（用户偏好、习惯、重要事实、约定）。下次对话会自动带上 profile 层的记忆。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "简短主题，如「称呼」「报告格式」「时区」" },
        content: { type: "string", description: "具体内容" },
        tier: {
          type: "string",
          enum: ["profile", "log"],
          description: "profile=长期偏好（每次注入），log=任务经验（按需检索）。默认 log",
        },
        scope: {
          type: "string",
          enum: ["user", "bot"],
          description: "user=我所有 Bot 共享，bot=仅当前 Bot。默认 user",
        },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "recall",
    description: "检索以前记住的信息（包括任务历史）。需要回忆过往约定或经验时使用。",
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
    description: "列出当前可用的技能（Skill）。技能是可复用的做事流程，执行复杂任务前应先看看有没有现成的。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "use_skill",
    description:
      "读取某个技能的完整操作步骤。当任务与某个技能的描述吻合时，先调用它拿到步骤，再按步骤执行。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（list_skills 返回的 id 或 name）" },
      },
      required: ["name"],
    },
  },
  {
    name: "search_text",
    description: "在工作目录中递归搜索文本（类似 grep）。",
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
];

/** 转成 Responses API 的 tools 格式 */
function toResponsesTools(tools) {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

module.exports = { BUILTIN_TOOLS, toResponsesTools };
