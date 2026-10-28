"use strict";

/**
 * Agent 循环：模型 -> 工具调用 -> 回传结果 -> 再问模型，直到给出最终答复。
 */

const { executeTool } = require("../tools/executor");
const { toResponsesTools, BUILTIN_TOOLS } = require("../tools/registry");
const { renderForcedSkills } = require("./context");

const DEFAULT_MAX_STEPS = 25;

async function runAgent(opts) {
  const {
    client, history, systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS, signal, emit,
    tools = BUILTIN_TOOLS,
    computer,
    listBots,
    delegate,
    listSkills,
    readSkill,
    mcpTools = [],
    mcpCall,
    messageBot,
    groupChat,
    approve,
    remember,
    recall,
    forget,
    forcedSkills = [],
    mentionMissing = [],
  } = opts;

  // 内置工具 + 该 Bot 可用的 MCP 工具
  const responsesTools = [...toResponsesTools(tools), ...mcpTools];
  let finalText = "";

  // 把技能清单注入系统提示：模型据此判断「这件事有没有现成流程」
  const skills = listSkills ? listSkills() : [];
  const skillSection = skills.length
    ? [
        "",
        "## 可用技能",
        "执行任务前先看这里。若有匹配的技能，必须先调用 use_skill 读取完整步骤，再严格按步骤做；不要凭猜测操作。",
        forcedSkills.length
          ? "（本次被 @ 指定的技能已直接加载正文，无需再对它调用 use_skill。）"
          : "",
        ...skills.map((s) => `- ${s.name}${s.description ? "：" + s.description : ""}`),
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  // 用户用 @ 直接指定的技能：跳过「该不该用」的判断，强制加载正文
  const forcedSkillsSection = renderForcedSkills(forcedSkills, mentionMissing);
  if (forcedSkills.length) {
    emit({
      type: "skill_loaded",
      skills: forcedSkills.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled !== false })),
    });
  }

  const effectivePrompt = (systemPrompt || "") + skillSection + forcedSkillsSection;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      emit({ type: "aborted" });
      return { text: finalText, aborted: true, steps: step - 1 };
    }

    emit({ type: "step", step, maxSteps });

    let result;
    try {
      result = await client.stream({
        messages: history,
        tools: responsesTools,
        systemPrompt: effectivePrompt,
        signal,
        onText: (delta) => emit({ type: "text", delta }),
        onToolCallStart: (name) => emit({ type: "tool_start", name }),
      });
    } catch (error) {
      emit({ type: "error", message: error.message });
      return { text: finalText, error: error.message, steps: step };
    }

    if (result.aborted) {
      emit({ type: "aborted" });
      return { text: finalText, aborted: true, steps: step };
    }

    if (result.text) {
      finalText += result.text;
      history.push({ role: "assistant", content: result.text });
    }

    if (!result.toolCalls.length) {
      emit({ type: "done", steps: step, usage: result.usage, model: result.model });
      return { text: finalText, steps: step, usage: result.usage, model: result.model };
    }

    for (const call of result.toolCalls) {
      history.push({
        type: "function_call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      });

      emit({ type: "tool_call", name: call.name, arguments: call.arguments, callId: call.callId });

      const output = await executeTool(call, {
        computer,
        approve: opts.approve,
        listBots,
        delegate,
        listSkills,
        readSkill,
        mcpCall,
        messageBot,
        groupChat,
        remember,
        recall,
        forget,
        onFileChange: (info) => emit({ type: "file_change", ...info }),
        onCommand: (info) => emit({ type: "command_done", ...info }),
      });

      emit({
        type: "tool_result",
        name: call.name,
        callId: call.callId,
        output: output.length > 1200 ? output.slice(0, 1200) + "\n…" : output,
        fullLength: output.length,
      });

      history.push({ type: "function_call_output", callId: call.callId, output });
    }
  }

  emit({ type: "max_steps", steps: maxSteps });
  return { text: finalText, steps: maxSteps, maxStepsReached: true };
}

module.exports = { runAgent, DEFAULT_MAX_STEPS };
