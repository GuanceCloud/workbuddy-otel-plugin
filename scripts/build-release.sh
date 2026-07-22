#!/usr/bin/env bash
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
ASSET_NAME="${ASSET_NAME:-workbuddy-otel-plugin.tar.gz}"
WINDOWS_ASSET_NAME="${WINDOWS_ASSET_NAME:-workbuddy-otel-plugin.zip}"
INSTALLER_NAME="${INSTALLER_NAME:-install-release.sh}"
WINDOWS_INSTALLER_NAME="${WINDOWS_INSTALLER_NAME:-install-release.ps1}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$DIST_DIR/workbuddy-otel-plugin-$VERSION"

rm -rf "$DIST_DIR"
mkdir -p "$STAGE"
for item in .codebuddy-plugin bin config docs hooks marketplace scripts src test AGENTS.md CHANGELOG.md README.md README_ZH.md package.json package-lock.json; do
  cp -R "$ROOT/$item" "$STAGE/"
done
chmod +x "$STAGE/bin/run-node" "$STAGE/scripts/install.sh" "$STAGE/scripts/install-release.sh" "$STAGE/scripts/build-release.sh"

tar -czf "$DIST_DIR/$ASSET_NAME" -C "$STAGE" .
(cd "$STAGE" && zip -qr "$DIST_DIR/$WINDOWS_ASSET_NAME" .)
cp "$ROOT/scripts/install-release.sh" "$DIST_DIR/$INSTALLER_NAME"
cp "$ROOT/scripts/install-release.ps1" "$DIST_DIR/$WINDOWS_INSTALLER_NAME"
chmod +x "$DIST_DIR/$INSTALLER_NAME"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DIST_DIR" && sha256sum "$ASSET_NAME" "$WINDOWS_ASSET_NAME" "$INSTALLER_NAME" "$WINDOWS_INSTALLER_NAME" > SHA256SUMS)
else
  (cd "$DIST_DIR" && shasum -a 256 "$ASSET_NAME" "$WINDOWS_ASSET_NAME" "$INSTALLER_NAME" "$WINDOWS_INSTALLER_NAME" > SHA256SUMS)
fi
printf 'Built release assets in %s\n' "$DIST_DIR"
