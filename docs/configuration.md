# Configuration

The plugin reads `${WORKBUDDY_CONFIG_DIR}/gtrace.json`, falling back to `~/.workbuddy/gtrace.json`.

## Fields

| Field | Meaning | Default |
| --- | --- | --- |
| `enabled` | Enable terminal-turn export | `true` |
| `endpoint` | Base Guance OpenWay or OTLP endpoint | `https://llm-openway.guance.com` |
| `tracePath` | Trace path appended to `endpoint` | `v1/write/otel-llm` |
| `metricsPath` | Metrics path appended to `endpoint` | `v1/write/otel-metrics` |
| `otel_traces_url` | Complete trace URL; overrides endpoint/path | unset |
| `otel_metrics_url` | Complete metrics URL; overrides endpoint/path | unset |
| `headers` | HTTP headers such as `X-Token` | `{}` |
| `capture_content` | Capture prompts, responses, arguments and results | `true` |
| `max_chars` | Maximum characters per captured string | `20000` |
| `timeout_ms` | Timeout for each HTTP attempt | `25000` |
| `debug` | Write additional Hook lifecycle diagnostics | `false` |
| `resourceAttributes` | Stable primitive OTEL resource attributes | `{}` |

Plugin UI options are `endpoint` and sensitive `x_token`. Supported standard environment variables are `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and `OTEL_EXPORTER_OTLP_TIMEOUT`.

WorkBuddy-specific overrides are `WORKBUDDY_OTEL_ENABLED`, `WORKBUDDY_OTEL_CAPTURE_CONTENT`, `WORKBUDDY_OTEL_MAX_CHARS`, and `WORKBUDDY_OTEL_DEBUG`.

Precedence is:

1. `CODEBUDDY_PLUGIN_OPTION_*` values supplied by WorkBuddy.
2. OTEL and WorkBuddy environment variables.
3. `gtrace.json`.
4. Built-in defaults.

Normal installer upgrades merge this file and preserve values whose installer options were omitted. Use `--enable-script` / `--disable-script` on Shell or `-EnableScript` / `-DisableScript` on PowerShell to change `enabled` explicitly. When disabled, the Hook exits before reading stdin, transcripts, or writing event state.

Do not place session IDs, paths, prompts, or other high-cardinality values in `resourceAttributes`.

## Uninstall

```bash
bash scripts/install.sh --uninstall
bash scripts/install.sh --uninstall --purge
```

```powershell
.\scripts\install.ps1 -Uninstall
.\scripts\install.ps1 -Uninstall -Purge
```

Normal uninstall preserves `gtrace.json` and plugin state. `--purge`/`-Purge` removes them.
