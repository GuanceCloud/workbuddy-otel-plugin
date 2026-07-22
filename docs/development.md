# Development

Requirements: Node.js 22 or newer. The production plugin normally uses WorkBuddy's managed Node runtime through `bin/run-node`.

```bash
npm test
npm run check
npm ls --all
npm run build:release
```

The test suite uses synthetic WorkBuddy 5.2.6 JSONL fixtures and a local OTLP/HTTP receiver. It decodes emitted Protobuf requests, verifies the span hierarchy and four metric families, and exercises duplicate Stop handling.

Hook diagnostics are written below the resolved plugin data directory as `gtrace-hook.log`. Authentication header values are redacted. Durable event and upload state is stored in its `events` and `uploads` subdirectories. The plugin prefers `${CODEBUDDY_PLUGIN_DATA}` and otherwise uses `${WORKBUDDY_CONFIG_DIR}/plugins/data/workbuddy-otel-plugin` (normally `~/.workbuddy/plugins/data/workbuddy-otel-plugin`).

For a local WorkBuddy smoke test, install the plugin, restart WorkBuddy, run one plain prompt, one tool call, and one expert/subagent request, then verify both configured signal endpoints receive OTLP Protobuf.
