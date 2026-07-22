import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const jsonFiles = [
  "package.json",
  "package-lock.json",
  ".codebuddy-plugin/plugin.json",
  "hooks/hooks.json",
  "marketplace/.codebuddy-plugin/marketplace.json",
  "config/marketplace.installed.json",
  "config/gtrace.example.json",
];
const parsedJson = new Map();
for (const file of jsonFiles) {
  try {
    parsedJson.set(file, JSON.parse(await fs.readFile(file, "utf-8")));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

const expectedVersion = parsedJson.get("package.json").version;
const { PLUGIN_VERSION } = await import("../src/workbuddy-spans.js");
const manifestVersions = [
  ["src/workbuddy-spans.js", PLUGIN_VERSION],
  ["package-lock.json", parsedJson.get("package-lock.json").version],
  [".codebuddy-plugin/plugin.json", parsedJson.get(".codebuddy-plugin/plugin.json").version],
  ["marketplace/.codebuddy-plugin/marketplace.json", parsedJson.get("marketplace/.codebuddy-plugin/marketplace.json").plugins?.[0]?.version],
  ["config/marketplace.installed.json", parsedJson.get("config/marketplace.installed.json").plugins?.[0]?.version],
];
for (const [file, version] of manifestVersions) {
  if (version !== expectedVersion) {
    throw new Error(`Version mismatch in ${file}: expected ${expectedVersion}, got ${version}`);
  }
}

const sourceDir = path.resolve("src");
const files = (await fs.readdir(sourceDir)).filter((file) => file.endsWith(".js")).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(sourceDir, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const file of ["scripts/install-config.js", "scripts/check.js"]) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
