import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { randomSpanId, randomTraceId, redactAndClip, toNs, toText, truncate } from "./workbuddy-utils.js";

export const PLUGIN_VERSION = "0.1.7";

function nsString(value) {
  return value.toString();
}

function span({ traceId, spanId, parentId, name, startMs, endMs, attributes, status }) {
  const start = toNs(startMs);
  let end = toNs(endMs, startMs + 1);
  if (end <= start) end = start + 1_000_000n;
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_id: parentId,
    name,
    kind: "SPAN_KIND_INTERNAL",
    start_time_unix_nano: nsString(start),
    end_time_unix_nano: nsString(end),
    attributes,
    status: status ?? { code: "STATUS_CODE_OK" },
  };
}

function resource(config, hookInput, turn) {
  const version = hookInput.workbuddy_version
    ?? hookInput.version
    ?? process.env.WORKBUDDY_VERSION
    ?? process.env.CODEBUDDY_VERSION;
  return {
    "service.name": "gtrace-workbuddy",
    "service.namespace": "ai-agent",
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.name": "gtrace",
    "telemetry.sdk.version": PLUGIN_VERSION,
    host: os.hostname(),
    agent_id: turn.agentId ?? "workbuddy",
    agent_name: turn.agentType ?? (turn.isSubagent ? "WorkBuddy Subagent" : "WorkBuddy"),
    agent_runtime: "workbuddy",
    ...(version ? { agent_version: String(version) } : {}),
    ...(config.resourceAttributes ?? {}),
  };
}

function scope() {
  return { name: "workbuddy-otel-plugin", version: PLUGIN_VERSION };
}

function conversation(turn) {
  return {
    "gen_ai.conversation.id": turn.sessionId,
    session_id: turn.sessionId,
    "gen_ai.turn.id": turn.turnId,
    turn_id: turn.turnId,
  };
}

function normalizePreview(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

function messagePreview(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return normalizePreview(value);
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => messagePreview(entry)).filter(Boolean);
    return normalizePreview(parts.join("\n"));
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.parts)) {
      const parts = value.parts.map((part) => messagePreview(part)).filter(Boolean);
      return normalizePreview(parts.join("\n"));
    }
    switch (value.type) {
      case "text":
      case "input_text":
      case "output_text":
        return messagePreview(value.content ?? value.text);
      case "reasoning":
      case "thinking":
        return messagePreview(value.content ?? value.text ?? value.thinking);
      case "tool_call":
        return normalizePreview([
          typeof value.name === "string" ? value.name : undefined,
          value.arguments != null ? toText(value.arguments) : undefined,
        ].filter(Boolean).join(" "));
      case "tool_call_response":
        return messagePreview(value.content);
      default: {
        const parts = Object.values(value).map((entry) => messagePreview(entry)).filter(Boolean);
        if (parts.length > 0) return normalizePreview(parts.join("\n"));
      }
    }
  }
  return normalizePreview(toText(value));
}

function previews(input, output, config) {
  const inputText = messagePreview(input) ?? "";
  const outputText = messagePreview(output) ?? "";
  const inputPreview = config.capture_content ? messagePreview(redactAndClip(input, config.max_chars)) : undefined;
  const outputPreview = config.capture_content ? messagePreview(redactAndClip(output, config.max_chars)) : undefined;
  return {
    input_preview: inputPreview ? truncate(inputPreview, config.max_chars) : undefined,
    input_length: inputText.length,
    output_preview: outputPreview ? truncate(outputPreview, config.max_chars) : undefined,
    output_length: outputText.length,
  };
}

function captured(value, config) {
  return config.capture_content ? redactAndClip(value, config.max_chars) : undefined;
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => strings(entry, out));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => strings(entry, out));
  return out;
}

function skillPaths(value, cwd) {
  const out = [];
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (path.basename(trimmed.replace(/:\d+(?::\d+)?$/, "")) === "SKILL.md") {
    const file = trimmed.replace(/:\d+(?::\d+)?$/, "");
    out.push(path.isAbsolute(file) ? file : path.resolve(cwd, file));
  }
  const pattern = /(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\s'"`]*SKILL\.md/g;
  for (const match of value.matchAll(pattern)) {
    const file = match[0];
    out.push(path.isAbsolute(file) ? file : path.resolve(cwd, file));
  }
  return out;
}

async function isFile(file) {
  return Boolean(await fs.stat(file).then((stat) => stat.isFile()).catch(() => false));
}

function skillSource(file, config) {
  const normalized = path.resolve(file);
  if (normalized.includes(`${path.sep}plugins${path.sep}`)) return "plugin";
  if (normalized.includes(`${path.sep}builtin-skills${path.sep}`)) return "builtin";
  if (normalized.startsWith(path.resolve(config.configDir, "skills"))) return "user";
  return "project";
}

async function frontmatter(file) {
  const raw = await fs.readFile(file, "utf-8").catch(() => "");
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const values = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (match && match[2]) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

async function namedSkillCandidates(name, turn, config) {
  const cwd = turn.cwd || process.cwd();
  const candidates = [
    path.join(config.configDir, "skills", name, "SKILL.md"),
    path.join(cwd, ".workbuddy", "skills", name, "SKILL.md"),
    path.join(cwd, ".codebuddy", "skills", name, "SKILL.md"),
  ];
  for (const root of [process.env.WORKBUDDY_BUILTIN_SKILLS_DIR, process.env.CODEBUDDY_BUILTIN_SKILLS_DIR]) {
    if (root) candidates.push(path.join(root, name, "SKILL.md"));
  }
  const marketplaces = path.join(config.configDir, "plugins", "marketplaces");
  for (const marketplace of await fs.readdir(marketplaces).catch(() => [])) {
    const plugins = path.join(marketplaces, marketplace, "plugins");
    for (const plugin of await fs.readdir(plugins).catch(() => [])) {
      candidates.push(path.join(plugins, plugin, "skills", name, "SKILL.md"));
    }
  }
  return candidates;
}

async function skillForTool(tool, turn, config) {
  const candidates = [];
  for (const value of strings(tool.arguments)) {
    candidates.push(...skillPaths(value, turn.cwd || process.cwd()));
  }
  if (String(tool.name).toLowerCase() === "skill") {
    const name = tool.arguments?.skill ?? tool.arguments?.name;
    if (typeof name === "string" && name.trim()) {
      candidates.push(...await namedSkillCandidates(name.trim(), turn, config));
    }
  }
  let file;
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (await isFile(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) return undefined;
  const metadata = await frontmatter(file);
  return {
    name: metadata.name || path.basename(path.dirname(file)),
    path: path.resolve(file),
    source: skillSource(file, config),
    description: metadata.description,
    version: metadata.version,
  };
}

function commonAttrs(turn) {
  return {
    "gen_ai.system": "workbuddy",
    ...conversation(turn),
  };
}

export async function buildWorkBuddySpans(config, hookInput, turn) {
  const traceId = randomTraceId();
  const rootId = randomSpanId();
  const finalLlm = turn.llmCalls.at(-1);
  const rootStatus = turn.finalStatus === "unset" ? "error" : "ok";
  const root = span({
    traceId,
    spanId: rootId,
    name: "invoke_agent",
    startMs: turn.startMs,
    endMs: turn.endMs,
    attributes: {
      "span.kind": "internal",
      "gen_ai.operation.name": "invoke_agent",
      ...commonAttrs(turn),
      status: rootStatus,
      final_status: turn.finalStatus,
      tool_count: turn.tools.length,
      session_channel: turn.sessionChannel,
      session_create_at: turn.sessionCreateAt ? new Date(turn.sessionCreateAt).toISOString() : undefined,
      session_updated_at: new Date(turn.endMs).toISOString(),
      "gen_ai.request.model": finalLlm?.model,
      "gen_ai.response.model": finalLlm?.model,
      "gen_ai.provider.name": finalLlm?.provider,
      "gen_ai.output.type": "text",
      "gen_ai.response.finish_reasons": [turn.finalStatus === "cancelled" ? "cancelled" : "stop"],
      "gen_ai.input.messages": captured([{ role: "user", parts: [{ type: "text", content: turn.prompt }] }], config),
      "gen_ai.output.messages": captured([{ role: "assistant", parts: [{ type: "text", content: turn.output }] }], config),
      parent_session_id: turn.parentSessionId,
      parent_tool_call_id: turn.parentToolCallId,
      ...previews(turn.prompt, turn.output, config),
    },
    status: rootStatus === "error"
      ? { code: "STATUS_CODE_ERROR", message: "turn has no terminal status" }
      : { code: "STATUS_CODE_OK" },
  });
  const spans = [root];
  const toolCallToLlm = new Map();

  for (const [index, call] of turn.llmCalls.entries()) {
    const llmId = randomSpanId();
    if (call.item?.type === "function_call") {
      toolCallToLlm.set(call.item.callId ?? call.item.call_id ?? call.item.id, llmId);
    }
    spans.push(span({
      traceId,
      spanId: llmId,
      parentId: rootId,
      name: "llm",
      startMs: call.startMs,
      endMs: call.endMs,
      attributes: {
        "span.kind": "client",
        "gen_ai.operation.name": "chat",
        ...commonAttrs(turn),
        status: "ok",
        "gen_ai.request.model": call.model,
        "gen_ai.response.model": call.model,
        "gen_ai.provider.name": call.provider,
        "gen_ai.usage.input_tokens": call.usage.inputTokens,
        "gen_ai.usage.output_tokens": call.usage.outputTokens,
        "gen_ai.usage.cache_read.input_tokens": call.usage.cacheReadTokens,
        "gen_ai.usage.cache_creation.input_tokens": call.usage.cacheCreationTokens,
        "gen_ai.usage.reasoning.output_tokens": call.usage.reasoningTokens,
        "gen_ai.input.messages": captured(call.inputMessages, config),
        "gen_ai.output.messages": captured(call.outputMessages, config),
        "gen_ai.output.type": call.outputKind,
        "gen_ai.response.finish_reasons": [call.finishReason],
        output_kind: call.outputKind,
        "timing.source": call.timingSource,
        "workbuddy.llm.sequence": index + 1,
        ...previews(call.inputMessages, call.outputMessages, config),
      },
    }));

    for (const assistant of call.assistantMessages ?? []) {
      spans.push(span({
        traceId,
        spanId: randomSpanId(),
        parentId: rootId,
        name: "assistant",
        startMs: assistant.startMs,
        endMs: assistant.endMs + 1,
        attributes: {
          "span.kind": "internal",
          ...commonAttrs(turn),
          status: "ok",
          "gen_ai.request.model": call.model,
          "gen_ai.response.model": call.model,
          "gen_ai.provider.name": call.provider,
          "gen_ai.output.messages": captured(assistant.outputMessages, config),
          "gen_ai.output.type": "text",
          output_kind: "text",
          ...previews(undefined, assistant.outputMessages, config),
        },
      }));
    }
  }

  for (const tool of turn.tools) {
    const toolSpanId = randomSpanId();
    const toolStatus = tool.isError ? "error" : "ok";
    spans.push(span({
      traceId,
      spanId: toolSpanId,
      parentId: rootId,
      name: `tool:${tool.name}`,
      startMs: tool.startMs ?? turn.startMs,
      endMs: tool.endMs ?? tool.startMs ?? turn.endMs,
      attributes: {
        "span.kind": "internal",
        "gen_ai.operation.name": "execute_tool",
        ...commonAttrs(turn),
        status: toolStatus,
        "gen_ai.tool.name": tool.name,
        "gen_ai.tool.call.id": tool.id,
        "gen_ai.tool.call.arguments": captured(tool.arguments, config),
        "gen_ai.tool.call.result": captured(tool.result, config),
        tool_result_status: tool.isError ? "error" : "completed",
        reason: tool.error ? truncate(toText(tool.error), config.max_chars) : undefined,
        "triggered_by.llm_span_id": toolCallToLlm.get(tool.id),
        "timing.source": tool.timingSource,
      },
      status: tool.isError
        ? { code: "STATUS_CODE_ERROR", message: truncate(toText(tool.error || "tool error"), 1000) }
        : { code: "STATUS_CODE_OK" },
    }));

    const skill = await skillForTool(tool, turn, config);
    if (skill) {
      spans.push(span({
        traceId,
        spanId: randomSpanId(),
        parentId: toolSpanId,
        name: `skill:${skill.name}`,
        startMs: tool.startMs ?? turn.startMs,
        endMs: tool.endMs ?? tool.startMs ?? turn.endMs,
        attributes: {
          "span.kind": "internal",
          "gen_ai.operation.name": "skill",
          ...commonAttrs(turn),
          status: toolStatus,
          "gen_ai.skill.name": skill.name,
          "gen_ai.skill.path": skill.path,
          "gen_ai.skill.source.type": skill.source,
          "gen_ai.skill.result.status": tool.isError ? "error" : "completed",
          "gen_ai.skill.description": skill.description,
          "gen_ai.skill.version": skill.version,
          "skill.name": skill.name,
          skill_call_id: tool.id,
        },
        status: tool.isError
          ? { code: "STATUS_CODE_ERROR", message: "skill tool failed" }
          : { code: "STATUS_CODE_OK" },
      }));
    }
  }

  const spanResource = resource(config, hookInput, turn);
  for (const item of spans) {
    item.resource = spanResource;
    item.scope = scope();
  }
  return spans;
}
