# Changelog

## 0.1.0

- Add native WorkBuddy 5.2.6 hooks for terminal main-agent and subagent turns.
- Export gtrace-compatible OTLP/HTTP Protobuf traces and metrics.
- Add content truncation and redaction, durable deduplication, and partial-upload resume.
- Add Bash and Windows PowerShell installers with local and remote installation, GTrace and standard OTLP presets, repeatable headers and resource tags, explicit collection/content/debug switches, and config-preserving upgrades.
- Add atomic cross-platform JSON configuration merging, Node.js 22 validation, stable release assets, marketplace metadata, tests, installer CI smoke tests, and release workflows.
- Exit disabled hooks before reading stdin or writing state, and support command hook payloads supplied over process stdin on Node.js 22.
