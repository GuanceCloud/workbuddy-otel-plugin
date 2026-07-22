const TOKEN_ATTRIBUTE_TYPES = [
  ["gen_ai.usage.input_tokens", "input"],
  ["gen_ai.usage.output_tokens", "output"],
];

const WORKFLOW_DURATION = {
  name: "gen_ai.workflow.duration",
  type: "histogram",
  unit: "s",
  description: "GenAI workflow duration.",
};

const OPERATION_COUNT = {
  name: "gen_ai.agent.operation.count",
  type: "sum",
  unit: "",
  description: "Agent-side operation count.",
};

const OPERATION_DURATION = {
  name: "gen_ai.agent.operation.duration",
  type: "histogram",
  unit: "ms",
  description: "Agent-side operation duration.",
};

const TOKEN_USAGE = {
  name: "gen_ai.client.token.usage",
  type: "histogram",
  unit: "{token}",
  description: "Number of input and output tokens used.",
};

function setAttr(attributes, key, value) {
  if (value !== undefined && value !== null && value !== "") attributes[key] = value;
}

function finitePositive(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function spanDurationSeconds(span) {
  try {
    const start = BigInt(span.start_time_unix_nano ?? 0);
    const end = BigInt(span.end_time_unix_nano ?? 0);
    if (start > 0n && end > start) return Number(end - start) / 1_000_000_000;
  } catch {
    return undefined;
  }
  return undefined;
}

function spanDurationMs(span) {
  const seconds = spanDurationSeconds(span);
  return seconds === undefined ? undefined : seconds * 1000;
}

function statusCode(span) {
  return String(span.status?.code ?? "").toUpperCase();
}

function operationStatus(span) {
  if (span.attributes?.status === "error" || statusCode(span).includes("ERROR")) return "error";
  return "ok";
}

function workflowStatus(span) {
  if (span.attributes?.final_status === "completed") return "completed";
  if (span.attributes?.status === "error" || statusCode(span).includes("ERROR")) return "error";
  return span.attributes?.status ?? "completed";
}

function metric(meta, span, value, attributes) {
  return {
    ...meta,
    value,
    attributes,
    resource: span.resource ?? {},
    scope: span.scope ?? {},
    start_time_unix_nano: span.start_time_unix_nano,
    time_unix_nano: span.end_time_unix_nano ?? span.start_time_unix_nano,
  };
}

function baseAttrs(span) {
  const attributes = {};
  setAttr(attributes, "gen_ai.conversation.id", span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "session_id", span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "gen_ai.operation.name", span.attributes?.["gen_ai.operation.name"]);
  setAttr(attributes, "status", operationStatus(span));
  setAttr(attributes, "gen_ai.provider.name", span.attributes?.["gen_ai.provider.name"]);
  setAttr(attributes, "gen_ai.request.model", span.attributes?.["gen_ai.request.model"]);
  setAttr(attributes, "gen_ai.response.model", span.attributes?.["gen_ai.response.model"]);
  if (operationStatus(span) === "error") setAttr(attributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  return attributes;
}

function countAttrs(span) {
  const attributes = {};
  setAttr(attributes, "gen_ai.operation.name", span.attributes?.["gen_ai.operation.name"]);
  setAttr(attributes, "status", operationStatus(span));

  if (span.name === "llm") {
    setAttr(attributes, "gen_ai.provider.name", span.attributes?.["gen_ai.provider.name"]);
    setAttr(attributes, "gen_ai.request.model", span.attributes?.["gen_ai.request.model"]);
    setAttr(attributes, "gen_ai.response.model", span.attributes?.["gen_ai.response.model"]);
  } else if (String(span.name).startsWith("tool:")) {
    setAttr(attributes, "gen_ai.tool.name", span.attributes?.["gen_ai.tool.name"]);
  } else if (String(span.name).startsWith("skill:")) {
    setAttr(attributes, "gen_ai.skill.name", span.attributes?.["gen_ai.skill.name"]);
  }

  if (operationStatus(span) === "error") setAttr(attributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  return attributes;
}

function workflowMetrics(span) {
  if (span.attributes?.final_status === "unset") return [];
  const duration = spanDurationSeconds(span);
  if (duration === undefined || duration <= 0) return [];
  const attributes = {};
  setAttr(attributes, "gen_ai.conversation.id", span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "session_id", span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "final_status", span.attributes?.final_status);
  setAttr(attributes, "status", workflowStatus(span));
  if (workflowStatus(span) === "error") setAttr(attributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  return [metric(WORKFLOW_DURATION, span, duration, attributes)];
}

function operationDurationMetric(span, attributes) {
  const durationMs = spanDurationMs(span);
  if (durationMs === undefined || durationMs <= 0) return undefined;
  return metric(OPERATION_DURATION, span, durationMs, attributes);
}

function llmMetrics(span) {
  const out = [metric(OPERATION_COUNT, span, 1, countAttrs(span))];
  const duration = operationDurationMetric(span, baseAttrs(span));
  if (duration) out.push(duration);

  for (const [attributeName, tokenType] of TOKEN_ATTRIBUTE_TYPES) {
    const value = finitePositive(span.attributes?.[attributeName]);
    if (value === undefined) continue;
    const attributes = {};
    setAttr(attributes, "gen_ai.conversation.id", span.attributes?.["gen_ai.conversation.id"]);
    setAttr(attributes, "session_id", span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"]);
    setAttr(attributes, "gen_ai.token.type", tokenType);
    setAttr(attributes, "gen_ai.provider.name", span.attributes?.["gen_ai.provider.name"]);
    setAttr(attributes, "gen_ai.request.model", span.attributes?.["gen_ai.request.model"]);
    setAttr(attributes, "gen_ai.response.model", span.attributes?.["gen_ai.response.model"]);
    out.push(metric(TOKEN_USAGE, span, value, attributes));
  }
  return out;
}

function toolMetrics(span) {
  const attributes = baseAttrs(span);
  setAttr(attributes, "gen_ai.tool.name", span.attributes?.["gen_ai.tool.name"]);
  const out = [metric(OPERATION_COUNT, span, 1, countAttrs(span))];
  const duration = operationDurationMetric(span, attributes);
  if (duration) out.push(duration);
  return out;
}

function skillMetrics(span) {
  const attributes = baseAttrs(span);
  setAttr(attributes, "gen_ai.skill.name", span.attributes?.["gen_ai.skill.name"]);
  const out = [metric(OPERATION_COUNT, span, 1, countAttrs(span))];
  const duration = operationDurationMetric(span, attributes);
  if (duration) out.push(duration);
  return out;
}

export function buildWorkBuddyMetrics(spans = []) {
  const metrics = [];
  for (const span of spans) {
    if (span.name === "invoke_agent") metrics.push(...workflowMetrics(span));
    else if (span.name === "llm") metrics.push(...llmMetrics(span));
    else if (String(span.name).startsWith("tool:")) metrics.push(...toolMetrics(span));
    else if (String(span.name).startsWith("skill:")) metrics.push(...skillMetrics(span));
  }
  return metrics;
}
