#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${FLEET_ADMIN_USER:=admin}"
: "${FLEET_ADMIN_PASSWORD:?Set FLEET_ADMIN_PASSWORD to a unique local administrator password (12+ characters)}"
: "${FLEET_PORT:=8443}"
: "${FLEET_DEV_DIR:=$ROOT/.dev}"
export FLEET_ADMIN_USER FLEET_ADMIN_PASSWORD FLEET_PORT
export FLEET_SSH_PORT="${FLEET_SSH_PORT:-2222}"
export FLEET_SSH_HOST=127.0.0.1
export FLEET_HOST=127.0.0.1 FLEET_DATA_DIR="$FLEET_DEV_DIR/server"
export FLEET_TLS_CERT="$FLEET_DEV_DIR/tls/server.crt" FLEET_TLS_KEY="$FLEET_DEV_DIR/tls/server.key"
export FLEET_CA_CERT="$FLEET_DEV_DIR/tls/ca.crt"
export FLEET_SERVER_URL="https://localhost:$FLEET_PORT"
export FLEET_STATE_DIR="$FLEET_DEV_DIR/agent" FLEET_DEVICE_NAME=local-linux
export FLEET_EXECUTION_BACKEND="${FLEET_EXECUTION_BACKEND:-same-uid}"
export FLEET_WEB_DIST="$ROOT/apps/web/dist"
export FLEET_AGENT_DIST_DIR="${FLEET_AGENT_DIST_DIR:-$FLEET_DEV_DIR/agent-dist}"
export FLEET_PUBLIC_URL="${FLEET_PUBLIC_URL:-$FLEET_SERVER_URL}"
export FLEET_CONSOLE_ORIGIN=http://127.0.0.1:5173
if [[ ! -f "$FLEET_TLS_CERT" ]]; then bash deploy/dev/generate-tls.sh "$FLEET_DEV_DIR/tls"; fi
[[ -x agent/target/debug/farhelm-agent ]] || { echo 'Build first: cargo build --manifest-path agent/Cargo.toml --locked' >&2; exit 1; }
pids=()
cleanup(){ trap - INT TERM EXIT; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait || true; }
trap cleanup INT TERM EXIT
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts & pids+=("$!")
export FLEET_ENROLLMENT_TOKEN="$(node scripts/dev-enroll.mjs)"
env -u FLEET_ADMIN_PASSWORD -u FLEET_ADMIN_USER ./agent/target/debug/farhelm-agent & pids+=("$!")
NODE_EXTRA_CA_CERTS="$FLEET_CA_CERT" FLEET_DEV_API_TARGET="$FLEET_SERVER_URL" env -u FLEET_ADMIN_PASSWORD -u FLEET_ADMIN_USER node "$ROOT/apps/web/node_modules/vite/bin/vite.js" "$ROOT/apps/web" --host 127.0.0.1 & pids+=("$!")
printf '\nFarhelm console: http://127.0.0.1:5173 (loopback development only)\nFarhelm HTTPS server: %s (explicit CA trust needed in browser)\nSingle-account mode shares Agent and command permissions. Only run trusted commands.\nCtrl-C stops this demo only.\n' "$FLEET_SERVER_URL"
wait -n "${pids[@]}"
