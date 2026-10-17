#!/usr/bin/env bash
# Linux + systemd installer. The platform runs as farhelm, never as root.
set -Eeuo pipefail
umask 077
fail() { printf 'Farhelm: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: bash install.sh [--host DOMAIN_OR_IP] [--web-port 8443] [--ssh-port 2222]
                       [--ssh-only-http] [--source DIRECTORY] [--ref main]
                       [--token-file FILE]
Downloads the source and a checksum-verified private Node.js runtime, builds both
server and web, and enables farhelm.service. Debian 12+/Ubuntu 22.04+ or a modern
glibc Linux with systemd, x86_64/ARM64. Existing completed installations are kept.
For this private repository, use an authenticated gh CLI, GH_TOKEN, or token file.
EOF
}
public_host=""; web_port=8443; ssh_port=2222; source_dir=""; ref=main; token_file=""; device_access=agent-ssh; protocol=https
while (($#)); do
  case "$1" in
    --host|--web-port|--ssh-port|--source|--ref|--token-file)
      (($# >= 2)) || fail "Missing value for $1"
      case "$1" in
        --host) public_host=$2;; --web-port) web_port=$2;; --ssh-port) ssh_port=$2;;
        --source) source_dir=$2;; --ref) ref=$2;; --token-file) token_file=$2;;
      esac; shift 2;;
    --ssh-only-http) device_access=ssh-only; protocol=http; shift;;
    --help|-h) usage; exit 0;;
    *) fail "Unknown option: $1";;
  esac
done
[[ $(uname -s) == Linux ]] || fail "The native installer needs Linux; use Docker Compose on other systems."
[[ $ref =~ ^[a-zA-Z0-9._/-]+$ && $ref != *..* ]] || fail "Invalid source ref"
[[ $web_port =~ ^[1-9][0-9]{0,4}$ && $ssh_port =~ ^[1-9][0-9]{0,4}$ ]] || fail "Invalid port"
((web_port <= 65535 && ssh_port <= 65535 && web_port != ssh_port && web_port != 8080 && ssh_port != 8080)) || fail "Ports must differ and cannot use the internal ACME port 8080"
[[ -z $public_host || $public_host =~ ^[a-zA-Z0-9.:-]+$ ]] || fail "Use an ASCII domain or IP, without scheme, port or path"
if [[ -n $source_dir ]]; then source_dir=$(cd "$source_dir" && pwd -P); fi
if [[ -n $token_file ]]; then token_file=$(cd "$(dirname "$token_file")" && pwd -P)/$(basename "$token_file"); fi
# Obtain authentication before sudo, since the user's gh session is not root's.
auth=${GH_TOKEN:-${GITHUB_TOKEN:-}}
if [[ -z $auth && -z $token_file && -z $source_dir ]] && command -v gh >/dev/null; then auth=$(gh auth token 2>/dev/null || true); fi
if ((EUID != 0)); then
  command -v sudo >/dev/null || fail "Run with root or install sudo"
  private_token=$(mktemp)
  trap 'rm -f "$private_token"' EXIT
  if [[ -n $token_file ]]; then cat "$token_file" > "$private_token"; else printf '%s' "$auth" > "$private_token"; fi
  args=(--host "$public_host" --web-port "$web_port" --ssh-port "$ssh_port" --ref "$ref" --token-file "$private_token")
  [[ -z $source_dir ]] || args+=(--source "$source_dir")
  [[ $protocol == https ]] || args+=(--ssh-only-http)
  sudo bash "$0" "${args[@]}"
  exit $?
fi
[[ -d /run/systemd/system ]] || fail "A running systemd is required; use Docker Compose for containers."
command -v systemctl >/dev/null || fail "systemctl is required"
if ! command -v curl >/dev/null || ! command -v xz >/dev/null || ! command -v runuser >/dev/null || ! command -v flock >/dev/null || ! command -v useradd >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils tar util-linux passwd
  elif command -v dnf >/dev/null; then
    dnf install -y ca-certificates curl xz tar util-linux shadow-utils
  else fail "Install ca-certificates, curl, xz, tar, coreutils, util-linux and shadow-utils first"; fi
fi
exec 9>/run/lock/farhelm-install.lock
flock -n 9 || fail "Another Farhelm installer is running"
prefix=/opt/farhelm; data=/var/lib/farhelm; config=/etc/farhelm/server.env
if [[ -f $prefix/installed ]]; then
  printf 'Farhelm is already installed. Configuration and data were preserved.\nUse systemctl status farhelm; read initial credentials with sudo cat %s/bootstrap-admin.json\n' "$data"
  exit 0
fi
[[ ! -e $prefix || -f $prefix/installer-owned ]] || fail "$prefix already exists and is not owned by this installer"
[[ ! -e $config ]] || fail "$config already exists; refusing to overwrite it"
[[ ! -e /etc/systemd/system/farhelm.service ]] || fail "farhelm.service already exists; refusing to overwrite it"
[[ ! -d $data || -f $data/installation.json || -z $(ls -A "$data") ]] || fail "$data contains existing data; use its existing deployment"
[[ ! -e $prefix/current ]] || fail "An unfinished installation exists in $prefix/current; inspect it before retrying"
case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail "Only Linux x86_64 and ARM64 are supported";; esac
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail "Native Node.js needs glibc; use Docker Compose on Alpine/musl"
work=$(mktemp -d /tmp/farhelm-install.XXXXXXXX); stage=""
cleanup() { rm -rf -- "$work"; if [[ -n $stage ]]; then rm -rf -- "$stage"; fi; }
trap cleanup EXIT
trap 'printf "Installation did not complete. Existing data was kept. Check the error above.\n" >&2' ERR
if [[ -n $token_file ]]; then auth=$(cat "$token_file"); fi
[[ -z $auth || $auth =~ ^[A-Za-z0-9_]+$ ]] || fail "Invalid GitHub token format"
if [[ -n $auth ]]; then printf 'header = "Authorization: Bearer %s"\n' "$auth" > "$work/github.conf"; else : > "$work/github.conf"; fi
unset auth GH_TOKEN GITHUB_TOKEN
fetch() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 600 --proto '=https' --proto-redir '=https' "$@"; }
if [[ -z $source_dir ]]; then
  printf 'Downloading Farhelm source (%s)...\n' "$ref"
  fetch --config "$work/github.conf" "https://api.github.com/repos/chenrgSix/farhelm/tarball/$ref" -o "$work/source.tar.gz" || fail "Source download failed. This repository is private; authenticate gh or supply --token-file."
  mkdir "$work/source"
  tar -xzf "$work/source.tar.gz" --strip-components=1 -C "$work/source"
  source_dir=$work/source
fi
[[ -f $source_dir/deploy/server/bootstrap.mjs && -f $source_dir/apps/web/package-lock.json && -f $source_dir/apps/server/package-lock.json ]] || fail "Source does not contain the server installer; use main or a release that includes it"
install -d -m 755 "$prefix"
touch "$prefix/installer-owned"
node_version=24.21.0
node_archive=node-v${node_version}-linux-${arch}.tar.xz
if [[ ! -x $prefix/runtime/bin/node ]]; then
  printf 'Downloading Node.js %s (%s)...\n' "$node_version" "$arch"
  fetch "https://nodejs.org/dist/v${node_version}/$node_archive" -o "$work/$node_archive"
  fetch "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  (cd "$work"; awk -v f="$node_archive" '$2 == f {print}' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
  mkdir "$work/runtime"
  tar -xJf "$work/$node_archive" --strip-components=1 -C "$work/runtime"
  mv "$work/runtime" "$prefix/runtime"
  chmod -R a+rX "$prefix/runtime"
fi
node=$prefix/runtime/bin/node
"$node" -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)' || fail "This OS cannot run Node.js 24; check glibc support"
if [[ -z $public_host ]]; then public_host=$(hostname -I 2>/dev/null | awk '{print $1}'); public_host=${public_host:-localhost}; fi
# Check input and listener conflicts before touching the persistent database.
"$node" --input-type=module - "$public_host" "$web_port" "$ssh_port" <<'JS'
import { isIP, createServer } from 'node:net';
const [host, ...ports] = process.argv.slice(2);
if (!isIP(host) && !host.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p))) throw Error('Invalid public host');
for (const port of [...ports, '8080']) {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(Number(port), '0.0.0.0', resolve));
  await new Promise(resolve => server.close(resolve));
}
JS
if ! getent passwd farhelm >/dev/null; then
  getent group farhelm >/dev/null || groupadd --system farhelm
  useradd --system --gid farhelm --home-dir "$data" --no-create-home --shell /usr/sbin/nologin farhelm
fi
[[ $(id -u farhelm) != 0 ]] || fail "farhelm must be an unprivileged account"
service_group=$(id -gn farhelm)
stage=$(mktemp -d "$prefix/.build.XXXXXXXX")
chmod 755 "$stage"
mkdir -p "$stage/apps" "$stage/deploy/server"
# Copy only application inputs; never copy .dev, databases, credentials or caches.
(cd "$source_dir"; tar --exclude=node_modules --exclude=dist --exclude=.DS_Store --exclude='.env*' -cf - apps/server apps/web lib) | (cd "$stage"; tar -xf -)
cp "$source_dir/deploy/server/bootstrap.mjs" "$source_dir/deploy/server/healthcheck.mjs" "$stage/deploy/server/"
chown -R farhelm:"$service_group" "$stage"
printf 'Building server and web as the farhelm service account...\n'
# The inner shell expands its own $1 after privilege drop.
# shellcheck disable=SC2016
runuser -u farhelm -- env PATH="$prefix/runtime/bin:/usr/bin:/bin" HOME="$stage" npm_config_cache="$stage/.npm-cache" bash -c '
  set -e
  cd "$1"
  npm --prefix apps/server ci --ignore-scripts --omit=optional --no-audit --no-fund
  npm --prefix apps/web ci --no-audit --no-fund
  npm --prefix apps/server run build
  npm --prefix apps/web run build
  npm --prefix apps/server prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
' _ "$stage"
rm -rf "$stage/apps/web/node_modules" "$stage/.npm-cache" "$stage/.npm"
chown -R root:root "$stage"
chmod -R a+rX "$stage"
install -d -o farhelm -g "$service_group" -m 700 "$data"
runuser -u farhelm -- env FLEET_DATA_DIR="$data" FARHELM_PUBLIC_HOST="$public_host" FARHELM_PUBLIC_PORT="$web_port" FLEET_DEVICE_ACCESS="$device_access" FLEET_WEB_PROTOCOL="$protocol" "$node" "$stage/deploy/server/bootstrap.mjs" --init-only
mv "$stage" "$prefix/current"; stage=""
install -d -m 700 /etc/farhelm
cat > "$config" <<EOF
FLEET_HOST=0.0.0.0
FLEET_PORT=$web_port
FLEET_DEVICE_ACCESS=$device_access
FLEET_WEB_ENABLED=1
FLEET_WEB_PROTOCOL=$protocol
FLEET_DATA_DIR=$data
FLEET_WEB_DIST=$prefix/current/apps/web/dist
FLEET_AGENT_DIST_DIR=$data/agent-dist
FLEET_SSH_HOST=0.0.0.0
FLEET_SSH_PORT=$ssh_port
FLEET_SSH_PUBLIC_HOST=$public_host
FLEET_SSH_PUBLIC_PORT=$ssh_port
FLEET_ACME_ENABLED=1
FLEET_ACME_HTTP_HOST=0.0.0.0
FLEET_ACME_HTTP_PORT=8080
FARHELM_PUBLIC_HOST=$public_host
FARHELM_PUBLIC_PORT=$web_port
EOF
cat > /etc/systemd/system/farhelm.service <<EOF
[Unit]
Description=Farhelm platform and web console
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=farhelm
Group=$service_group
WorkingDirectory=$prefix/current
EnvironmentFile=$config
ExecStart=$node $prefix/current/deploy/server/bootstrap.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$data
EOF
if ((web_port < 1024 || ssh_port < 1024)); then
  printf 'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' >> /etc/systemd/system/farhelm.service
fi
printf '\n[Install]\nWantedBy=multi-user.target\n' >> /etc/systemd/system/farhelm.service
chmod 600 "$config"
chmod 644 /etc/systemd/system/farhelm.service
systemctl daemon-reload
systemctl enable --now farhelm.service
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if runuser -u farhelm -- env FLEET_DATA_DIR="$data" FLEET_PORT="$web_port" "$node" "$prefix/current/deploy/server/healthcheck.mjs"; then ready=1; break; fi
  sleep 1
done
((ready)) || fail "Service health check failed. Inspect: journalctl -u farhelm. Data and configuration were kept."
touch "$prefix/installed"
printf '\nFarhelm installed; boot startup enabled.\nWeb entry: %s://%s:%s\nSSH gateway port: %s\nInitial credentials: sudo cat %s/bootstrap-admin.json\nConfiguration: %s\n' "$protocol" "$public_host" "$web_port" "$ssh_port" "$data" "$config"
[[ $protocol != https ]] || printf 'CA public certificate: %s/ca.crt (trust once on your administrator computer).\n' "$data"
