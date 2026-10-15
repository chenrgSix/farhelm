#!/usr/bin/env bash
set -euo pipefail
umask 077
# INSTALL_CONFIGURATION
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || die '仅支持 Linux。'
[[ "$(id -u)" == 0 ]] || die '安装需要 root 或 sudo 权限。Agent 将以指定的普通账号运行。'
for tool in curl sha256sum base64 getent runuser install nohup flock; do
  command -v "$tool" >/dev/null || die "缺少依赖：$tool。请先通过系统包管理器安装。"
done
install -d /run/lock
exec 9>/run/lock/farhelm-agent-install.lock
flock -n 9 || die '另一个 Agent 安装正在进行，请等待完成。'
machine=$(uname -m)
case "$machine" in
  x86_64) expected_sha=$sha_x86_64 ;;
  aarch64|arm64) machine=aarch64; expected_sha=$sha_aarch64 ;;
  *) die "不支持的 CPU 架构：$machine" ;;
esac
[[ -n "$expected_sha" ]] || die "平台未提供 $machine 安装包，请联系平台管理员。"
if [[ "$start_mode" == auto ]]; then
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then start_mode=systemd; else start_mode=background; fi
fi
if [[ "$start_mode" == systemd ]]; then
  [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null || die 'systemd 未运行。请在表单选择自动或后台运行，再生成命令。'
fi
for path in /etc/farhelm-agent /var/lib/farhelm-agent /usr/local/bin/farhelm-agent /usr/local/libexec/farhelm-agent-background /etc/systemd/system/farhelm-agent.service; do
  [[ ! -e "$path" && ! -L "$path" ]] || die "检测到已有安装：$path。已停止，不会覆盖配置、身份或创建重复设备。"
done
if id "$run_user" >/dev/null 2>&1; then
  [[ "$(id -u "$run_user")" != 0 ]] || die 'Agent 运行账号不能是 UID 0。'
else
  command -v useradd >/dev/null || die '缺少 useradd，无法创建 Agent 账号。'
fi
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
printf %s "$ca_b64" | base64 -d > "$t/ca.crt"
printf 'Authorization: Bearer %s\n' "$enrollment_token" > "$t/auth"
curl_args=(--fail --silent --show-error --proto '=https' --connect-timeout 10 --max-time 120 --header "@$t/auth")
[[ -z "$ca_b64" ]] || curl_args+=(--cacert "$t/ca.crt")
printf '正在下载 Linux %s Agent…\n' "$machine"
curl "${curl_args[@]}" --max-filesize 67108864 "$server/api/agent/packages/$machine" -o "$t/agent"
printf '%s  %s\n' "$expected_sha" "$t/agent" | sha256sum -c - >/dev/null || die '安装包校验失败，未安装。'
# Validate the package before writing host configuration or creating an account.
if ! id "$run_user" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "/var/lib/$run_user" --shell /bin/bash "$run_user"
fi
group=$(id -gn "$run_user")
home_dir=$(getent passwd "$run_user" | cut -d: -f6)
[[ -d "$home_dir" ]] || die '运行账号的 HOME 目录不存在，请先创建。'
install -d -m 700 /etc/farhelm-agent
install -d -m 700 -o "$run_user" -g "$group" /var/lib/farhelm-agent
install -d -m 755 /usr/local/bin /usr/local/libexec
install -m 755 "$t/agent" /usr/local/bin/farhelm-agent
printf %s "$env_b64" | base64 -d > /etc/farhelm-agent/agent.env
chmod 600 /etc/farhelm-agent/agent.env
if [[ -n "$ca_b64" ]]; then
  # The account needs to read the CA. Only the public CA is copied into its private state directory.
  install -m 600 -o "$run_user" -g "$group" "$t/ca.crt" /var/lib/farhelm-agent/ca.crt
  sed -i 's|/etc/farhelm-agent/ca.crt|/var/lib/farhelm-agent/ca.crt|' /etc/farhelm-agent/agent.env
fi
if [[ "$start_mode" == systemd ]]; then
  cat > /etc/systemd/system/farhelm-agent.service <<EOF
[Unit]
Description=Farhelm Agent
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=$run_user
Group=$group
EnvironmentFile=/etc/farhelm-agent/agent.env
ExecStart=/usr/local/bin/farhelm-agent
WorkingDirectory=/var/lib/farhelm-agent
Restart=on-failure
RestartSec=5
UMask=0077
KillMode=mixed
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
EOF
  chmod 644 /etc/systemd/system/farhelm-agent.service
  systemctl daemon-reload
  systemctl enable --now farhelm-agent.service
  printf '已启动 systemd 服务，并启用开机启动。\n'
else
  # Run this launcher as root; it drops privileges before executing the Agent.
  cat > /usr/local/libexec/farhelm-agent-background <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
source /etc/farhelm-agent/agent.env
set +a
exec runuser -u '$run_user' -- /usr/local/bin/farhelm-agent
EOF
  chmod 700 /usr/local/libexec/farhelm-agent-background
  install -m 600 /dev/null /var/log/farhelm-agent.log
  nohup env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME="$home_dir" LANG=C.UTF-8 /usr/local/libexec/farhelm-agent-background </dev/null >/var/log/farhelm-agent.log 2>&1 9>&- &
  printf '%s\n' "$!" > /etc/farhelm-agent/background.pid
  printf '已后台启动；当前环境没有开机启动保障。日志：/var/log/farhelm-agent.log\n'
fi
printf '等待设备注册并连接平台…\n'
for ((i=0; i<60; i++)); do
  if curl "${curl_args[@]}" --max-time 5 "$server/api/agent/install-status" -o "$t/status" && grep -Eq '"status"[[:space:]]*:[[:space:]]*"online"' "$t/status"; then
    sed -i '/^FLEET_ENROLLMENT_TOKEN=/d' /etc/farhelm-agent/agent.env
    printf '安装完成，设备已注册并在线。运行账号：%s。可返回控制台连接终端。\n' "$run_user"
    exit 0
  fi
  sleep 1
done
if [[ "$start_mode" == systemd ]]; then
  die '服务已安装，但尚未确认在线。请用 journalctl -u farhelm-agent 检查日志；修复网络或证书后重启服务，无需重新安装。'
else
  die 'Agent 已安装，但尚未确认在线。请检查 /var/log/farhelm-agent.log；修复后以 root 运行 nohup /usr/local/libexec/farhelm-agent-background >/var/log/farhelm-agent.log 2>&1 &，无需重新安装。'
fi
