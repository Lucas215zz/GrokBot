// Agent 循环：模型 -> 工具调用 -> 回传结果 -> 再问模型，直到给出最终答复。

import { executeTool } from "./executor";
import { toResponsesTools, BUILTIN_TOOLS } from "./registry";
import { renderForcedSkills } from "./context";

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_CONTINUATIONS = 2;

export async function runAgent(opts) {
  const {
    client, history, systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    maxContinuations = DEFAULT_MAX_CONTINUATIONS,
    signal, emit,
    tools = BUILTIN_TOOLS,
    computer,
    listBots, delegate, listSkills, readSkill,
    mcpTools = [], mcpCall,
    messageBot, groupChat, approve,
    remember, recall, forget,
    forcedSkills = [], mentionMissing = [],
    report,
  } = opts;

  const responsesTools = [...toResponsesTools(tools), ...mcpTools];
  let finalText = "";

  const skills = listSkills ? listSkills() : [];
  const skillSection = skills.length
    ? [
        "",
        "## 可用技能",
        "执行任务前先看这里。若有匹配的技能，必须先调用 use_skill 读取完整步骤，再严格按步骤做；不要凭猜测操作。",
        forcedSkills.length ? "（本次被 @ 指定的技能已直接加载正文，无需再对它调用 use_skill。）" : "",
        ...skills.map((s) => `- ${s.name}${s.description ? "：" + s.description : ""}`),
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const forcedSkillsSection = renderForcedSkills(forcedSkills, mentionMissing);
  if (forcedSkills.length) {
    emit({
      type: "skill_loaded",
      skills: forcedSkills.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled !== false })),
    });
  }

  const effectivePrompt = (systemPrompt || "") + skillSection + forcedSkillsSection;

  const reportSection = report
    ? [
        "",
        "## 必须上报执行结果（本轮为无人值守的定时任务）",
        "在给出最终答复之前，**必须**调用一次 report_result 工具，如实填写 status=success/blocked/failed。",
        "只写文字总结而不调用 report_result，会被系统判为「未上报」= 失败。",
      ].join("\n")
    : "";
  const finishRule = [
    "",
    "## 结束本轮的硬性要求",
    "- 只有在「任务真的完成」或「确实卡住、需要用户提供信息/授权」时，才可以结束本轮并给出最终答复。",
    "- **禁止**用「我继续」「稍等」「正在加载」这类进度旁白当作结束语；还没做完就继续调用工具，不要停。",
    "- 若卡住，必须明确写出：卡在哪一步、缺什么、需要用户做什么。",
  ].join("\n");
  const finalPrompt = effectivePrompt + reportSection + finishRule;

  const continuationSection = (n, max) =>
    [
      "",
      `## 自动续跑（第 ${n}/${max} 次）`,
      "上一批步数用尽，但你仍在调用工具，说明任务还没做完。请继续把剩下的步骤做完，不要重新开始。",
    ].join("\n");

  let totalSteps = 0;
  let continuation = 0;

  for (;;) {
    const batchPrompt =
      continuation === 0 ? finalPrompt : finalPrompt + continuationSection(continuation, maxContinuations);

    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) {
        emit({ type: "aborted" });
        return { text: finalText, aborted: true, steps: totalSteps };
      }

      totalSteps++;
      emit({ type: "step", step: totalSteps, maxSteps });

      let result;
      try {
        result = await client.stream({
          messages: history,
          tools: responsesTools,
          systemPrompt: batchPrompt,
          signal,
          onText: (delta) => emit({ type: "text", delta }),
          onToolCallStart: (name) => emit({ type: "tool_start", name }),
        });
      } catch (error) {
        emit({ type: "error", message: error.message });
        return { text: finalText, error: error.message, steps: totalSteps };
      }

      if (result.aborted) {
        emit({ type: "aborted" });
        return { text: finalText, aborted: true, steps: totalSteps };
      }

      if (result.text) {
        finalText += result.text;
        history.push({ role: "assistant", content: result.text });
      }

      if (!result.toolCalls.length) {
        emit({ type: "done", steps: totalSteps, usage: result.usage, model: result.model });
        return { text: finalText, steps: totalSteps, usage: result.usage, model: result.model, report: report || null };
      }

      for (const call of result.toolCalls) {
        history.push({ type: "function_call", callId: call.callId, name: call.name, arguments: call.arguments });
        emit({ type: "tool_call", name: call.name, arguments: call.arguments, callId: call.callId });

        const output = await executeTool(call, {
          computer,
          approve: opts.approve,
          listBots, delegate, listSkills, readSkill,
          mcpCall, messageBot, groupChat,
          remember, recall, forget,
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

    if (continuation < maxContinuations) {
      continuation++;
      emit({ type: "continuing", batch: continuation, maxContinuations, steps: totalSteps });
      continue;
    }

    emit({ type: "max_steps", steps: totalSteps, maxSteps, continuations: continuation });
    return {
      text: finalText,
      steps: totalSteps,
      maxStepsReached: true,
      continuations: continuation,
      report: report || null,
    };
  }
}

export { DEFAULT_MAX_STEPS };
