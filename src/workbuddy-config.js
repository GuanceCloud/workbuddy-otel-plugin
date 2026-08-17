import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseBoolean, parseHeaders, primitiveAttributes } from "./workbuddy-utils.js";

const DEFAULT_ENDPOINT = "https://llm-openway.guance.com";

function jsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function endpoint(value) {
  return String(value || DEFAULT_ENDPOINT).trim().replace(/\/+$/, "");
}

function signalPath(value, fallback) {
  return String(value || fallback).trim().replace(/^\/+|\/+$/g, "");
}

function pluginOption(name, env) {
  const key = `CODEBUDDY_PLUGIN_OPTION_${name.toUpperCase()}`;
  return env[key] ?? env[`CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}`];
}

export function workBuddyConfigDir(env = process.env) {
  return env.WORKBUDDY_CONFIG_DIR?.trim()
    || env.CODEBUDDY_CONFIG_DIR?.trim()
    || path.join(os.homedir(), ".workbuddy");
}

export function pluginDataDir(env = process.env) {
  return env.WORKBUDDY_OTEL_DATA_DIR?.trim()
    || env.GTRACE_DATA_DIR?.trim()
    || path.join(workBuddyConfigDir(env), "plugins", "data", "workbuddy-otel-plugin");
}

export function resolveConfig(options = {}) {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? workBuddyConfigDir(env);
  const file = options.configFile ?? path.join(configDir, "gtrace.json");
  const stored = jsonFile(file);
  const envEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const optionEndpoint = pluginOption("endpoint", env);
  const optionToken = pluginOption("x_token", env);
  const envHeaders = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const headers = {
    ...parseHeaders(stored.headers),
    ...envHeaders,
    ...(optionToken ? { "X-Token": optionToken } : {}),
  };
  const configuredEndpoint = optionEndpoint || envEndpoint || stored.endpoint || stored.base_url;
  const captureContent = parseBoolean(env.WORKBUDDY_OTEL_CAPTURE_CONTENT)
    ?? parseBoolean(stored.capture_content)
    ?? true;

  return {
    ...stored,
    enabled: parseBoolean(env.WORKBUDDY_OTEL_ENABLED) ?? parseBoolean(stored.enabled) ?? true,
    endpoint: endpoint(configuredEndpoint),
    tracePath: signalPath(stored.tracePath, envEndpoint ? "v1/traces" : "v1/write/otel-llm"),
    metricsPath: signalPath(stored.metricsPath, envEndpoint ? "v1/metrics" : "v1/write/otel-metrics"),
    otel_traces_url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || stored.otel_traces_url,
    otel_metrics_url: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || stored.otel_metrics_url,
    headers,
    capture_content: captureContent,
    max_chars: integer(env.WORKBUDDY_OTEL_MAX_CHARS ?? stored.max_chars, 20_000),
    timeout_ms: integer(env.OTEL_EXPORTER_OTLP_TIMEOUT ?? stored.timeout_ms, 25_000),
    debug: parseBoolean(env.WORKBUDDY_OTEL_DEBUG) ?? parseBoolean(stored.debug) ?? false,
    resourceAttributes: primitiveAttributes(stored.resourceAttributes),
    configDir,
    configFile: file,
    dataDir: options.dataDir ?? pluginDataDir(env),
    hookLogFile: path.join(options.dataDir ?? pluginDataDir(env), "gtrace-hook.log"),
  };
}
