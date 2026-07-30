# Changelog

## 0.1.5

- Fix the installer helper entrypoint check in `scripts/install-config.js` by comparing real paths instead of raw URL strings, so macOS temporary paths such as `/var/...` and `/private/var/...` no longer cause silent no-op installs.
- Add regression coverage for invoking the installer helper through a symlinked path, matching the remote installer extraction flow on macOS.

## 0.1.4

- Add a no-CLI fallback that writes managed global hooks into `~/.workbuddy/settings.json` and records the plugin in `~/.workbuddy/plugins/installed_plugins.json`, so macOS installs still load telemetry when `workbuddy` / `codebuddy` is not available in `PATH`.
- Abort install and uninstall on macOS while WorkBuddy is still running, preventing the desktop app from writing stale plugin state back over the installer's changes.
- Add regression coverage for fallback hook installation, plugin registry updates, and settings cleanup.

## 0.1.3

- Copy the installed plugin into WorkBuddy's versioned cache directory so Hook runtime files exist under `~/.workbuddy/plugins/cache/guance/workbuddy-otel-plugin/<version>`.
- Prefer the official `workbuddy` or `codebuddy` CLI activation flow during install, including marketplace refresh and plugin install/enable, and keep direct `settings.json` mutation as a fallback.
- Add installer regression coverage for cache population and CLI-based activation so macOS user installs match the working `codex-otel-plugin` behavior.

## 0.1.2

- Align the macOS shell installer tag update path with `codex-otel-plugin` by passing `--tag` and `--header` values directly to the config helper.
- Add direct CLI parsing support to the installer helper while keeping the existing environment-variable path for PowerShell installs.
- Add regression coverage for overwriting existing `agent_id` and `agent_name` resource attributes during reinstall.

## 0.1.1

- Reapply the explicit `gtrace` or `otlp` preset routes during reinstall when `gtrace.json` already exists, matching the fixed installer behavior on macOS and Windows.
- Add a shell-installer regression test that verifies preset route overrides on an existing configuration.
- Update README install commands to include repeatable `--tag` / `-Tag` examples for `agent_id` and `agent_name`.

## 0.1.0

- Add native WorkBuddy 5.2.6 hooks for terminal main-agent and subagent turns.
- Export gtrace-compatible OTLP/HTTP Protobuf traces and metrics.
- Add content truncation and redaction, durable deduplication, and partial-upload resume.
- Add Bash and Windows PowerShell installers with local and remote installation, GTrace and standard OTLP presets, repeatable headers and resource tags, explicit collection/content/debug switches, and config-preserving upgrades.
- Add atomic cross-platform JSON configuration merging, Node.js 22 validation, stable release assets, marketplace metadata, tests, installer CI smoke tests, and release workflows.
- Exit disabled hooks before reading stdin or writing state, and support command hook payloads supplied over process stdin on Node.js 22.
