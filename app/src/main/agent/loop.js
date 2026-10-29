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
    // 任务结果的真实上报口：模型调用 report_result 时写入这里。
    // 例程（无人值守）据此判定成功/失败，避免「只写文字没做成」被记成成功。
    report,
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

  // 无人值守（例程）运行时：要求模型在结束前必须汇报真实结果。
  // 这样调度器能区分「做成了」和「只是说了句话」，避免假成功。
  const reportSection = report
    ? [
        "",
        "## 必须上报执行结果（本轮为无人值守的定时任务）",
        "在给出最终答复之前，**必须**调用一次 report_result 工具，如实填写：",
        "- status=success：任务目标全部达成",
        "- status=blocked：因缺少登录/授权/必要数据而无法完成（不是你的错，但要如实报）",
        "- status=failed：执行过程中出错，未能完成",
        "只写文字总结而不调用 report_result，会被系统判为「未上报」= 失败。不要为了避免失败而谎报 success。",
      ].join("\n")
    : "";
  const finalPrompt = effectivePrompt + reportSection;

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
        systemPrompt: finalPrompt,
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
      return { text: finalText, steps: step, usage: result.usage, model: result.model, report: report || null };
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
        reportResult: report
          ? (r) => {
              report.status = r.status;
              report.summary = r.summary;
              report.details = r.details;
              report.reportedAt = Date.now();
            }
          : undefined,
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
  return { text: finalText, steps: maxSteps, maxStepsReached: true, report: report || null };
}

module.exports = { runAgent, DEFAULT_MAX_STEPS };
