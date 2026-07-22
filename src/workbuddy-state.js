import * as fs from "node:fs/promises";
import * as path from "node:path";

import { safeFileName, safeJsonParse, sha256 } from "./workbuddy-utils.js";

const CLAIM_TTL_MS = 10 * 60 * 1000;

function transcriptKey(transcriptPath) {
  return sha256(transcriptPath || "unknown").slice(0, 20);
}

function journalPath(dataDir, sessionId, transcriptPath) {
  return path.join(dataDir, "events", safeFileName(sessionId), `${transcriptKey(transcriptPath)}.jsonl`);
}

export async function appendHookEvent(dataDir, payload, observedAt = Date.now()) {
  const file = journalPath(dataDir, payload.session_id, payload.transcript_path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record = {
    observed_at: observedAt,
    hook_event_name: payload.hook_event_name,
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
    tool_response: payload.tool_response,
    error: payload.error,
    is_interrupt: payload.is_interrupt,
    call_id: payload.call_id ?? payload.tool_use_id,
    agent_id: payload.agent_id,
    agent_type: payload.agent_type,
    parent_session_id: payload.parent_session_id,
    parent_tool_call_id: payload.parent_tool_call_id,
    session_channel: payload.session_channel,
    source: payload.source,
    trigger: payload.trigger ?? payload.trigger_type ?? payload.agent_trigger,
    reason: payload.reason,
  };
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

export async function readHookEvents(dataDir, sessionId, transcriptPath) {
  const raw = await fs.readFile(journalPath(dataDir, sessionId, transcriptPath), "utf-8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => safeJsonParse(line)).filter(Boolean);
}

export async function appendLog(file, message, extra = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), message, ...extra })}\n`, "utf-8");
}

function turnDir(dataDir, sessionId, turnId) {
  return path.join(dataDir, "uploads", safeFileName(sessionId), safeFileName(turnId));
}

async function staleLock(lockFile) {
  const stat = await fs.stat(lockFile).catch(() => undefined);
  return stat && Date.now() - stat.mtimeMs > CLAIM_TTL_MS;
}

export async function claimTurn(dataDir, sessionId, turnId) {
  const dir = turnDir(dataDir, sessionId, turnId);
  const lock = path.join(dir, "upload.lock");
  await fs.mkdir(dir, { recursive: true });
  if (await fs.stat(path.join(dir, "completed.json")).catch(() => undefined)) {
    return { claimed: false, completed: true, dir, lock };
  }
  try {
    const handle = await fs.open(lock, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    await handle.close();
    return { claimed: true, completed: false, dir, lock };
  } catch (error) {
    if (error?.code === "EEXIST" && await staleLock(lock)) {
      await fs.rm(lock, { force: true });
      return claimTurn(dataDir, sessionId, turnId);
    }
    if (error?.code === "EEXIST") return { claimed: false, completed: false, dir, lock };
    throw error;
  }
}

export async function signalUploaded(claim, signal, details = {}) {
  await fs.writeFile(path.join(claim.dir, `${signal}.json`), JSON.stringify({
    ...details,
    uploaded_at: new Date().toISOString(),
  }, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function signalWasUploaded(claim, signal) {
  return Boolean(await fs.stat(path.join(claim.dir, `${signal}.json`)).catch(() => undefined));
}

export async function completeTurn(claim, details = {}) {
  await fs.writeFile(path.join(claim.dir, "completed.json"), JSON.stringify({
    ...details,
    completed_at: new Date().toISOString(),
  }, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rm(claim.lock, { force: true });
}

export async function releaseTurn(claim) {
  if (claim?.claimed) await fs.rm(claim.lock, { force: true });
}
