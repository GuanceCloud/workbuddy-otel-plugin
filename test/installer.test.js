import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import {
  updateInstalledPluginsRegistry,
  updateWorkBuddyFallbackInstall,
  updateWorkBuddySettings,
  writeGtraceConfig,
} from "../scripts/install-config.js";

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
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  }
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

test("installer helper CLI overwrites managed auth and agent tags with the latest values", async () => {
  const configFile = path.join(tempDir, "cli-overwrite.json");
  await fs.writeFile(configFile, JSON.stringify({
    enabled: true,
    endpoint: "https://llm-openway.guance.com",
    tracePath: "v1/write/otel-llm",
    metricsPath: "v1/write/otel-metrics",
    headers: { "X-Token": "old-token", "To-Headless": "true" },
    resourceAttributes: { agent_id: "oldid", agent_name: "oldname" },
  }));

  const result = spawnSync(process.execPath, [
    path.resolve("scripts/install-config.js"),
    "write-gtrace-config",
    "--config-file", configFile,
    "--endpoint", "https://llm-openway.guance.com",
    "--trace-path", "v1/write/otel-llm",
    "--metrics-path", "v1/write/otel-metrics",
    "--install-type", "gtrace",
    "--x-token", "new-token",
    "--tag", "agent_id=newid",
    "--tag", "agent_name=newname",
  ], {
    cwd: path.resolve("."),
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(await fs.readFile(configFile, "utf-8"));
  assert.equal(config.headers["X-Token"], "new-token");
  assert.equal(config.resourceAttributes.agent_id, "newid");
  assert.equal(config.resourceAttributes.agent_name, "newname");
});

test("installer helper CLI still runs when invoked through a symlinked path", async () => {
  const configFile = path.join(tempDir, "symlink-cli.json");
  const symlinkScript = path.join(tempDir, "install-config-symlink.js");
  try { await fs.unlink(symlinkScript); } catch {}
  await fs.symlink(path.resolve("scripts/install-config.js"), symlinkScript);

  const result = spawnSync(process.execPath, [
    symlinkScript,
    "write-gtrace-config",
    "--config-file", configFile,
    "--endpoint", "https://llm-openway.guance.com",
    "--trace-path", "v1/write/otel-llm",
    "--metrics-path", "v1/write/otel-metrics",
    "--install-type", "gtrace",
    "--x-token", "symlink-token",
  ], {
    cwd: path.resolve("."),
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(await fs.readFile(configFile, "utf-8"));
  assert.equal(config.endpoint, "https://llm-openway.guance.com");
  assert.equal(config.headers["X-Token"], "symlink-token");
  assert.equal(config.tracePath, "v1/write/otel-llm");
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

test("shell installer reapplies the explicit gtrace preset to an existing config", async () => {
  const profileDir = path.join(tempDir, "shell-profile");
  const configFile = path.join(profileDir, "gtrace.json");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({
    endpoint: "https://llm-openway.guance.com",
    tracePath: "v1/traces",
    metricsPath: "v1/metrics",
    headers: { Authorization: "Bearer keep-me" },
  }));

  const result = spawnSync("bash", ["scripts/install.sh", "--config-dir", profileDir, "--type", "gtrace"], {
    cwd: path.resolve("."),
    env: { ...process.env, WORKBUDDY_OTEL_NODE: process.execPath },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(await fs.readFile(configFile, "utf-8"));
  assert.equal(config.tracePath, "v1/write/otel-llm");
  assert.equal(config.metricsPath, "v1/write/otel-metrics");
  assert.equal(config.headers["To-Headless"], "true");
  assert.equal(config.headers.Authorization, "Bearer keep-me");
  await fs.access(path.join(profileDir, "plugins", "cache", "guance", "workbuddy-otel-plugin", "0.1.5", "hooks", "hooks.json"));
});

test("shell installer overwrites existing agent tags with the latest tag arguments", async () => {
  const profileDir = path.join(tempDir, "shell-tags-profile");
  const configFile = path.join(profileDir, "gtrace.json");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({
    endpoint: "https://llm-openway.guance.com",
    tracePath: "v1/write/otel-llm",
    metricsPath: "v1/write/otel-metrics",
    headers: { "X-Token": "old-token", "To-Headless": "true" },
    resourceAttributes: { agent_id: "oldid", agent_name: "oldname" },
  }));

  const result = spawnSync("bash", [
    "scripts/install.sh",
    "--config-dir", profileDir,
    "--type", "gtrace",
    "--endpoint", "https://llm-openway.guance.com",
    "--x-token", "new-token",
    "--tag", "agent_id=newid",
    "--tag", "agent_name=newname",
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, WORKBUDDY_OTEL_NODE: process.execPath },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(await fs.readFile(configFile, "utf-8"));
  assert.equal(config.headers["X-Token"], "new-token");
  assert.equal(config.resourceAttributes.agent_id, "newid");
  assert.equal(config.resourceAttributes.agent_name, "newname");
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

test("fallback installation writes managed hooks and plugin registry entries", async () => {
  const settingsFile = path.join(tempDir, "fallback-settings.json");
  const registryFile = path.join(tempDir, "plugins", "installed_plugins.json");
  const pluginRoot = path.join(tempDir, "plugins", "cache", "guance", "workbuddy-otel-plugin", "0.1.5");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify({
    theme: "dark",
    hooks: {
      Stop: [{
        hooks: [{ type: "command", command: "\"/usr/bin/true\"", timeout: 1 }],
      }],
    },
  }));

  updateWorkBuddyFallbackInstall({
    settingsFile,
    registryFile,
    pluginSelector: "workbuddy-otel-plugin@guance",
    pluginRoot,
    version: "0.1.5",
    enabled: true,
  });

  const settings = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
  assert.equal(settings.enabledPlugins["workbuddy-otel-plugin@guance"], true);
  assert.equal(settings.theme, "dark");
  assert.match(settings.hooks.Stop.at(-1).hooks[0].command, /workbuddy-otel-plugin/);
  assert.match(settings.hooks.Stop.at(-1).hooks[0].command, /workbuddy-hook\.js/);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "\"/usr/bin/true\"");

  const registry = JSON.parse(await fs.readFile(registryFile, "utf-8"));
  assert.equal(registry.plugins["workbuddy-otel-plugin@guance"].installPath, pluginRoot);
  assert.equal(registry.plugins["workbuddy-otel-plugin@guance"].version, "0.1.5");

  updateWorkBuddyFallbackInstall({
    settingsFile,
    registryFile,
    pluginSelector: "workbuddy-otel-plugin@guance",
    pluginRoot,
    version: "0.1.5",
    enabled: false,
  });

  const removedSettings = JSON.parse(await fs.readFile(settingsFile, "utf-8"));
  assert.equal(removedSettings.enabledPlugins["workbuddy-otel-plugin@guance"], undefined);
  assert.equal(removedSettings.hooks.Stop.length, 1);
  assert.equal(removedSettings.hooks.Stop[0].hooks[0].command, "\"/usr/bin/true\"");

  const removedRegistry = JSON.parse(await fs.readFile(registryFile, "utf-8"));
  assert.equal(removedRegistry.plugins["workbuddy-otel-plugin@guance"], undefined);
});

test("updates installed plugin registry without disturbing unrelated entries", async () => {
  const registryFile = path.join(tempDir, "standalone-installed_plugins.json");
  await fs.mkdir(path.dirname(registryFile), { recursive: true });
  await fs.writeFile(registryFile, JSON.stringify({
    plugins: {
      "other@test": {
        scope: "user",
        installPath: "/tmp/other",
        version: "1.0.0",
      },
    },
  }));

  updateInstalledPluginsRegistry({
    registryFile,
    pluginSelector: "workbuddy-otel-plugin@guance",
    installPath: "/tmp/workbuddy-otel-plugin",
    version: "0.1.5",
    enabled: true,
  });

  const registry = JSON.parse(await fs.readFile(registryFile, "utf-8"));
  assert.equal(registry.plugins["other@test"].installPath, "/tmp/other");
  assert.equal(registry.plugins["workbuddy-otel-plugin@guance"].installPath, "/tmp/workbuddy-otel-plugin");
});

test("shell installer prefers the official plugin CLI when available", async () => {
  const profileDir = path.join(tempDir, "shell-cli-profile");
  const cliDir = path.join(tempDir, "fake-cli");
  const cliLog = path.join(tempDir, "workbuddy-cli.log");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(path.join(cliDir, "workbuddy"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' \"$*\" >> ${JSON.stringify(cliLog)}`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });

  const result = spawnSync("bash", [
    "scripts/install.sh",
    "--config-dir", profileDir,
    "--type", "gtrace",
    "--endpoint", "https://llm-openway.guance.com",
    "--x-token", "new-token",
  ], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      WORKBUDDY_OTEL_NODE: process.execPath,
      PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);

  const cliOutput = await fs.readFile(cliLog, "utf-8");
  assert.match(cliOutput, /plugin marketplace add/);
  assert.match(cliOutput, /plugin install workbuddy-otel-plugin@guance --scope user/);
});

test("shell installer fallback writes settings hooks and plugin registry when CLI is unavailable", async () => {
  const profileDir = path.join(tempDir, "shell-fallback-profile");
  await fs.mkdir(profileDir, { recursive: true });

  const result = spawnSync("bash", [
    "scripts/install.sh",
    "--config-dir", profileDir,
    "--type", "gtrace",
    "--endpoint", "https://llm-openway.guance.com",
  ], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      WORKBUDDY_OTEL_NODE: process.execPath,
      PATH: `${tempDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin CLI not found; updated plugin registry and/);

  const settings = JSON.parse(await fs.readFile(path.join(profileDir, "settings.json"), "utf-8"));
  assert.equal(settings.enabledPlugins["workbuddy-otel-plugin@guance"], true);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /plugins\/cache\/guance\/workbuddy-otel-plugin\/0\.1\.5/);

  const registry = JSON.parse(await fs.readFile(path.join(profileDir, "plugins", "installed_plugins.json"), "utf-8"));
  assert.equal(registry.plugins["workbuddy-otel-plugin@guance"].version, "0.1.5");
});
