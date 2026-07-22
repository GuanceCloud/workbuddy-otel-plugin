# workbuddy-otel-plugin

`workbuddy-otel-plugin` exports native WorkBuddy sessions as OpenTelemetry traces and metrics that follow the [Guance gtrace AI semantic conventions](https://github.com/GuanceCloud/guance-gtrace-ai-semantic-conventions).

The first explicitly supported release is WorkBuddy 5.2.6 on macOS (Apple Silicon and Intel) and Windows x64. The plugin does not patch WorkBuddy, has no runtime npm dependencies, and does not export OTEL logs.

## Quick install

Linux/macOS:

```bash
curl -fsSL https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest --endpoint https://llm-openway.guance.com --x-token '<client-token>'
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "workbuddy-otel-install.ps1"
Invoke-WebRequest https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Version latest -Endpoint https://llm-openway.guance.com -XToken '<client-token>'
```

Restart WorkBuddy or run `/reload-plugins` after installation. The installers create a local `guance` marketplace, enable `workbuddy-otel-plugin@guance`, preserve unrelated WorkBuddy settings, and merge `gtrace.json`. Normal upgrades preserve endpoint, token, paths, runtime enablement, and privacy settings when those options are omitted.

You can also install through WorkBuddy's local marketplace flow:

```text
/plugin marketplace add /path/to/workbuddy-otel-plugin/marketplace
/plugin install workbuddy-otel-plugin@guance
```

In that flow, WorkBuddy stores the sensitive `x_token` plugin option in its credential store.

## Signals

- One `invoke_agent` trace per terminal turn.
- Direct `llm`, `assistant`, and `tool:<name>` children.
- High-confidence `skill:<name>` spans nested under the matching tool.
- Separate standard traces for main and subagents, with parent correlation attributes when WorkBuddy exposes them.
- `gen_ai.workflow.duration`, `gen_ai.agent.operation.count`, `gen_ai.agent.operation.duration`, and `gen_ai.client.token.usage` metrics.
- OTLP/HTTP Protobuf transport with per-signal retry and durable deduplication.

Configuration priority is WorkBuddy plugin options, standard OTEL environment variables, `~/.workbuddy/gtrace.json`, then defaults. Content capture is enabled by default, limited to 20,000 characters per field, and can be disabled with `capture_content: false`.

See [installation](docs/install.md), [configuration](docs/configuration.md), [traces](docs/traces.md), [metrics](docs/metrics.md), [privacy](docs/privacy.md), and [development](docs/development.md). The Chinese guide is [README_ZH.md](README_ZH.md).
