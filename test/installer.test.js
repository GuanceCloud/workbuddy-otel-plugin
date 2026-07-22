import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { updateWorkBuddySettings, writeGtraceConfig } from "../scripts/install-config.js";

let tempDir;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-installer-test-"));
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("writes a new GTrace preset without exposing installer-only fields", async () => {
  const configFile = path.join(tempDir, "new-gtrace.json");
  const config = writeGtraceConfig({
    configFile,
    endpoint: "https://llm-openway.guance.com/",
    tracePath: "/v1/write/otel-llm/",
    metricsPath: "/v1/write/otel-metrics/",
    installType: "gtrace",
    xToken: "test-token-not-real",
    tags: ["agent_id=test-agent", "label=value=with-equals"],
    extraHeaders: ["authorization=Bearer test-not-real"],
  });
  assert.equal(config.endpoint, "https://llm-openway.guance.com");
  assert.equal(config.tracePath, "v1/write/otel-llm");
  assert.equal(config.headers["To-Headless"], "true");
  assert.equal(config.headers["X-Token"], "test-token-not-real");
  assert.equal(config.headers.Authorization, "Bearer test-not-real");
  assert.equal(config.resourceAttributes.label, "value=with-equals");
  assert.equal(config.enabled, true);
  assert.equal(config.capture_content, true);
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
});

test("preserves existing config during upgrade unless explicitly overridden", async () => {
  const configFile = path.join(tempDir, "upgrade.json");
  await fs.writeFile(configFile, JSON.stringify({
    enabled: false,
    endpoint: "https://existing.example",
    tracePath: "custom/traces",
    metricsPath: "custom/metrics",
    headers: { "X-Token": "existing-token", "X-Custom": "keep" },
    capture_content: false,
    custom: { keep: true },
  }));
  const config = writeGtraceConfig({ configFile, installType: "gtrace", tags: ["team=platform"] });
  assert.equal(config.enabled, false);
  assert.equal(config.endpoint, "https://existing.example");
  assert.equal(config.headers["X-Token"], "existing-token");
  assert.equal(config.capture_content, false);
  assert.deepEqual(config.custom, { keep: true });
  assert.equal(config.resourceAttributes.team, "platform");

  const enabled = writeGtraceConfig({ configFile, scriptEnabled: true, captureContent: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.capture_content, true);
});

test("does not apply the default GTrace preset to an existing OTLP config", async () => {
  const configFile = path.join(tempDir, "otlp-upgrade.json");
  await fs.writeFile(configFile, JSON.stringify({
    endpoint: "http://collector.example:4318",
    tracePath: "v1/traces",
    metricsPath: "v1/metrics",
    headers: { Authorization: "Bearer test-not-real" },
  }));
  const config = writeGtraceConfig({ configFile, installType: "" });
  assert.deepEqual(Object.keys(config.headers), ["Authorization"]);
  assert.equal(config.tracePath, "v1/traces");
  assert.equal(config.metricsPath, "v1/metrics");
});

test("updates only the WorkBuddy plugin selector in settings", async () => {
  const settingsFile = path.join(tempDir, "settings.json");
  await fs.writeFile(settingsFile, JSON.stringify({ theme: "dark", enabledPlugins: { "other@test": true } }));
  updateWorkBuddySettings({ settingsFile, pluginSelector: "workbuddy-otel-plugin@guance", enabled: true });
  let settings = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
  assert.equal(settings.theme, "dark");
  assert.equal(settings.enabledPlugins["other@test"], true);
  assert.equal(settings.enabledPlugins["workbuddy-otel-plugin@guance"], true);

  updateWorkBuddySettings({ settingsFile, pluginSelector: "workbuddy-otel-plugin@guance", enabled: false });
  settings = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
  assert.equal(settings.enabledPlugins["workbuddy-otel-plugin@guance"], undefined);
  assert.equal(settings.enabledPlugins["other@test"], true);
});
