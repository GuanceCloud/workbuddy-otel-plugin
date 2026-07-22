import { setTimeout as delay } from "node:timers/promises";

import { encodeExportMetricsServiceRequest, encodeExportTraceServiceRequest } from "./proto.js";
import {
  workbuddyMetricsToOtlpProtobufRequest,
  workbuddySpansToOtlpProtobufRequest,
} from "./workbuddy-otlp.js";

export function resolveSignalUrl(endpoint, signalPath) {
  const normalizedEndpoint = String(endpoint).replace(/\/+$/, "");
  const normalizedPath = String(signalPath || "").replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) return normalizedEndpoint;
  const base = normalizedEndpoint.split(/[?#]/, 1)[0];
  if (base.toLowerCase().endsWith(`/${normalizedPath.toLowerCase()}`)) return normalizedEndpoint;
  return `${normalizedEndpoint}/${normalizedPath}`;
}

export function redactedHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    /authorization|cookie|token|api[-_]?key|secret/i.test(key) ? "<redacted>" : value,
  ]));
}

async function postProtobuf(url, body, config, log) {
  const headers = { ...(config.headers ?? {}), "content-type": "application/x-protobuf" };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
    const started = Date.now();
    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      const responseBody = await response.text().catch(() => "");
      if (response.ok) {
        await log("upload success", { url, status: response.status, attempt, duration_ms: Date.now() - started });
        return { status: response.status, body_bytes: body.length, duration_ms: Date.now() - started };
      }
      lastError = new Error(`HTTP ${response.status}: ${responseBody.slice(0, 1000)}`);
      await log("upload http_error", { url, status: response.status, attempt, duration_ms: Date.now() - started });
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
      await log("upload exception", { url, attempt, error: error?.message ?? String(error) });
    } finally {
      clearTimeout(timeout);
    }
    await delay(200 * (2 ** (attempt - 1)));
  }
  throw lastError ?? new Error("OTLP upload failed");
}

export async function uploadTraces(config, spans, log = async () => {}) {
  const url = config.otel_traces_url || resolveSignalUrl(config.endpoint, config.tracePath);
  const body = encodeExportTraceServiceRequest(workbuddySpansToOtlpProtobufRequest(spans));
  await log("upload traces start", {
    url,
    span_count: spans.length,
    body_bytes: body.length,
    headers: redactedHeaders(config.headers),
  });
  return postProtobuf(url, body, config, log);
}

export async function uploadMetrics(config, metrics, log = async () => {}) {
  if (metrics.length === 0) return { skipped: true };
  const url = config.otel_metrics_url || resolveSignalUrl(config.endpoint, config.metricsPath);
  const body = encodeExportMetricsServiceRequest(workbuddyMetricsToOtlpProtobufRequest(metrics));
  await log("upload metrics start", {
    url,
    metric_points: metrics.length,
    metric_names: [...new Set(metrics.map((metric) => metric.name))],
    body_bytes: body.length,
    headers: redactedHeaders(config.headers),
  });
  return postProtobuf(url, body, config, log);
}
