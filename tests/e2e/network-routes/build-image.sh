#!/usr/bin/env bash
set -euo pipefail
# Native arm64 fixture used by network-routes.mjs; never changes host VPN settings.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CACHE="${TMPDIR:-/tmp}/farhelm-easytier-fixture-build"
mkdir -p "$CACHE"
if [[ ! -f "$CACHE/easytier.zip" ]]; then
  curl -fL --connect-timeout 10 --max-time 120 -o "$CACHE/easytier.zip.part" https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-linux-aarch64-v2.6.4.zip
  mv "$CACHE/easytier.zip.part" "$CACHE/easytier.zip"
fi
if [[ ! -f "$CACHE/node.tar.xz" ]]; then
  curl -fL --connect-timeout 10 --max-time 120 -o "$CACHE/node.tar.xz.part" https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-arm64.tar.xz
  mv "$CACHE/node.tar.xz.part" "$CACHE/node.tar.xz"
fi
unzip -q -o "$CACHE/easytier.zip" -d "$CACHE"
tar -xJf "$CACHE/node.tar.xz" -C "$CACHE" node-v24.14.0-linux-arm64/bin/node
cp "$ROOT/tests/e2e/network-routes/Dockerfile" "$CACHE/Dockerfile"
docker build -t farhelm-network-test:local "$CACHE"
