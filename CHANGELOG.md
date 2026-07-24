# Changelog

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
