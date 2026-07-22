#!/usr/bin/env bash
set -euo pipefail

REPO="${WORKBUDDY_OTEL_REPO:-GuanceCloud/workbuddy-otel-plugin}"
REF="${WORKBUDDY_OTEL_VERSION:-${WORKBUDDY_OTEL_REF:-latest}}"
ASSET_NAME="${WORKBUDDY_OTEL_RELEASE_ASSET_NAME:-workbuddy-otel-plugin.tar.gz}"

usage() {
  cat <<HELP
Usage:
  install-release.sh [latest|vX.Y.Z|X.Y.Z] [install options]

Examples:
  curl -fsSL <installer-url> | bash -s -- latest --endpoint https://llm-openway.guance.com --x-token <token>
  curl -fsSL <installer-url> | bash -s -- v0.1.0 --no-config

Options are passed to scripts/install.sh. Common options:
  --type gtrace|otlp
  --endpoint URL
  --x-token TOKEN
  --trace-path PATH
  --metrics-path PATH
  --header KEY=VALUE
  --tag KEY=VALUE
  --enable-script | --disable-script
  --capture-content | --no-capture-content
  --debug | --no-debug
  --config-dir DIR
  --config-file FILE
  --no-config

Environment variables:
  WORKBUDDY_OTEL_REPO                GitHub repository.
  WORKBUDDY_OTEL_VERSION             Release version. Default: latest.
  WORKBUDDY_OTEL_RELEASE_ASSET_NAME  Release tar.gz asset name.
  WORKBUDDY_OTEL_RELEASE_API_URL     Latest-release API override.
  WORKBUDDY_OTEL_ARCHIVE_URL         Complete tar.gz URL override.
  WORKBUDDY_OTEL_NODE                Node.js executable override.
HELP
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

if [[ "$#" -gt 0 && "$1" != --* ]]; then
  case "$1" in
    latest) REF=latest ;;
    v*) REF="$1" ;;
    *) REF="v$1" ;;
  esac
  shift
fi

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

resolve_release_ref() {
  local ref="$1"
  if [[ "$ref" != latest ]]; then
    printf '%s' "$ref"
    return
  fi
  local api_url="${WORKBUDDY_OTEL_RELEASE_API_URL:-https://api.github.com/repos/$REPO/releases/latest}"
  local response tag
  response="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url" 2>/dev/null || true)"
  tag="$(printf '%s' "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  printf '%s' "${tag:-latest}"
}

release_url() {
  local ref="$1"
  if [[ "$ref" == latest ]]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$ASSET_NAME"
  else
    printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$ref" "$ASSET_NAME"
  fi
}

need curl
need tar
need gzip
if [[ -n "${WORKBUDDY_OTEL_ARCHIVE_URL:-}" ]]; then
  RESOLVED_REF="$REF"
  ARCHIVE_URL="$WORKBUDDY_OTEL_ARCHIVE_URL"
else
  RESOLVED_REF="$(resolve_release_ref "$REF")"
  ARCHIVE_URL="$(release_url "$RESOLVED_REF")"
fi
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/repo"

printf 'Downloading %s\n' "$ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TMP_DIR/repo"
[[ -f "$TMP_DIR/repo/scripts/install.sh" ]] || { echo "Release archive does not contain scripts/install.sh" >&2; exit 1; }

printf '%s\n' 'Installing plugin from temporary archive'
REPO_ROOT="$TMP_DIR/repo" bash "$TMP_DIR/repo/scripts/install.sh" --refresh "$@"
