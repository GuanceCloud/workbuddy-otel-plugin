import * as fs from "node:fs/promises";

import { safeJsonParse, sha256, stableStringify, timestampMs, toText } from "./workbuddy-utils.js";

function providerData(item) {
  return item?.providerData && typeof item.providerData === "object" ? item.providerData : {};
}

function contentParts(item) {
  if (!Array.isArray(item?.content)) return [];
  return item.content.filter((part) => part && typeof part === "object");
}

export function messageText(item) {
  if (typeof item?.content === "string") return item.content;
  return contentParts(item)
    .filter((part) => ["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function reasoningText(item) {
  return contentParts(item)
    .filter((part) => ["reasoning", "thinking"].includes(part.type))
    .map((part) => part.text ?? part.thinking ?? "")
    .filter(Boolean)
    .join("\n");
}

function hiddenUser(item) {
  const data = providerData(item);
  return data.skipRun === true
    || data.isMeta === true
    || data.isCompactInternal === true
    || data.isCompact === true
    || data.isTeammateMessage === true
    || String(data.agentPurpose ?? "").toLowerCase().includes("compact");
}

export function isRealUserMessage(item) {
  return item?.type === "message"
    && item?.role === "user"
    && !hiddenUser(item)
    && messageText(item).trim().length > 0;
}

function itemTime(item, fallback) {
  return timestampMs(item?.timestamp) ?? fallback;
}

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function usageOf(item) {
  const usage = item?.message?.usage ?? providerData(item).usage ?? {};
  return {
    inputTokens: number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    outputTokens: number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens ?? usage.cached_tokens ?? usage.cacheReadInputTokens),
    cacheCreationTokens: number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    reasoningTokens: number(usage.reasoning_output_tokens ?? usage.reasoning_tokens),
  };
}

function modelOf(item) {
  const data = providerData(item);
  return data.model ?? data.modelId ?? item?.model;
}

function providerOf(item) {
  const data = providerData(item);
  return data.provider ?? data.providerName ?? data.modelProvider;
}

function toolArguments(item) {
  if (item?.arguments && typeof item.arguments === "object") return item.arguments;
  if (typeof item?.arguments !== "string") return item?.arguments;
  return safeJsonParse(item.arguments, item.arguments);
}

function toolResult(item) {
  const output = item?.output;
  if (output?.type === "text" && typeof output.text === "string") {
    return safeJsonParse(output.text, output.text);
  }
  return output ?? providerData(item).toolResult ?? item?.result;
}

function toolError(item) {
  const data = providerData(item);
  return item?.status === "incomplete"
    || item?.is_error === true
    || data.error != null
    || data.isError === true;
}

function toolHookKey(name, input) {
  return `${name || "unknown"}:${stableStringify(input ?? null)}`;
}

function buildToolTimingIndex(events) {
  const pendingById = new Map();
  const pendingByKey = new Map();
  const completedById = new Map();
  const completedByKey = new Map();

  for (const event of events) {
    if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event.hook_event_name)) continue;
    const id = event.call_id;
    const key = toolHookKey(event.tool_name, event.tool_input);
    if (event.hook_event_name === "PreToolUse") {
      const timing = { startMs: event.observed_at };
      if (id) pendingById.set(id, timing);
      const queue = pendingByKey.get(key) ?? [];
      queue.push(timing);
      pendingByKey.set(key, queue);
      continue;
    }

    let timing = id ? pendingById.get(id) : undefined;
    if (!timing) timing = (pendingByKey.get(key) ?? []).shift();
    const completed = {
      startMs: timing?.startMs,
      endMs: event.observed_at,
      isError: event.hook_event_name === "PostToolUseFailure",
      error: event.error,
    };
    if (id) completedById.set(id, completed);
    const queue = completedByKey.get(key) ?? [];
    queue.push(completed);
    completedByKey.set(key, queue);
  }
  return { completedById, completedByKey };
}

function collectTools(items, hookEvents) {
  const calls = [];
  const results = new Map();
  for (const item of items) {
    if (item?.type === "function_call") {
      calls.push({
        id: item.callId ?? item.call_id ?? item.id,
        itemId: item.id,
        name: item.name ?? "unknown",
        arguments: toolArguments(item),
        startMs: itemTime(item),
      });
    } else if (["function_call_result", "function_call_output"].includes(item?.type)) {
      results.set(item.callId ?? item.call_id ?? item.id, {
        result: toolResult(item),
        endMs: itemTime(item),
        isError: toolError(item),
        error: providerData(item).error,
        status: item.status,
      });
    }
  }

  const timing = buildToolTimingIndex(hookEvents);
  return calls.map((call) => {
    const result = results.get(call.id) ?? {};
    const key = toolHookKey(call.name, call.arguments);
    const measured = timing.completedById.get(call.id) ?? (timing.completedByKey.get(key) ?? []).shift() ?? {};
    return {
      ...call,
      ...result,
      startMs: measured.startMs ?? call.startMs,
      endMs: measured.endMs ?? result.endMs ?? call.startMs,
      isError: measured.isError ?? result.isError ?? false,
      error: measured.error ?? result.error,
      timingSource: measured.startMs ? "hook" : "transcript",
    };
  });
}

function outputMessage(item) {
  if (item.type === "function_call") {
    return {
      role: "assistant",
      parts: [{
        type: "tool_call",
        id: item.callId ?? item.call_id ?? item.id,
        name: item.name,
        arguments: toolArguments(item),
      }],
    };
  }
  const parts = [];
  const text = messageText(item);
  const reasoning = reasoningText(item);
  if (reasoning) parts.push({ type: "reasoning", content: reasoning });
  if (text) parts.push({ type: "text", content: text });
  return { role: "assistant", parts };
}

function collectLlmCalls(items, prompt) {
  const out = [];
  let boundaryMs = itemTime(items[0], Date.now());
  let pendingInput = [{ role: "user", parts: [{ type: "text", content: prompt }] }];
  for (const item of items.slice(1)) {
    if (["function_call_result", "function_call_output"].includes(item?.type)) {
      boundaryMs = itemTime(item, boundaryMs);
      pendingInput = [{
        role: "tool",
        tool_call_id: item.callId ?? item.call_id ?? item.id,
        parts: [{ type: "tool_call_response", content: toolResult(item) }],
      }];
      continue;
    }
    const isModelOutput = (item?.type === "message" && item?.role === "assistant") || item?.type === "function_call";
    if (!isModelOutput) continue;
    const usage = usageOf(item);
    const model = modelOf(item);
    if (!model && !Object.values(usage).some((value) => value !== undefined) && item.type === "message" && !messageText(item)) continue;
    const endMs = itemTime(item, boundaryMs);
    out.push({
      item,
      id: item.id,
      startMs: boundaryMs,
      endMs,
      timingSource: "inferred",
      model,
      provider: providerOf(item),
      usage,
      inputMessages: pendingInput,
      outputMessages: [outputMessage(item)],
      outputKind: item.type === "function_call" ? "tool_call" : "text",
      finishReason: item.type === "function_call" ? "tool_call" : "stop",
    });
    boundaryMs = endMs;
    pendingInput = [];
  }
  return out;
}

function terminalState(items, options) {
  const lastAssistant = [...items].reverse().find((item) => item?.type === "message" && item?.role === "assistant" && messageText(item));
  if (lastAssistant && !["incomplete", "failed", "cancelled"].includes(lastAssistant.status)) return "completed";
  if (options.forceCancelled) return "cancelled";
  return options.hasFollowingTurn ? "completed" : "unset";
}

function association(hookEvents) {
  const subagent = hookEvents.find((event) => event.hook_event_name === "SubagentStart") ?? {};
  const channelEvent = hookEvents.find((event) => event.session_channel || event.source || event.trigger) ?? {};
  return {
    agentId: subagent.agent_id,
    agentType: subagent.agent_type,
    parentSessionId: subagent.parent_session_id,
    parentToolCallId: subagent.parent_tool_call_id,
    observedSessionChannel: channelEvent.session_channel ?? channelEvent.source ?? channelEvent.trigger,
  };
}

function buildTurn(items, hookInput, hookEvents, options) {
  const first = items[0];
  const last = items.at(-1) ?? first;
  const prompt = messageText(first);
  const assistantMessages = items.filter((item) => item?.type === "message" && item?.role === "assistant" && messageText(item));
  const output = messageText(assistantMessages.at(-1));
  const tools = collectTools(items, hookEvents);
  const llmCalls = collectLlmCalls(items, prompt);
  const finalStatus = terminalState(items, options);
  const related = association(hookEvents);
  const turnId = first.id || sha256(`${hookInput.session_id}:${first.timestamp}:${prompt}`).slice(0, 32);
  const startMs = itemTime(first, Date.now());
  const endMs = Math.max(
    startMs + 1,
    itemTime(last, startMs + 1),
    ...tools.map((tool) => tool.endMs).filter(Number.isFinite),
  );
  return {
    sessionId: hookInput.session_id,
    turnId,
    transcriptPath: hookInput.transcript_path,
    cwd: hookInput.cwd,
    prompt,
    output,
    items,
    llmCalls,
    tools,
    startMs,
    endMs,
    finalStatus,
    sessionChannel: hookInput.session_channel ?? hookInput.source ?? hookInput.trigger ?? related.observedSessionChannel,
    isSubagent: hookInput.hook_event_name === "SubagentStop" || hookEvents.some((event) => event.hook_event_name === "SubagentStart"),
    agentId: related.agentId,
    agentType: related.agentType,
    parentSessionId: related.parentSessionId,
    parentToolCallId: related.parentToolCallId,
  };
}

export async function readTranscript(transcriptPath) {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => safeJsonParse(line)).filter(Boolean);
}

export function parseTurns(items, hookInput, hookEvents = []) {
  const starts = [];
  items.forEach((item, index) => { if (isRealUserMessage(item)) starts.push(index); });
  const terminalEvent = hookInput.hook_event_name;
  const sessionCreateAt = itemTime(items[0]);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? items.length;
    const isLast = index === starts.length - 1;
    return {
      ...buildTurn(items.slice(start, end), hookInput, hookEvents, {
      hasFollowingTurn: !isLast,
      forceCancelled: isLast && terminalEvent === "SessionEnd" && !["completed", "clear"].includes(hookInput.reason),
      }),
      sessionCreateAt,
    };
  }).filter((turn) => turn.prompt || turn.output || turn.tools.length > 0 || turn.llmCalls.length > 0);
}

export function transcriptFingerprint(items) {
  const last = items.at(-1) ?? {};
  return sha256(`${items.length}:${last.id ?? ""}:${last.timestamp ?? ""}:${toText(last.type)}`);
}
