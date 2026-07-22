import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "./workbuddy-config.js";
import { buildWorkBuddyMetrics } from "./workbuddy-metrics.js";
import { parseTurns, readTranscript, transcriptFingerprint } from "./workbuddy-parse.js";
import { buildWorkBuddySpans } from "./workbuddy-spans.js";
import {
  appendHookEvent,
  appendLog,
  claimTurn,
  completeTurn,
  readHookEvents,
  releaseTurn,
  signalUploaded,
  signalWasUploaded,
} from "./workbuddy-state.js";
import { uploadMetrics, uploadTraces } from "./workbuddy-upload.js";
import { redactAndClip, readStdin } from "./workbuddy-utils.js";

const TERMINAL_EVENTS = new Set(["Stop", "StopFailure", "SubagentStop", "SessionEnd"]);

export async function runHook(options = {}) {
  const config = options.config ?? resolveConfig();
  if (!config.enabled) return { disabled: true };
  const hookInput = options.hookInput ?? await readStdin();
  const log = (message, extra) => appendLog(config.hookLogFile, message, extra).catch(() => {});
  const journalInput = {
    ...hookInput,
    tool_input: config.capture_content ? redactAndClip(hookInput.tool_input, config.max_chars) : undefined,
    tool_response: config.capture_content ? redactAndClip(hookInput.tool_response, config.max_chars) : undefined,
    error: config.capture_content ? redactAndClip(hookInput.error, config.max_chars) : undefined,
  };
  await appendHookEvent(config.dataDir, journalInput).catch((error) => log("event journal failed", { error: error.message }));
  if (config.debug) {
    await log("hook event recorded", {
      event: hookInput.hook_event_name,
      session_id: hookInput.session_id,
      tool_name: hookInput.tool_name,
      terminal: TERMINAL_EVENTS.has(hookInput.hook_event_name),
    });
  }

  if (!TERMINAL_EVENTS.has(hookInput.hook_event_name)) return { recorded: true };
  if (!hookInput.session_id || !hookInput.transcript_path) {
    await log("terminal hook missing session or transcript", { event: hookInput.hook_event_name });
    return { skipped: true, reason: "missing_session_or_transcript" };
  }

  const items = await readTranscript(hookInput.transcript_path);
  const fingerprint = transcriptFingerprint(items);
  const hookEvents = await readHookEvents(config.dataDir, hookInput.session_id, hookInput.transcript_path);
  const turns = parseTurns(items, hookInput, hookEvents)
    .filter((turn) => ["completed", "cancelled"].includes(turn.finalStatus));
  if (config.debug) {
    await log("terminal hook parsed", {
      event: hookInput.hook_event_name,
      session_id: hookInput.session_id,
      transcript_items: items.length,
      hook_events: hookEvents.length,
      turns: turns.map((turn) => ({
        turn_id: turn.turnId,
        status: turn.finalStatus,
        llm_calls: turn.llmCalls.length,
        tools: turn.tools.length,
      })),
    });
  }
  const results = [];

  for (const turn of turns) {
    const claim = await claimTurn(config.dataDir, turn.sessionId, turn.turnId);
    if (!claim.claimed) {
      results.push({ turn_id: turn.turnId, skipped: true, completed: claim.completed });
      continue;
    }
    try {
      const spans = await buildWorkBuddySpans(config, hookInput, turn);
      const metrics = buildWorkBuddyMetrics(spans);
      let traceResponse;
      let metricResponse;
      if (!await signalWasUploaded(claim, "traces")) {
        traceResponse = await uploadTraces(config, spans, log);
        await signalUploaded(claim, "traces", traceResponse);
      }
      if (!await signalWasUploaded(claim, "metrics")) {
        metricResponse = await uploadMetrics(config, metrics, log);
        await signalUploaded(claim, "metrics", metricResponse);
      }
      await completeTurn(claim, {
        session_id: turn.sessionId,
        turn_id: turn.turnId,
        transcript_fingerprint: fingerprint,
        trace_id: spans[0]?.trace_id,
        span_count: spans.length,
        metric_points: metrics.length,
      });
      results.push({
        turn_id: turn.turnId,
        trace_id: spans[0]?.trace_id,
        spans: spans.length,
        metrics: metrics.length,
        trace_response: traceResponse,
        metric_response: metricResponse,
      });
    } catch (error) {
      await log("turn export failed", { session_id: turn.sessionId, turn_id: turn.turnId, error: error.message });
      await releaseTurn(claim);
      results.push({ turn_id: turn.turnId, error: error.message });
    }
  }

  await log("terminal hook processed", {
    event: hookInput.hook_event_name,
    session_id: hookInput.session_id,
    transcript_items: items.length,
    terminal_turns: turns.length,
    results,
  });
  return { results };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runHook().catch(async (error) => {
    const config = resolveConfig();
    await appendLog(config.hookLogFile, "hook failed", { error: error?.message ?? String(error) }).catch(() => {});
  });
}
