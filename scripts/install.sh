#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONFIG_DIR="${WORKBUDDY_CONFIG_DIR:-${CODEBUDDY_CONFIG_DIR:-$HOME/.workbuddy}}"
CONFIG_FILE="${GTRACE_CONFIG_FILE:-}"
INSTALL_TYPE="${WORKBUDDY_OTEL_INSTALL_TYPE:-gtrace}"
TYPE_EXPLICIT=0
[[ -z "${WORKBUDDY_OTEL_INSTALL_TYPE:-}" ]] || TYPE_EXPLICIT=1
ENDPOINT="${GTRACE_ENDPOINT:-${WORKBUDDY_OTEL_ENDPOINT:-}}"
TRACE_PATH="${GTRACE_TRACE_PATH:-${WORKBUDDY_OTEL_TRACE_PATH:-}}"
METRICS_PATH="${GTRACE_METRICS_PATH:-${WORKBUDDY_OTEL_METRICS_PATH:-}}"
X_TOKEN="${GTRACE_X_TOKEN:-${X_TOKEN:-}}"
REFRESH=false
WRITE_CONFIG=1
UNINSTALL=false
PURGE=false
SCRIPT_ENABLED=""
CAPTURE_CONTENT=""
DEBUG=""
CONFIG_REQUESTED=0
ENABLE_SEEN=0
DISABLE_SEEN=0
CAPTURE_SEEN=0
NO_CAPTURE_SEEN=0
# The empty sentinel keeps array expansion safe with `set -u` on macOS Bash 3.2.
# array_json removes it before writing configuration.
TAGS=("")
HEADERS=("")

log() {
  printf '[install] %s\n' "$1"
}

usage() {
  cat <<HELP
Usage:
  scripts/install.sh [options]

Options:
  --refresh, --reinstall  Replace the installed runtime with this version.
  --type gtrace|otlp     Configuration preset. Default: gtrace.
  --endpoint URL         Receiver base URL.
  --x-token TOKEN        GTrace/Dataway X-Token; never printed.
  --trace-path PATH      Trace route. GTrace default: v1/write/otel-llm.
  --metrics-path PATH    Metrics route. GTrace default: v1/write/otel-metrics.
  --header KEY=VALUE     Extra HTTP header; repeatable.
  --tag KEY=VALUE        OTEL resource attribute; repeatable.
  --config-dir DIR       WorkBuddy profile. Default: ~/.workbuddy.
  --config-file FILE     Upload configuration file. Default: <config-dir>/gtrace.json.
  --enable-script        Set enabled=true explicitly.
  --disable-script       Set enabled=false explicitly.
  --capture-content      Enable prompt, output, and tool content capture.
  --no-capture-content   Disable content capture.
  --debug, --no-debug    Explicitly enable or disable detailed diagnostics.
  --no-config            Install files without creating or updating gtrace.json.
  --uninstall            Remove the plugin while preserving config and state.
  --purge                With --uninstall, also remove config and plugin state.

Environment variables:
  WORKBUDDY_CONFIG_DIR, CODEBUDDY_CONFIG_DIR, GTRACE_CONFIG_FILE
  WORKBUDDY_OTEL_ENDPOINT, GTRACE_ENDPOINT
  WORKBUDDY_OTEL_TRACE_PATH, GTRACE_TRACE_PATH
  WORKBUDDY_OTEL_METRICS_PATH, GTRACE_METRICS_PATH
  GTRACE_X_TOKEN, X_TOKEN, WORKBUDDY_OTEL_INSTALL_TYPE, WORKBUDDY_OTEL_NODE
HELP
}

require_value() {
  [[ "$#" -gt 1 ]] || { echo "$1 requires a value" >&2; exit 2; }
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --refresh|--reinstall) REFRESH=true ;;
    --no-config) WRITE_CONFIG=0 ;;
    --uninstall) UNINSTALL=true ;;
    --purge) PURGE=true ;;
    --enable-script|--enable) SCRIPT_ENABLED=true; ENABLE_SEEN=1; CONFIG_REQUESTED=1 ;;
    --disable-script|--disable) SCRIPT_ENABLED=false; DISABLE_SEEN=1; CONFIG_REQUESTED=1 ;;
    --capture-content) CAPTURE_CONTENT=true; CAPTURE_SEEN=1; CONFIG_REQUESTED=1 ;;
    --no-capture-content) CAPTURE_CONTENT=false; NO_CAPTURE_SEEN=1; CONFIG_REQUESTED=1 ;;
    --debug) DEBUG=true; CONFIG_REQUESTED=1 ;;
    --no-debug) DEBUG=false; CONFIG_REQUESTED=1 ;;
    --type)
      shift; require_value --type "$@"; INSTALL_TYPE="$1"; TYPE_EXPLICIT=1
      ;;
    --type=*) INSTALL_TYPE="${1#*=}"; TYPE_EXPLICIT=1 ;;
    --endpoint)
      shift; require_value --endpoint "$@"; ENDPOINT="$1"; CONFIG_REQUESTED=1
      ;;
    --endpoint=*) ENDPOINT="${1#*=}"; CONFIG_REQUESTED=1 ;;
    --trace-path)
      shift; require_value --trace-path "$@"; TRACE_PATH="$1"; CONFIG_REQUESTED=1
      ;;
    --trace-path=*) TRACE_PATH="${1#*=}"; CONFIG_REQUESTED=1 ;;
    --metrics-path)
      shift; require_value --metrics-path "$@"; METRICS_PATH="$1"; CONFIG_REQUESTED=1
      ;;
    --metrics-path=*) METRICS_PATH="${1#*=}"; CONFIG_REQUESTED=1 ;;
    --x-token)
      shift; require_value --x-token "$@"; X_TOKEN="$1"; CONFIG_REQUESTED=1
      ;;
    --x-token=*) X_TOKEN="${1#*=}"; CONFIG_REQUESTED=1 ;;
    --header)
      shift; require_value --header "$@"; HEADERS+=("$1"); CONFIG_REQUESTED=1
      ;;
    --header=*) HEADERS+=("${1#*=}"); CONFIG_REQUESTED=1 ;;
    --tag)
      shift; require_value --tag "$@"; TAGS+=("$1"); CONFIG_REQUESTED=1
      ;;
    --tag=*) TAGS+=("${1#*=}"); CONFIG_REQUESTED=1 ;;
    --config-dir)
      shift; require_value --config-dir "$@"; CONFIG_DIR="$1"
      ;;
    --config-dir=*) CONFIG_DIR="${1#*=}" ;;
    --config-file)
      shift; require_value --config-file "$@"; CONFIG_FILE="$1"
      ;;
    --config-file=*) CONFIG_FILE="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$ENABLE_SEEN" -eq 1 && "$DISABLE_SEEN" -eq 1 ]]; then
  echo "--enable-script and --disable-script cannot be used together" >&2
  exit 2
fi
if [[ "$CAPTURE_SEEN" -eq 1 && "$NO_CAPTURE_SEEN" -eq 1 ]]; then
  echo "--capture-content and --no-capture-content cannot be used together" >&2
  exit 2
fi
if [[ "$INSTALL_TYPE" == otel ]]; then INSTALL_TYPE=otlp; fi
case "$INSTALL_TYPE" in
  gtrace|otlp) ;;
  *) echo "Unsupported --type: $INSTALL_TYPE. Supported values: gtrace, otlp" >&2; exit 2 ;;
esac
for assignment in "${TAGS[@]}" "${HEADERS[@]}"; do
  [[ -z "$assignment" || ( "$assignment" == *=* && -n "${assignment%%=*}" ) ]] || {
    echo "Expected KEY=VALUE, got: $assignment" >&2
    exit 2
  }
done
if [[ "$PURGE" == true && "$UNINSTALL" != true ]]; then
  echo "--purge requires --uninstall" >&2
  exit 2
fi

CONFIG_FILE="${CONFIG_FILE:-$CONFIG_DIR/gtrace.json}"
MARKETPLACE_DIR="$CONFIG_DIR/plugins/marketplaces/guance"
TARGET_DIR="$MARKETPLACE_DIR/plugins/workbuddy-otel-plugin"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
DATA_DIR="$CONFIG_DIR/plugins/data/workbuddy-otel-plugin"
PLUGIN_SELECTOR="workbuddy-otel-plugin@guance"
CONFIG_HELPER="$REPO_ROOT/scripts/install-config.js"

resolve_node() {
  local candidate=""
  if [[ -n "${WORKBUDDY_OTEL_NODE:-}" ]]; then
    [[ -x "$WORKBUDDY_OTEL_NODE" ]] || { echo "WORKBUDDY_OTEL_NODE is not executable: $WORKBUDDY_OTEL_NODE" >&2; exit 1; }
    printf '%s' "$WORKBUDDY_OTEL_NODE"
    return
  fi
  if [[ -x "$REPO_ROOT/bin/run-node" ]]; then
    candidate="$("$REPO_ROOT/bin/run-node" -p 'process.execPath' 2>/dev/null || true)"
  fi
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  cat >&2 <<'EOF'
Missing required command: node

workbuddy-otel-plugin requires Node.js >= 22. Install the WorkBuddy managed
Node.js runtime, install Node.js 22+, or set WORKBUDDY_OTEL_NODE explicitly.
EOF
  exit 1
}

[[ -f "$CONFIG_HELPER" ]] || { echo "Cannot find $CONFIG_HELPER" >&2; exit 1; }
NODE_BIN="$(resolve_node)"
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 22 ]]; then
  echo "Node.js >= 22 is required. Found: $("$NODE_BIN" --version 2>/dev/null || echo unknown) at $NODE_BIN" >&2
  exit 1
fi

update_plugin_setting() {
  local action="$1"
  WORKBUDDY_SETTINGS_FILE_RUNTIME="$SETTINGS_FILE" \
  WORKBUDDY_PLUGIN_SELECTOR_RUNTIME="$PLUGIN_SELECTOR" \
    "$NODE_BIN" "$CONFIG_HELPER" "$action"
}

if [[ "$UNINSTALL" == true ]]; then
  rm -rf "$TARGET_DIR"
  update_plugin_setting disable-plugin
  if [[ "$PURGE" == true ]]; then
    rm -rf "$DATA_DIR"
    rm -f "$CONFIG_FILE"
    log "removed upload config and plugin state"
  fi
  log "uninstalled $PLUGIN_SELECTOR from $CONFIG_DIR"
  exit 0
fi

[[ -f "$REPO_ROOT/src/workbuddy-hook.js" ]] || { echo "Cannot find WorkBuddy plugin runtime under $REPO_ROOT" >&2; exit 1; }
mkdir -p "$MARKETPLACE_DIR/.codebuddy-plugin" "$TARGET_DIR" "$CONFIG_DIR"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
for item in .codebuddy-plugin bin hooks src; do
  cp -R "$REPO_ROOT/$item" "$TARGET_DIR/"
done
cp "$REPO_ROOT/package.json" "$TARGET_DIR/package.json"
cp "$REPO_ROOT/config/marketplace.installed.json" "$MARKETPLACE_DIR/.codebuddy-plugin/marketplace.json"
chmod +x "$TARGET_DIR/bin/run-node"

if [[ -f "$SETTINGS_FILE" ]]; then
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.workbuddy-otel-plugin.bak"
fi
update_plugin_setting enable-plugin
log "$([[ "$REFRESH" == true ]] && printf 'refreshed' || printf 'installed') plugin: $TARGET_DIR"

if [[ -z "$TRACE_PATH" && ( -n "$ENDPOINT" || ! -f "$CONFIG_FILE" || "$TYPE_EXPLICIT" -eq 1 ) ]]; then
  TRACE_PATH="$([[ "$INSTALL_TYPE" == gtrace ]] && printf 'v1/write/otel-llm' || printf 'v1/traces')"
fi
if [[ -z "$METRICS_PATH" && ( -n "$ENDPOINT" || ! -f "$CONFIG_FILE" || "$TYPE_EXPLICIT" -eq 1 ) ]]; then
  METRICS_PATH="$([[ "$INSTALL_TYPE" == gtrace ]] && printf 'v1/write/otel-metrics' || printf 'v1/metrics')"
fi

if [[ "$WRITE_CONFIG" -eq 0 ]]; then
  log "skipped config because --no-config was set"
elif [[ -f "$CONFIG_FILE" || -n "$ENDPOINT" || "$CONFIG_REQUESTED" -eq 1 ]]; then
  CONFIG_ARGS=(
    --config-file "$CONFIG_FILE"
    --endpoint "$ENDPOINT"
    --trace-path "$TRACE_PATH"
    --metrics-path "$METRICS_PATH"
    --x-token "$X_TOKEN"
  )
  if [[ ! -f "$CONFIG_FILE" || -n "$ENDPOINT" || "$TYPE_EXPLICIT" -eq 1 ]]; then
    CONFIG_ARGS+=(--install-type "$INSTALL_TYPE")
  fi
  if [[ -n "$SCRIPT_ENABLED" ]]; then
    CONFIG_ARGS+=(--script-enabled "$SCRIPT_ENABLED")
  fi
  if [[ -n "$CAPTURE_CONTENT" ]]; then
    CONFIG_ARGS+=(--capture-content "$CAPTURE_CONTENT")
  fi
  if [[ -n "$DEBUG" ]]; then
    CONFIG_ARGS+=(--debug "$DEBUG")
  fi
  for tag in "${TAGS[@]}"; do
    [[ -z "$tag" ]] || CONFIG_ARGS+=(--tag "$tag")
  done
  for header in "${HEADERS[@]}"; do
    [[ -z "$header" ]] || CONFIG_ARGS+=(--header "$header")
  done
  "$NODE_BIN" "$CONFIG_HELPER" write-gtrace-config "${CONFIG_ARGS[@]}"
  log "updated $CONFIG_FILE"
  [[ -z "$ENDPOINT" ]] || log "configured endpoint: ${ENDPOINT%/}"
  [[ -z "$TRACE_PATH" ]] || log "configured trace path: $TRACE_PATH"
  [[ -z "$METRICS_PATH" ]] || log "configured metrics path: $METRICS_PATH"
  [[ -z "$X_TOKEN" ]] || log "configured X-Token: <redacted>"
else
  log "skipped config because --endpoint was not provided"
fi

cat <<EOF

Installation complete.
Plugin: $PLUGIN_SELECTOR
Configuration: $CONFIG_FILE
Restart WorkBuddy or run /reload-plugins so the Hooks are reloaded.
EOF
