# Installation and upgrade

## Requirements

- WorkBuddy 5.2.6 or newer on macOS or Windows.
- Node.js 22 or newer. The installers discover WorkBuddy's managed runtime, `node` on `PATH`, or `WORKBUDDY_OTEL_NODE`.
- Linux/macOS remote installation requires `curl`, `tar`, and `gzip`.
- Windows remote installation requires Windows PowerShell 5.1+ or PowerShell 7+.

The plugin has no runtime npm dependencies.

## Linux and macOS

Install the latest release without cloning the repository:

```bash
curl -fsSL https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --endpoint https://llm-openway.guance.com \
      --x-token '<client-token>' \
      --tag 'agent_id=workbuddy-prod' \
      --tag 'agent_name=WorkBuddy'
```

Install from a local checkout or extracted release:

```bash
bash scripts/install.sh \
  --endpoint https://llm-openway.guance.com \
  --x-token '<client-token>'
```

## Windows PowerShell

Remote installation:

```powershell
$installer = Join-Path $env:TEMP "workbuddy-otel-install.ps1"
Invoke-WebRequest https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
  -Version latest `
  -Endpoint https://llm-openway.guance.com `
  -XToken '<client-token>'
```

For array arguments, invoke the installer from a PowerShell session or use `-Command` so Windows PowerShell preserves the array:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `
  "& '$installer' -Version latest -Endpoint https://llm-openway.guance.com -XToken '<client-token>' -Tag @('agent_id=workbuddy-prod','agent_name=WorkBuddy')"
```

Local installation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 `
  -Endpoint https://llm-openway.guance.com `
  -XToken '<client-token>'
```

## GTrace and standard OTLP

GTrace is the default preset. It writes the Guance routes and `To-Headless` header:

```bash
bash scripts/install.sh --type gtrace --endpoint https://llm-openway.guance.com --x-token '<client-token>'
```

For a standard OTLP/HTTP receiver:

```bash
bash scripts/install.sh \
  --type otlp \
  --endpoint http://otel-collector.example:4318 \
  --header 'Authorization=Bearer <token>'
```

The OTLP preset uses `v1/traces` and `v1/metrics`. Explicit `--trace-path` and `--metrics-path` values override either preset.

## Upgrade

Run the same installer again. Endpoint, X-Token, routes, `enabled`, content capture, debug settings, custom headers, resource attributes, and unrelated JSON fields are preserved when their corresponding options are omitted:

```bash
curl -fsSL https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest
```

Install a specific version by replacing `latest` with `v0.1.1` or `0.1.1`. PowerShell uses `-Version v0.1.1`.

## Runtime switches

Keep the plugin installed but stop all Hook processing and uploads:

```bash
bash scripts/install.sh --disable-script
bash scripts/install.sh --enable-script
```

```powershell
.\scripts\install.ps1 -DisableScript
.\scripts\install.ps1 -EnableScript
```

Content capture and detailed diagnostics are also changed only when explicitly requested:

```bash
bash scripts/install.sh --no-capture-content --debug
```

```powershell
.\scripts\install.ps1 -NoCaptureContent -EnableDebug
```

## Uninstall

Remove the plugin while preserving `gtrace.json` and durable upload state:

```bash
bash scripts/install.sh --uninstall
```

```powershell
.\scripts\install.ps1 -Uninstall
```

Add `--purge` or `-Purge` to remove upload configuration and plugin state as well.

## Arguments

| Shell | PowerShell | Meaning |
| --- | --- | --- |
| `--refresh` | `-Refresh` | Replace installed runtime files. |
| `--type gtrace\|otlp` | `-Type gtrace\|otlp` | Endpoint/path preset. |
| `--endpoint URL` | `-Endpoint URL` | Receiver base URL. |
| `--x-token TOKEN` | `-XToken TOKEN` | GTrace/Dataway X-Token. |
| `--trace-path PATH` | `-TracePath PATH` | Trace route override. |
| `--metrics-path PATH` | `-MetricsPath PATH` | Metrics route override. |
| `--header KEY=VALUE` | `-Header @(...)` | Extra HTTP header; repeatable. |
| `--tag KEY=VALUE` | `-Tag @(...)` | OTEL resource attribute; repeatable. |
| `--config-dir DIR` | `-ConfigDir DIR` | WorkBuddy profile directory. |
| `--config-file FILE` | `-ConfigFile FILE` | Upload config file. |
| `--enable-script` | `-EnableScript` | Explicitly enable Hook processing. |
| `--disable-script` | `-DisableScript` | Explicitly disable Hook processing. |
| `--capture-content` | `-CaptureContent` | Enable content capture. |
| `--no-capture-content` | `-NoCaptureContent` | Disable content capture. |
| `--debug` | `-EnableDebug` | Enable detailed diagnostics. |
| `--no-debug` | `-NoDebug` | Disable detailed diagnostics. |
| `--no-config` | `-NoConfig` | Install files only. |
| `--uninstall` | `-Uninstall` | Remove plugin files and activation. |
| `--purge` | `-Purge` | Also remove upload config and state. |
