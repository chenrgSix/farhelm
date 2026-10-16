#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TEMP="$(mktemp -d /tmp/fleet-dev-startup-XXXXXX)"
FLEET_DEV_DIR="$TEMP" FLEET_PORT=8444 FLEET_SSH_PORT=2223 FLEET_DEV_WEB_PORT=5174 FLEET_ADMIN_USER=startup-test FLEET_ADMIN_PASSWORD='isolated-startup-test-password1' bash scripts/dev.sh > "$TEMP/startup.log" 2>&1 &
launcher=$!
cleanup(){ kill -TERM "$launcher" 2>/dev/null || true; wait "$launcher" 2>/dev/null || true; }
trap cleanup EXIT
ready=0
for _ in $(seq 1 100); do
 if [[ -f "$TEMP/tls/ca.crt" ]] && curl -fsS --cacert "$TEMP/tls/ca.crt" https://localhost:8444/healthz > "$TEMP/health.json" 2>/dev/null && curl -fsS --cacert "$TEMP/tls/ca.crt" https://localhost:5174/ > "$TEMP/index.html" 2>/dev/null; then ready=1; break; fi
 sleep 0.1
done
if [[ "$ready" != 1 ]]; then cat "$TEMP/startup.log"; exit 1; fi
curl -fsS --cacert "$TEMP/tls/ca.crt" -H 'content-type: application/json' -d '{"username":"startup-test","password":"isolated-startup-test-password1"}' https://localhost:5174/api/v1/login > "$TEMP/login.json"
node -e 'const fs=require("fs"); const h=JSON.parse(fs.readFileSync(process.argv[1]));const u=JSON.parse(fs.readFileSync(process.argv[2]));if(h.ok!==true||u.user.username!=="startup-test"||!u.access_token)process.exit(1)' "$TEMP/health.json" "$TEMP/login.json"
grep -q 'control connected; device' "$TEMP/startup.log"
echo 'PASS dev.sh: trusted HTTPS health + actual Rust WSS + Vue HTTPS loopback + authenticated HTTPS proxy'
