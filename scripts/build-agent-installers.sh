#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${FLEET_AGENT_DIST_DIR:-$ROOT/.dev/agent-dist}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# Build each native architecture under Docker; the resulting static ELF needs no Rust toolchain on target hosts.
if [[ $# == 0 ]]; then set -- arm64 amd64; fi
for platform in "$@"; do
    case "$platform" in
      amd64) target=x86_64-unknown-linux-musl; machine=x86_64 ;;
      arm64) target=aarch64-unknown-linux-musl; machine=aarch64 ;;
      *) echo "Supported architectures: amd64 arm64" >&2; exit 1 ;;
    esac
    docker build --platform "linux/$platform" -f "$ROOT/deploy/agent/Dockerfile.build" -t "farhelm-agent-build:$platform" "$ROOT/deploy/agent"
    docker run --rm --platform "linux/$platform" \
      --mount "type=bind,source=$ROOT/agent,target=/src,readonly" \
      --mount "type=bind,source=$OUT,target=/out" \
      --mount "type=volume,source=farhelm-install-cargo-$platform,target=/usr/local/cargo/registry" \
      --mount "type=volume,source=farhelm-install-target-$platform,target=/target" \
      -e CARGO_TARGET_DIR=/target -e "FLEET_BUILD_TARGET=$target" -e "FLEET_BUILD_MACHINE=$machine" \
      "farhelm-agent-build:$platform" bash -c 'set -euo pipefail; cargo build --locked --release --target "$FLEET_BUILD_TARGET"; install -m 755 "/target/$FLEET_BUILD_TARGET/release/farhelm-agent" "/out/farhelm-agent-linux-$FLEET_BUILD_MACHINE.new"; mv "/out/farhelm-agent-linux-$FLEET_BUILD_MACHINE.new" "/out/farhelm-agent-linux-$FLEET_BUILD_MACHINE"'
done
