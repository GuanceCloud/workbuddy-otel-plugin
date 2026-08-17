import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import { resolveConfig } from "../src/workbuddy-config.js";
import { buildWorkBuddyMetrics } from "../src/workbuddy-metrics.js";
import { parseTurns, readTranscript } from "../src/workbuddy-parse.js";
import { buildWorkBuddySpans } from "../src/workbuddy-spans.js";
import { runHook } from "../src/workbuddy-hook.js";
import { decodeExportMetricsServiceRequest, decodeExportTraceServiceRequest } from "../src/proto.js";

const fixture = path.resolve("test/fixtures/workbuddy-5.2.6.jsonl");
let tempDir;
let transcript;
let projectDir;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-otel-test-"));
  projectDir = path.join(tempDir, "project");
  transcript = path.join(tempDir, "session.jsonl");
  await fs.mkdir(path.join(projectDir, ".workbuddy", "skills", "demo"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".workbuddy", "skills", "demo", "SKILL.md"), [
    "---",
    "name: demo",
    "description: Test demo skill",
    "version: 1.2.3",
    "---",
    "",
    "# Demo",
  ].join("\n"));
  const fixtureProjectDir = projectDir.replaceAll("\\", "\\\\");
  const raw = (await fs.readFile(fixture, "utf-8")).replaceAll("/tmp/workbuddy-project", fixtureProjectDir);
  await fs.writeFile(transcript, raw);
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function hookInput(event = "Stop", extra = {}) {
  return {
    hook_event_name: event,
    session_id: "session-1",
    transcript_path: transcript,
    cwd: projectDir,
    ...extra,
  };
}

function config(extra = {}) {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:1",
    tracePath: "v1/traces",
    metricsPath: "v1/metrics",
    headers: {},
    capture_content: true,
    max_chars: 20_000,
    timeout_ms: 3_000,
    resourceAttributes: { "deployment.environment": "test" },
    configDir: tempDir,
    dataDir: path.join(tempDir, "data"),
    hookLogFile: path.join(tempDir, "data", "hook.log"),
    ...extra,
  };
}

async function findFile(directory, suffix) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, suffix).catch(() => undefined);
      if (nested) return nested;
    } else if (entry.name.endsWith(suffix)) {
      return candidate;
    }
  }
  throw new Error(`No ${suffix} file below ${directory}`);
}

test("reads a real WorkBuddy Hook payload from process stdin", async () => {
  const configDir = path.join(tempDir, "stdin-config");
  const result = spawnSync(process.execPath, [path.resolve("src/workbuddy-hook.js")], {
    encoding: "utf-8",
    input: JSON.stringify(hookInput("UserPromptSubmit")),
    env: { ...process.env, WORKBUDDY_CONFIG_DIR: configDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const journal = await fs.readFile(await findFile(path.join(configDir, "plugins", "data"), ".jsonl"), "utf-8");
  assert.match(journal, /UserPromptSubmit/);
});

test("exits a disabled Hook before reading stdin or writing state", async () => {
  const options = { config: config({ enabled: false }) };
  Object.defineProperty(options, "hookInput", {
    get() { throw new Error("disabled Hook must not read hookInput"); },
  });
  assert.deepEqual(await runHook(options), { disabled: true });
});

test("parses WorkBuddy 5.2.6 messages, tools, models, and per-call usage", async () => {
  const items = await readTranscript(transcript);
  const events = [
    { hook_event_name: "PreToolUse", observed_at: 1784000001250, tool_name: "Skill", tool_input: { skill: "demo" }, call_id: "call-1" },
    { hook_event_name: "PostToolUse", observed_at: 1784000001750, tool_name: "Skill", tool_input: { skill: "demo" }, call_id: "call-1" },
  ];
  const [turn] = parseTurns(items, hookInput(), events);
  assert.equal(turn.turnId, "user-1");
  assert.equal(turn.finalStatus, "completed");
  assert.equal(turn.llmCalls.length, 2);
  assert.equal(turn.llmCalls[0].model, "claude-sonnet-test");
  assert.equal(turn.llmCalls[0].usage.inputTokens, 120);
  assert.equal(turn.llmCalls[1].usage.outputTokens, 12);
  assert.equal(turn.tools.length, 1);
  assert.equal(turn.tools[0].id, "call-1");
  assert.equal(turn.tools[0].timingSource, "hook");
  assert.equal(turn.tools[0].endMs - turn.tools[0].startMs, 500);
  assert.deepEqual(turn.llmCalls[0].inputMessages, [
    { role: "user", parts: [{ type: "text", content: "Use the demo skill to inspect this project." }] },
  ]);
  assert.deepEqual(turn.llmCalls[1].inputMessages, [
    { role: "user", parts: [{ type: "text", content: "Use the demo skill to inspect this project." }] },
    { role: "assistant", parts: [{ type: "tool_call", id: "call-1", name: "Skill", arguments: { skill: "demo", api_token: "sk-example-not-real-123456789" } }] },
    { role: "tool", tool_call_id: "call-1", parts: [{ type: "tool_call_response", content: { result: "demo completed" } }] },
  ]);
});

test("groups consecutive assistant text and tool_call outputs into one llm call", () => {
  const items = [
    { id: "u-seq", type: "message", role: "user", timestamp: 1784003000000, content: [{ type: "input_text", text: "Plan and then call a tool" }] },
    {
      id: "a-seq-1",
      type: "message",
      role: "assistant",
      timestamp: 1784003000500,
      content: [{ type: "output_text", text: "I will inspect the repository first." }],
      providerData: { model: "glm-5.2", usage: { input_tokens: 100, output_tokens: 20 } },
    },
    {
      id: "fc-seq",
      type: "function_call",
      callId: "call-seq",
      name: "Bash",
      arguments: "{\"command\":\"pwd\"}",
      timestamp: 1784003000900,
      providerData: { model: "glm-5.2", usage: { input_tokens: 120, output_tokens: 5 } },
    },
  ];

  const [turn] = parseTurns(items, hookInput("Stop", { session_id: "sequence-session" }));
  assert.equal(turn.llmCalls.length, 1);
  assert.deepEqual(turn.llmCalls[0].inputMessages, [
    { role: "user", parts: [{ type: "text", content: "Plan and then call a tool" }] },
  ]);
  assert.deepEqual(turn.llmCalls[0].outputMessages, [{
    role: "assistant",
    parts: [
      { type: "text", content: "I will inspect the repository first." },
      { type: "tool_call", id: "call-seq", name: "Bash", arguments: { command: "pwd" } },
    ],
  }]);
  assert.deepEqual(turn.llmCalls[0].assistantMessages.map((message) => message.outputMessages[0]), [
    { role: "assistant", parts: [{ type: "text", content: "I will inspect the repository first." }] },
  ]);
  assert.equal(turn.llmCalls[0].outputKind, "tool_call");
});

test("builds the gtrace hierarchy, redacts content, and derives four metric families", async () => {
  const items = await readTranscript(transcript);
  const [turn] = parseTurns(items, hookInput());
  const spans = await buildWorkBuddySpans(config(), hookInput(), turn);
  const root = spans.find((span) => span.name === "invoke_agent");
  const llms = spans.filter((span) => span.name === "llm");
  const assistants = spans.filter((span) => span.name === "assistant");
  const tool = spans.find((span) => span.name === "tool:Skill");
  const skill = spans.find((span) => span.name === "skill:demo");
  assert.ok(root);
  assert.equal(llms.length, 2);
  assert.equal(assistants.length, 1);
  assert.equal(tool.parent_id, root.span_id);
  assert.equal(skill.parent_id, tool.span_id);
  assert.equal(llms[0].parent_id, root.span_id);
  assert.equal(assistants[0].parent_id, root.span_id);
  assert.equal(llms[0].attributes["timing.source"], "inferred");
  assert.equal(llms[0].attributes.input_preview, "Use the demo skill to inspect this project.");
  assert.equal(llms[0].attributes.output_preview, "Skill {\"skill\":\"demo\",\"api_token\":\"<redacted>\"}");
  assert.match(llms[1].attributes.input_preview, /Use the demo skill to inspect this project\./);
  assert.match(llms[1].attributes.input_preview, /demo completed/);
  assert.doesNotMatch(llms[1].attributes.input_preview, /sk-example-not-real-123456789/);
  assert.equal(llms[1].attributes.output_preview, "The demo skill completed successfully.");
  assert.equal(assistants[0].attributes.output_preview, "The demo skill completed successfully.");
  assert.equal(tool.attributes["gen_ai.tool.call.arguments"].api_token, "<redacted>");
  assert.equal(skill.attributes["gen_ai.skill.version"], "1.2.3");
  assert.equal(root.resource.agent_runtime, "workbuddy");

  const metrics = buildWorkBuddyMetrics(spans);
  assert.deepEqual(new Set(metrics.map((metric) => metric.name)), new Set([
    "gen_ai.workflow.duration",
    "gen_ai.agent.operation.count",
    "gen_ai.agent.operation.duration",
    "gen_ai.client.token.usage",
  ]));
  assert.equal(metrics.filter((metric) => metric.name === "gen_ai.client.token.usage").length, 4);
  assert.equal(metrics.filter((metric) => metric.name === "gen_ai.agent.operation.count").length, 4);
});

test("omits captured bodies when content capture is disabled", async () => {
  const [turn] = parseTurns(await readTranscript(transcript), hookInput());
  const spans = await buildWorkBuddySpans(config({ capture_content: false }), hookInput(), turn);
  const root = spans[0];
  const tool = spans.find((span) => span.name === "tool:Skill");
  assert.equal(root.attributes["gen_ai.input.messages"], undefined);
  assert.equal(root.attributes.input_preview, undefined);
  assert.equal(root.attributes.input_length > 0, true);
  assert.equal(tool.attributes["gen_ai.tool.call.arguments"], undefined);
});

test("redacts or omits sensitive Hook journal content", async () => {
  const redactedDataDir = path.join(tempDir, "redacted-journal");
  await runHook({
    config: config({ dataDir: redactedDataDir, hookLogFile: path.join(redactedDataDir, "hook.log") }),
    hookInput: hookInput("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "echo ok", api_token: "secret-value" },
      call_id: "redacted-call",
    }),
  });
  const redactedJournal = await fs.readFile((await findFile(path.join(redactedDataDir, "events"), ".jsonl")), "utf-8");
  assert.doesNotMatch(redactedJournal, /secret-value/);
  assert.match(redactedJournal, /<redacted>/);

  const metadataDataDir = path.join(tempDir, "metadata-journal");
  await runHook({
    config: config({ capture_content: false, dataDir: metadataDataDir, hookLogFile: path.join(metadataDataDir, "hook.log") }),
    hookInput: hookInput("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "echo private-value" },
      call_id: "metadata-call",
    }),
  });
  const metadataJournal = await fs.readFile((await findFile(path.join(metadataDataDir, "events"), ".jsonl")), "utf-8");
  assert.doesNotMatch(metadataJournal, /private-value/);
  assert.match(metadataJournal, /metadata-call/);
});

test("marks an unfinished last turn cancelled on SessionEnd", () => {
  const items = [
    { id: "u-cancel", type: "message", role: "user", timestamp: 1784001000000, content: [{ type: "input_text", text: "Start a long task" }] },
    { id: "fc-cancel", type: "function_call", callId: "c-cancel", name: "Bash", arguments: "{\"command\":\"sleep 10\"}", timestamp: 1784001001000, providerData: { model: "test", usage: { input_tokens: 4, output_tokens: 1 } } },
  ];
  const [turn] = parseTurns(items, hookInput("SessionEnd", { reason: "user_cancelled" }));
  assert.equal(turn.finalStatus, "cancelled");
});

test("keeps the root turn open through a trailing tool result", () => {
  const items = [
    { id: "u-range", type: "message", role: "user", timestamp: 1784002000000, content: [{ type: "input_text", text: "Run it" }] },
    { id: "a-range", type: "message", role: "assistant", timestamp: 1784002000500, content: [{ type: "output_text", text: "Starting" }], status: "completed" },
    { id: "fc-range", type: "function_call", callId: "c-range", name: "Bash", arguments: "{}", timestamp: 1784002001000, providerData: { model: "test", usage: { input_tokens: 2, output_tokens: 1 } } },
    { id: "fr-range", type: "function_call_result", callId: "c-range", name: "Bash", status: "completed", output: { type: "text", text: "done" }, timestamp: 1784002003000 },
  ];
  const [turn] = parseTurns(items, hookInput("SessionEnd", { reason: "user_cancelled" }));
  assert.equal(turn.endMs, 1784002003000);
  assert.equal(turn.endMs >= turn.tools[0].endMs, true);
});

test("creates an independent subagent trace with available parent correlation", async () => {
  const input = hookInput("SubagentStop", { agent_id: "expert-1", agent_type: "Explore" });
  const events = [{
    hook_event_name: "SubagentStart",
    agent_id: "expert-1",
    agent_type: "Explore",
    parent_session_id: "parent-session",
    parent_tool_call_id: "parent-call",
  }];
  const [turn] = parseTurns(await readTranscript(transcript), input, events);
  const spans = await buildWorkBuddySpans(config(), input, turn);
  assert.equal(turn.isSubagent, true);
  assert.equal(spans[0].attributes.parent_session_id, "parent-session");
  assert.equal(spans[0].attributes.parent_tool_call_id, "parent-call");
  assert.equal(spans[0].resource.agent_name, "Explore");
});

test("loads file, OTEL environment, and plugin options with stable precedence", async () => {
  const configDir = path.join(tempDir, "config-precedence");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "gtrace.json"), JSON.stringify({
    endpoint: "https://file.example",
    headers: { "X-File": "yes" },
    capture_content: false,
  }));
  const resolved = resolveConfig({
    configDir,
    dataDir: path.join(tempDir, "config-data"),
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example",
      CODEBUDDY_PLUGIN_OPTION_ENDPOINT: "https://plugin.example",
      CODEBUDDY_PLUGIN_OPTION_X_TOKEN: "test-token",
    },
  });
  assert.equal(resolved.endpoint, "https://plugin.example");
  assert.equal(resolved.headers["X-Token"], "test-token");
  assert.equal(resolved.headers["X-File"], "yes");
  assert.equal(resolved.capture_content, false);
});

test("uploads protobuf traces and metrics once across duplicate Stop hooks", async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: Buffer.concat(chunks), headers: request.headers });
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const dataDir = path.join(tempDir, "integration-data");
  const runtimeConfig = config({ endpoint: `http://127.0.0.1:${address.port}`, dataDir, hookLogFile: path.join(dataDir, "hook.log") });
  try {
    await runHook({ config: runtimeConfig, hookInput: hookInput("PreToolUse", { tool_name: "Skill", tool_input: { skill: "demo" }, call_id: "call-1" }) });
    await runHook({ config: runtimeConfig, hookInput: hookInput("PostToolUse", { tool_name: "Skill", tool_input: { skill: "demo" }, tool_response: { ok: true }, call_id: "call-1" }) });
    const first = await runHook({ config: runtimeConfig, hookInput: hookInput("Stop") });
    const duplicate = await runHook({ config: runtimeConfig, hookInput: hookInput("Stop") });
    assert.equal(first.results[0].spans > 0, true);
    assert.equal(duplicate.results[0].skipped, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers["content-type"], "application/x-protobuf");
    const traceRequest = requests.find((request) => request.url === "/v1/traces");
    const metricRequest = requests.find((request) => request.url === "/v1/metrics");
    assert.equal(decodeExportTraceServiceRequest(traceRequest.body).resourceSpans.length, 1);
    assert.equal(decodeExportMetricsServiceRequest(metricRequest.body).resourceMetrics.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("deduplicates terminal exports across plugin instances with different runtime data env", async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    requests.push(request.url);
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const configDir = path.join(tempDir, "shared-config");
  const baseEnv = {
    ...process.env,
    WORKBUDDY_CONFIG_DIR: configDir,
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
  };
  try {
    const firstConfig = resolveConfig({
      env: {
        ...baseEnv,
        CODEBUDDY_PLUGIN_DATA: path.join(tempDir, "runtime-a"),
      },
    });
    const secondConfig = resolveConfig({
      env: {
        ...baseEnv,
        CODEBUDDY_PLUGIN_DATA: path.join(tempDir, "runtime-b"),
      },
    });
    assert.equal(firstConfig.dataDir, secondConfig.dataDir);
    assert.equal(firstConfig.dataDir, path.join(configDir, "plugins", "data", "workbuddy-otel-plugin"));

    const first = await runHook({
      config: firstConfig,
      hookInput: hookInput("Stop", { session_id: "shared-runtime-session" }),
    });
    const duplicate = await runHook({
      config: secondConfig,
      hookInput: hookInput("Stop", { session_id: "shared-runtime-session" }),
    });

    assert.equal(first.results[0].spans > 0, true);
    assert.equal(duplicate.results[0].skipped, true);
    assert.equal(requests.filter((url) => url === "/v1/traces").length, 1);
    assert.equal(requests.filter((url) => url === "/v1/metrics").length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("resumes a partial export without uploading traces twice", async () => {
  let metricAttempts = 0;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    requests.push(request.url);
    if (request.url === "/v1/metrics" && metricAttempts++ < 3) {
      response.writeHead(503);
      response.end("retry");
      return;
    }
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const dataDir = path.join(tempDir, "partial-data");
  const runtimeConfig = config({ endpoint: `http://127.0.0.1:${address.port}`, dataDir, hookLogFile: path.join(dataDir, "hook.log") });
  try {
    const first = await runHook({ config: runtimeConfig, hookInput: hookInput("Stop", { session_id: "partial-session" }) });
    assert.match(first.results[0].error, /HTTP 503/);
    const second = await runHook({ config: runtimeConfig, hookInput: hookInput("Stop", { session_id: "partial-session" }) });
    assert.equal(second.results[0].spans > 0, true);
    assert.equal(requests.filter((url) => url === "/v1/traces").length, 1);
    assert.equal(requests.filter((url) => url === "/v1/metrics").length, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
