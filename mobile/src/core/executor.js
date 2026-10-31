// 工具执行器：把模型的 tool call 翻译成「计算机」上的操作。
// 与桌面版 executor.js 一致，但调用方式改为「计算机」对象上的方法。

import { truncate } from "./util";

export async function executeTool(call, ctx) {
  const computer = ctx.computer;
  if (!computer) return "错误：没有可用的计算机";

  let args = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return `错误：工具参数不是合法 JSON（${call.arguments}）`;
  }

  try {
    if (ctx.approve) {
      const verdict = await ctx.approve(call.name, args, call);
      if (verdict && verdict.allowed === false) {
        const why = verdict.reason || "用户拒绝了该操作";
        return `已阻止：${why}。请换一种更安全的做法，或向用户说明需要什么授权；不要用等价写法绕过审批。`;
      }
    }

    if (ctx.mcpCall && /^mcp__/.test(call.name)) {
      const r = await ctx.mcpCall(call.name, args);
      return r ?? `错误：MCP 工具 ${call.name} 不可用`;
    }

    switch (call.name) {
      case "list_files":
        return await computer.listFiles(args.path || ".");

      case "read_file":
        return await computer.readFile(args.path, { startLine: args.startLine, endLine: args.endLine });

      case "write_file": {
        const r = await computer.writeFile(args.path, args.content);
        ctx.onFileChange?.({ path: r.path, action: r.existed ? "modified" : "created", after: args.content });
        return `已${r.existed ? "更新" : "创建"}：${r.path}（${r.bytes} 字节）`;
      }

      case "run_command": {
        const r = await computer.exec(args.command, { timeoutMs: args.timeoutMs });
        ctx.onCommand?.({ command: args.command, code: r.code });
        const parts = [];
        if (r.stdout.trim()) parts.push(truncate(r.stdout.trim()));
        if (r.stderr.trim()) parts.push("[stderr]\n" + truncate(r.stderr.trim()));
        if (r.timedOut) parts.push("（命令超时，已终止）");
        if (!parts.length) parts.push("（无输出）");
        return `退出码 ${r.code}\n${parts.join("\n")}`;
      }

      case "search_text":
        return await computer.searchText(args.pattern, {
          relPath: args.path || ".",
          maxResults: args.maxResults,
        });

      case "browser_navigate":
        return await computer.navigate(args.url);
      case "browser_snapshot":
        return await computer.browserSnapshot();
      case "browser_click":
        return await computer.browserClick(args.uid);
      case "browser_type":
        return await computer.browserType(args.uid, args.text, { submit: Boolean(args.submit) });
      case "browser_eval":
        return truncate(await computer.browserEval(args.expression));
      case "browser_screenshot":
        return `截图已保存：${await computer.browserScreenshot()}`;
      case "browser_tabs": {
        const tabs = await computer.browserTabs();
        if (!tabs.length) return "当前没有打开的标签页（先用 browser_navigate 打开一个）";
        return tabs.map((t, i) => `${i + 1}. ${t.title || "(无标题)"} — ${t.url}`).join("\n");
      }
      case "browser_tab":
        return await computer.browserUseTab(args.hint);

      case "report_result": {
        const status = ["success", "blocked", "failed"].includes(args.status) ? args.status : "failed";
        if (ctx.reportResult) ctx.reportResult({ status, summary: args.summary || "", details: args.details || "" });
        const word = status === "success" ? "成功" : status === "blocked" ? "受阻" : "失败";
        return `已上报结果：${word}。${args.summary || ""}`;
      }

      case "list_bots":
        if (!ctx.listBots) return "当前不可用";
        return (
          ctx.listBots().map((b) => `${b.name}（${b.description || "无描述"}）`).join("\n") ||
          "团队里没有其他 Bot"
        );

      case "delegate_to_bot":
        if (!ctx.delegate) return "错误：当前 Bot 无法委派任务";
        return await ctx.delegate(args.botName, args.task);

      case "message_bot":
        if (!ctx.messageBot) return "错误：协作未启用";
        return await ctx.messageBot(args.botName, args.message);

      case "start_group_chat":
        if (!ctx.groupChat) return "错误：协作未启用";
        return await ctx.groupChat(args.topic, args.members);

      case "remember": {
        if (!ctx.remember) return "错误：记忆系统未启用";
        const item = await ctx.remember({
          topic: args.topic,
          content: args.content,
          tier: args.tier || "log",
          scope: args.scope || "user",
        });
        return `已记住「${item.topic}」（${item.tier === "profile" ? "长期偏好，每次对话生效" : "任务经验，按需检索"}）`;
      }

      case "recall": {
        if (!ctx.recall) return "错误：记忆系统未启用";
        const items = ctx.recall(args.query, { tier: args.tier, limit: args.limit || 10 });
        if (!items.length) return "没有找到相关记忆。";
        return items.map((m) => `[id=${m.id}] (${m.scope}/${m.tier}) ${m.topic}：${m.content}`).join("\n");
      }

      case "forget": {
        if (!ctx.forget) return "错误：记忆系统未启用";
        return ctx.forget(args.id) ? `已删除记忆 ${args.id}` : `未找到记忆 ${args.id}`;
      }

      case "list_skills": {
        if (!ctx.listSkills) return "错误：技能系统未启用";
        const skills = ctx.listSkills();
        if (!skills.length) return "当前没有可用技能。";
        return (
          "可用技能：\n" +
          skills.map((s) => `- ${s.name}${s.description ? "：" + s.description : ""}`).join("\n") +
          "\n\n任务匹配时用 use_skill 读取具体步骤。"
        );
      }

      case "use_skill": {
        if (!ctx.readSkill) return "错误：技能系统未启用";
        const skill = ctx.readSkill(args.name);
        if (!skill) return `找不到技能「${args.name}」。可先调用 list_skills 查看。`;
        return `# 技能：${skill.name}\n\n${skill.body}`;
      }

      default:
        return `错误：未知工具 ${call.name}`;
    }
  } catch (error) {
    return `错误：${error.message}`;
  }
}
