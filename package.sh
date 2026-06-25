#!/usr/bin/env bash
# Build a clean Chrome Web Store zip containing ONLY the extension files.
# Excludes the optional Cloudflare worker, docs, and tooling.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(grep -m1 '"version"' manifest.json | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')
OUT="dist/depanalyzer-${VERSION}.zip"

# Explicit allowlist of what ships — anything not listed here is excluded.
FILES=(
  manifest.json
  background.js
  popup.html popup.css popup.js
  options.html options.js
  theme-init.js
  lib
  icons
)

mkdir -p dist
rm -f "$OUT"
zip -r -X "$OUT" "${FILES[@]}" >/dev/null
echo "Built $OUT"
unzip -l "$OUT"
