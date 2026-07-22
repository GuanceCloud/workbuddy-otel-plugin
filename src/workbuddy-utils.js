import * as crypto from "node:crypto";
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential)/i;

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8").trim();
  if (!raw) throw new Error("empty hook stdin");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid hook JSON: ${error.message}`);
  }
}

export function safeJsonParse(value, fallback = undefined) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function randomTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

export function randomSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

export function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(value, maxChars) {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function redactAndClip(value, maxChars, key = "") {
  if (SECRET_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") {
    const redacted = value
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
      .replace(/\b(sk|pk|ak)-[A-Za-z0-9_-]{12,}\b/g, "$1-<redacted>");
    return truncate(redacted, maxChars);
  }
  if (Array.isArray(value)) return value.map((entry) => redactAndClip(entry, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => [
      childKey,
      redactAndClip(entry, maxChars, childKey),
    ]));
  }
  return value;
}

export function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function toNs(value, fallbackMs = Date.now()) {
  const ms = timestampMs(value) ?? fallbackMs;
  return BigInt(Math.trunc(ms)) * 1_000_000n;
}

export function safeFileName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180);
}

export function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function parseHeaders(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string" && item.trim()));
  }
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split(",").map((entry) => {
    const [key, ...rest] = entry.split("=");
    const encoded = rest.join("=").trim();
    let decoded = encoded;
    try { decoded = decodeURIComponent(encoded); } catch {}
    return [key?.trim(), decoded];
  }).filter(([key, item]) => key && item));
}

export function primitiveAttributes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item !== "" && item != null && ["string", "number", "boolean"].includes(typeof item)));
}
