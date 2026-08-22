#!/usr/bin/env bash
# Cockpit 反向隧道：quant:9080 → 本机 7788（强制令牌的监听口）
#
# 由 ~/Library/LaunchAgents/com.looperhome.cockpit-tunnel.plist 拉起，退出即重启。
#
# 为什么不是直接 exec ssh：服务端 sshd 默认没开 ClientAlive，网络突然断开时
# 旧会话会变僵尸并一直占着 9080，新隧道 bind 失败 → ExitOnForwardFailure 退出
# → launchd 重拉 → 死循环。所以每次连之前先清掉占用者。
set -uo pipefail
HOST="root@38.76.164.215"
RPORT=9080
LPORT=7788
SSH_OPTS=(-o BatchMode=yes -o ControlPath=none -o IPQoS=none
          -o ExitOnForwardFailure=yes -o ServerAliveInterval=30
          -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new
          -o ConnectTimeout=15)

# 清理僵尸转发：只杀持有该端口的 sshd，不动其他会话
ssh "${SSH_OPTS[@]}" "$HOST" \
  "PIDS=\$(ss -tlnpH 'sport = :$RPORT' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); \
   [ -n \"\$PIDS\" ] && kill \$PIDS 2>/dev/null && sleep 1; exit 0" 2>/dev/null

exec ssh -N -T "${SSH_OPTS[@]}" -R "127.0.0.1:$RPORT:127.0.0.1:$LPORT" "$HOST"
