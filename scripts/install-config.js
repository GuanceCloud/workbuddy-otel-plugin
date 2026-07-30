import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readObject(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "").trim();
  if (!raw) return {};
  const value = JSON.parse(raw);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function writeObject(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!fs.existsSync(file) || !["EACCES", "EEXIST", "EPERM"].includes(error?.code)) throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
  try { fs.chmodSync(file, mode); } catch {}
}

function canonicalHeaderName(key) {
  const normalized = String(key).trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  if (normalized === "to-headless") return "To-Headless";
  if (normalized === "x-token") return "X-Token";
  if (normalized === "authorization") return "Authorization";
  return String(key).trim();
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => {
    const canonical = canonicalHeaderName(key);
    return canonical && typeof value === "string" && value.trim() ? [[canonical, value.trim()]] : [];
  }));
}

function splitAssignment(value) {
  const [key, ...rest] = String(value).split("=");
  if (!key?.trim() || rest.length === 0) return undefined;
  return [key.trim(), rest.join("=").trim()];
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function updateWorkBuddySettings({ settingsFile, pluginSelector, enabled }) {
  const settings = readObject(settingsFile);
  settings.enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === "object" && !Array.isArray(settings.enabledPlugins)
    ? settings.enabledPlugins
    : {};
  if (enabled) settings.enabledPlugins[pluginSelector] = true;
  else delete settings.enabledPlugins[pluginSelector];
  writeObject(settingsFile, settings);
  return settings;
}

function managedHookCommand(command) {
  if (typeof command !== "string") return false;
  return command.includes("workbuddy-otel-plugin") && command.includes("workbuddy-hook.js");
}

function hookEntry(command, timeout, matcher) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{
      type: "command",
      command,
      timeout,
    }],
  };
}

function fallbackHooks(pluginRoot) {
  const normalizedRoot = path.resolve(pluginRoot);
  const command = `${JSON.stringify(path.join(normalizedRoot, "bin", "run-node"))} ${JSON.stringify(path.join(normalizedRoot, "src", "workbuddy-hook.js"))}`;
  return {
    UserPromptSubmit: [hookEntry(command, 5)],
    PreToolUse: [hookEntry(command, 5, ".*")],
    PostToolUse: [hookEntry(command, 5, ".*")],
    PostToolUseFailure: [hookEntry(command, 5, ".*")],
    Stop: [hookEntry(command, 180)],
    StopFailure: [hookEntry(command, 180)],
    SubagentStart: [hookEntry(command, 5, ".*")],
    SubagentStop: [hookEntry(command, 180)],
    SessionEnd: [hookEntry(command, 180)],
  };
}

function stripManagedHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return settings;
  const next = {};
  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      next[eventName] = groups;
      continue;
    }
    const filteredGroups = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return [group];
      const hooks = Array.isArray(group.hooks) ? group.hooks.filter((hook) => !managedHookCommand(hook?.command)) : group.hooks;
      if (Array.isArray(hooks) && hooks.length === 0) return [];
      return [{ ...group, hooks }];
    });
    if (filteredGroups.length > 0) next[eventName] = filteredGroups;
  }
  if (Object.keys(next).length > 0) settings.hooks = next;
  else delete settings.hooks;
  return settings;
}

export function updateInstalledPluginsRegistry({ registryFile, pluginSelector, installPath, version, enabled }) {
  const registry = readObject(registryFile);
  registry.plugins = registry.plugins && typeof registry.plugins === "object" && !Array.isArray(registry.plugins)
    ? registry.plugins
    : {};
  if (enabled) {
    const existing = registry.plugins[pluginSelector] && typeof registry.plugins[pluginSelector] === "object"
      ? registry.plugins[pluginSelector]
      : {};
    const now = new Date().toISOString();
    registry.plugins[pluginSelector] = {
      scope: existing.scope || "user",
      installPath,
      version,
      installedAt: existing.installedAt || now,
      lastUpdated: now,
    };
  } else {
    delete registry.plugins[pluginSelector];
  }
  writeObject(registryFile, registry);
  return registry;
}

export function updateWorkBuddyFallbackInstall({
  settingsFile,
  registryFile,
  pluginSelector,
  pluginRoot,
  version,
  enabled,
}) {
  const settings = readObject(settingsFile);
  settings.enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === "object" && !Array.isArray(settings.enabledPlugins)
    ? settings.enabledPlugins
    : {};
  if (enabled) settings.enabledPlugins[pluginSelector] = true;
  else delete settings.enabledPlugins[pluginSelector];
  stripManagedHooks(settings);
  if (enabled) {
    const managed = fallbackHooks(pluginRoot);
    settings.hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
    for (const [eventName, groups] of Object.entries(managed)) {
      settings.hooks[eventName] = [...(settings.hooks[eventName] ?? []), ...groups];
    }
  }
  writeObject(settingsFile, settings);
  if (registryFile) {
    updateInstalledPluginsRegistry({
      registryFile,
      pluginSelector,
      installPath: pluginRoot,
      version,
      enabled,
    });
  }
  return settings;
}

export function removeWorkBuddyFallbackHooks({ settingsFile }) {
  const settings = stripManagedHooks(readObject(settingsFile));
  writeObject(settingsFile, settings);
  return settings;
}

export function writeGtraceConfig(options) {
  const {
    configFile,
    endpoint = "",
    tracePath = "",
    metricsPath = "",
    installType = "gtrace",
    xToken = "",
    scriptEnabled,
    captureContent,
    debug,
    tags = [],
    extraHeaders = [],
  } = options;
  const exists = fs.existsSync(configFile);
  const config = readObject(configFile);

  config.enabled = typeof scriptEnabled === "boolean"
    ? scriptEnabled
    : booleanValue(config.enabled) ?? true;
  if (endpoint) config.endpoint = endpoint.replace(/\/+$/, "");
  if (tracePath) config.tracePath = tracePath.replace(/^\/+|\/+$/g, "");
  if (metricsPath) config.metricsPath = metricsPath.replace(/^\/+|\/+$/g, "");
  if (typeof captureContent === "boolean") config.capture_content = captureContent;
  else if (!exists && config.capture_content === undefined) config.capture_content = true;
  if (typeof debug === "boolean") config.debug = debug;
  else if (!exists && config.debug === undefined) config.debug = false;
  if (!exists && config.max_chars === undefined) config.max_chars = 20_000;
  if (!exists && config.timeout_ms === undefined) config.timeout_ms = 25_000;

  config.headers = normalizeHeaders(config.headers);
  if (installType === "gtrace") config.headers["To-Headless"] ??= "true";
  if (xToken) config.headers["X-Token"] = xToken;
  for (const header of extraHeaders) {
    const assignment = splitAssignment(header);
    if (!assignment) continue;
    const key = canonicalHeaderName(assignment[0]);
    if (key) config.headers[key] = assignment[1];
  }
  if (Object.keys(config.headers).length === 0) delete config.headers;

  config.resourceAttributes = config.resourceAttributes && typeof config.resourceAttributes === "object" && !Array.isArray(config.resourceAttributes)
    ? config.resourceAttributes
    : {};
  if (Array.isArray(config.tags)) {
    for (const tag of config.tags) {
      const assignment = splitAssignment(tag);
      if (assignment && !(assignment[0] in config.resourceAttributes)) {
        config.resourceAttributes[assignment[0]] = assignment[1];
      }
    }
    delete config.tags;
  }
  for (const tag of tags) {
    const assignment = splitAssignment(tag);
    if (assignment) config.resourceAttributes[assignment[0]] = assignment[1];
  }
  if (Object.keys(config.resourceAttributes).length === 0) delete config.resourceAttributes;

  writeObject(configFile, config);
  return config;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function parseCliOptions(argv) {
  const options = { tags: [], extraHeaders: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${name} requires a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case "--config-file":
        options.configFile = readValue("--config-file");
        break;
      case "--endpoint":
        options.endpoint = readValue("--endpoint");
        break;
      case "--trace-path":
        options.tracePath = readValue("--trace-path");
        break;
      case "--metrics-path":
        options.metricsPath = readValue("--metrics-path");
        break;
      case "--install-type":
        options.installType = readValue("--install-type");
        break;
      case "--x-token":
        options.xToken = readValue("--x-token");
        break;
      case "--script-enabled":
        options.scriptEnabled = booleanValue(readValue("--script-enabled"));
        break;
      case "--capture-content":
        options.captureContent = booleanValue(readValue("--capture-content"));
        break;
      case "--debug":
        options.debug = booleanValue(readValue("--debug"));
        break;
      case "--tag":
        options.tags.push(readValue("--tag"));
        break;
      case "--header":
        options.extraHeaders.push(readValue("--header"));
        break;
      default:
        throw new Error(`Unsupported installer config option: ${argument}`);
    }
  }
  return options;
}

function optionsFromEnvironment(action) {
  if (["enable-plugin", "disable-plugin"].includes(action)) {
    return {
      settingsFile: process.env.WORKBUDDY_SETTINGS_FILE_RUNTIME,
      pluginSelector: process.env.WORKBUDDY_PLUGIN_SELECTOR_RUNTIME,
      enabled: action === "enable-plugin",
    };
  }
  if (["enable-plugin-fallback", "disable-plugin-fallback"].includes(action)) {
    return {
      settingsFile: process.env.WORKBUDDY_SETTINGS_FILE_RUNTIME,
      registryFile: process.env.WORKBUDDY_INSTALLED_PLUGINS_FILE_RUNTIME,
      pluginSelector: process.env.WORKBUDDY_PLUGIN_SELECTOR_RUNTIME,
      pluginRoot: process.env.WORKBUDDY_PLUGIN_ROOT_RUNTIME,
      version: process.env.WORKBUDDY_PLUGIN_VERSION_RUNTIME,
      enabled: action === "enable-plugin-fallback",
    };
  }
  if (action === "remove-plugin-fallback-hooks") {
    return {
      settingsFile: process.env.WORKBUDDY_SETTINGS_FILE_RUNTIME,
    };
  }
  return {
    configFile: process.env.GTRACE_CONFIG_FILE_RUNTIME,
    endpoint: process.env.GTRACE_ENDPOINT_RUNTIME,
    tracePath: process.env.GTRACE_TRACE_PATH_RUNTIME,
    metricsPath: process.env.GTRACE_METRICS_PATH_RUNTIME,
    installType: process.env.GTRACE_INSTALL_TYPE_RUNTIME,
    xToken: process.env.GTRACE_X_TOKEN_RUNTIME,
    scriptEnabled: booleanValue(process.env.GTRACE_SCRIPT_ENABLED_RUNTIME),
    captureContent: booleanValue(process.env.GTRACE_CAPTURE_CONTENT_RUNTIME),
    debug: booleanValue(process.env.GTRACE_DEBUG_RUNTIME),
    tags: parseJson(process.env.GTRACE_TAGS_RUNTIME, []),
    extraHeaders: parseJson(process.env.GTRACE_HEADERS_RUNTIME, []),
  };
}

const action = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (action === "write-gtrace-config") {
    const cliOptions = process.argv.length > 3 ? parseCliOptions(process.argv.slice(3)) : undefined;
    writeGtraceConfig(cliOptions ?? optionsFromEnvironment(action));
  }
  else if (["enable-plugin", "disable-plugin"].includes(action)) {
    updateWorkBuddySettings(optionsFromEnvironment(action));
  } else if (["enable-plugin-fallback", "disable-plugin-fallback"].includes(action)) {
    updateWorkBuddyFallbackInstall(optionsFromEnvironment(action));
  } else if (action === "remove-plugin-fallback-hooks") {
    removeWorkBuddyFallbackHooks(optionsFromEnvironment(action));
  } else {
    throw new Error(`Unsupported installer config action: ${action || "<empty>"}`);
  }
}
