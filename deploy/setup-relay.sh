#!/usr/bin/env bash
# Claude Cockpit 手机中转 · 服务端一次性配置（在 quant 38.76.164.215 上执行）
#
# 用法（在 Mac 上跑，输一次密码）：
#   ssh root@38.76.164.215 'bash -s' < ~/projects/claude-cockpit/deploy/setup-relay.sh
#
# 干三件事，全部幂等、改前自动备份：
#   1. 把本机公钥装进 authorized_keys
#   2. 打开 sshd 的 PubkeyAuthentication（保留密码认证，不锁自己）
#   3. Caddy 加一个站点 cockpit.verdictfinance.top → 127.0.0.1:9080（隧道出口）
set -uo pipefail

PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIESxUfKjGlo4MEV8SREZm+4LwKe8Baji+zeqtkZpB+eL looperhome@macbook-air'

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
CF=/root/caddy/Caddyfile
if [ ! -f "$CF" ]; then echo "!! 找不到 $CF，跳过"; exit 1; fi
cp "$CF" "/root/caddy/Caddyfile.bak.$(date +%s)"
if grep -q 'cockpit.verdictfinance.top' "$CF"; then
  echo "站点已存在，跳过"
else
  printf '\ncockpit.verdictfinance.top {\n\treverse_proxy 127.0.0.1:9080\n}\n' >> "$CF"
  echo "站点已追加"
fi
/root/caddy/caddy validate --config "$CF" --adapter caddyfile 2>&1 | tail -3
/root/caddy/caddy reload --config "$CF" --adapter caddyfile 2>&1 | tail -3

echo "=== 完成 ==="
tail -5 "$CF"
