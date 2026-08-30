#!/usr/bin/env bash
# Claude Cockpit 手机中转 · 服务端一次性配置
#
# 在中转机器上执行，或从本机推过去：
#   COCKPIT_DOMAIN=cockpit.example.com \
#   SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" \
#   ssh root@relay.example.com 'bash -s' < deploy/setup-relay.sh
#
# 干三件事，全部幂等、改前自动备份：
#   1. 把本机公钥装进 authorized_keys
#   2. 打开 sshd 的 PubkeyAuthentication（保留密码认证，不锁自己）
#   3. Caddy 加一个站点 $COCKPIT_DOMAIN → 127.0.0.1:9080（隧道出口）
set -uo pipefail

COCKPIT_DOMAIN="${COCKPIT_DOMAIN:?请设置 COCKPIT_DOMAIN，例如 cockpit.example.com}"
if [ -n "${SSH_PUBKEY:-}" ]; then
  PUBKEY="$SSH_PUBKEY"
elif [ -f "${HOME}/.ssh/id_ed25519.pub" ]; then
  PUBKEY="$(cat "${HOME}/.ssh/id_ed25519.pub")"
else
  echo "请设置 SSH_PUBKEY，或准备好 ~/.ssh/id_ed25519.pub" >&2
  exit 1
fi
CADDYFILE="${CADDYFILE:-/root/caddy/Caddyfile}"
RELAY_PORT="${COCKPIT_RELAY_PORT:-9080}"

echo "=== 1. 安装公钥 ==="
mkdir -p /root/.ssh && chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
if grep -qF "$PUBKEY" /root/.ssh/authorized_keys; then
  echo "公钥已存在，跳过"
else
  echo "$PUBKEY" >> /root/.ssh/authorized_keys
  echo "公钥已追加"
fi

echo "=== 2. 开启 PubkeyAuthentication（密码认证保持不变）==="
if sshd -T 2>/dev/null | grep -q '^pubkeyauthentication yes'; then
  echo "已经是 yes，跳过"
else
  BAK=/root/sshd_config.bak.$(date +%s)
  cp /etc/ssh/sshd_config "$BAK"
  echo "已备份到 $BAK"
  sed -i 's/^[[:space:]]*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
  grep -q '^PubkeyAuthentication yes' /etc/ssh/sshd_config || echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -e "$f" ] || continue
    sed -i 's/^[[:space:]]*PubkeyAuthentication.*/PubkeyAuthentication yes/' "$f"
  done
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload
    echo "sshd 已 reload"
  else
    echo "!! sshd -t 校验失败 —— 回滚"
    cp "$BAK" /etc/ssh/sshd_config
  fi
fi
echo "--- 当前生效 ---"
sshd -T 2>/dev/null | grep -E '^(pubkeyauthentication|passwordauthentication)'

echo "=== 3. Caddy 站点 ==="
if [ ! -f "$CADDYFILE" ]; then echo "!! 找不到 $CADDYFILE，跳过"; exit 1; fi
cp "$CADDYFILE" "${CADDYFILE}.bak.$(date +%s)"
if grep -q "$COCKPIT_DOMAIN" "$CADDYFILE"; then
  echo "站点已存在，跳过"
else
  printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$COCKPIT_DOMAIN" "$RELAY_PORT" >> "$CADDYFILE"
  echo "站点已追加"
fi
if [ -x /root/caddy/caddy ]; then
  /root/caddy/caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -3
  /root/caddy/caddy reload --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -3
elif command -v caddy >/dev/null 2>&1; then
  caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -3
  caddy reload --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -3
fi

echo "=== 完成 ==="
tail -5 "$CADDYFILE"
