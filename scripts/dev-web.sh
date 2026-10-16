#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${FLEET_DEV_DIR:-$ROOT/.dev}"
export FLEET_DEV_API_TARGET="${FLEET_DEV_API_TARGET:-https://localhost:${FLEET_PORT:-8443}}"
export FLEET_DEV_WEB_TLS_CERT="${FLEET_DEV_WEB_TLS_CERT:-$DEV/tls/server.crt}"
export FLEET_DEV_WEB_TLS_KEY="${FLEET_DEV_WEB_TLS_KEY:-$DEV/tls/server.key}"
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$DEV/tls/ca.crt}"
for file in "$FLEET_DEV_WEB_TLS_CERT" "$FLEET_DEV_WEB_TLS_KEY" "$NODE_EXTRA_CA_CERTS"; do
  [[ -r "$file" ]] || { printf 'Missing readable development TLS file: %s\n' "$file" >&2; exit 1; }
done
# Bind only to loopback by default. Keep upstream certificate verification on.
exec env -u FLEET_ADMIN_PASSWORD -u FLEET_ADMIN_USER -u FLEET_ENROLLMENT_TOKEN \
  node "$ROOT/scripts/dev-web.mjs"
