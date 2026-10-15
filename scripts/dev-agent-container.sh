#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${FLEET_DEV_DIR:-$ROOT/.dev}"
BINARY="${FLEET_AGENT_BIN:-$ROOT/.dev/linux-target/debug/fleet-agent}"
CONTAINER=linux-fleet-agent
IMAGE=linux-fleet-agent-dev:local
[[ "$(id -u)" != 0 ]] || { echo 'Run this local development helper as your ordinary user.' >&2; exit 1; }
[[ -f "$DEV/agent.env" && -f "$DEV/tls/ca.crt" && -x "$BINARY" ]] || {
  echo 'Prepare .dev/agent.env, the development CA and a Linux fleet-agent binary first.' >&2
  exit 1
}
mkdir -p "$DEV/agent" "$DEV/agent-home"
chmod 700 "$DEV/agent" "$DEV/agent-home"
DEV="$(cd "$DEV" && pwd)"
BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"
# Replacing the wrong container must never discard another project's runtime.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  STATE_SOURCE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/state"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
  [[ "$STATE_SOURCE" == "$DEV/agent" ]] || { echo 'Existing container uses different Agent state; refusing to replace it.' >&2; exit 1; }
fi
docker build --file "$ROOT/deploy/dev/Dockerfile.agent" \
  --build-arg "FLEET_UID=$(id -u)" --build-arg "FLEET_GID=$(id -g)" \
  --tag "$IMAGE" "$ROOT/deploy/dev"
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker stop "$CONTAINER"
  docker rm "$CONTAINER"
fi
docker run --detach --init --name "$CONTAINER" --hostname local-linux --restart unless-stopped \
  --env-file "$DEV/agent.env" \
  --env FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION=1 \
  --mount "type=bind,source=$DEV/agent,target=/state" \
  --mount "type=bind,source=$DEV/agent-home,target=/home/fleet" \
  --mount "type=bind,source=$BINARY,target=/usr/local/bin/fleet-agent,readonly" \
  --mount "type=bind,source=$DEV/tls/ca.crt,target=/etc/fleet/ca.crt,readonly" \
  "$IMAGE"
printf 'Local Agent: %s; user: fleet; sudo enabled inside this development container; writable home: /home/fleet (persisted at %s/agent-home).\n' "$CONTAINER" "$DEV"
