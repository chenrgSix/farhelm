#!/usr/bin/env bash
# Disposable systemd integration fixture, never a deployment image.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
name=farhelm-native-test-$$
image=farhelm-native-test:$$
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "$root"
docker build -t "$image" -f tests/deployment/Dockerfile.systemd tests/deployment
docker run -d --name "$name" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  --mount "type=bind,source=$root,target=/source,readonly" \
  -p 127.0.0.1::8443 -p 127.0.0.1::2222 "$image" >/dev/null
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$name" systemctl list-units >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name" shellcheck /source/install.sh
docker exec "$name" bash /source/install.sh --source /source --host 127.0.0.1
FARHELM_TEST_NATIVE_CONTAINER="$name" node tests/deployment/compose.mjs
before=$(docker exec "$name" systemctl show farhelm --property=MainPID --value)
docker exec "$name" bash /source/install.sh --source /source --host 127.0.0.1
after=$(docker exec "$name" systemctl show farhelm --property=MainPID --value)
[[ "$before" == "$after" ]]
docker exec "$name" sh -c 'test ! -d /opt/farhelm/current/apps/web/node_modules && test ! -d /opt/farhelm/current/.npm-cache'
printf 'PASS: repeated native installation preserved the running service; build dependencies/cache were removed\n'
