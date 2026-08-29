#!/bin/bash
# Runs inside WSL Ubuntu-24.04. One long-lived process so the VM cannot idle-stop.
# Do not spawn extra wsl.exe from Windows SYSTEM — that kills systemd's dbus.
set -u
HB=/mnt/c/ProgramData/pcy02/wsl-heartbeat.txt
IPF=/mnt/c/ProgramData/pcy02/wsl-ip.txt
NEED=/mnt/c/ProgramData/pcy02/wsl-need-restart.txt
LOG=/mnt/c/ProgramData/pcy02/cockpit-loop.log

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }

write_ip() {
  ip=$(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 | tr -d '\r\n')
  if [ -n "${ip:-}" ]; then
    printf '%s' "$ip" > "$IPF"
  fi
}

write_hb() { printf '%s' "$(date +%s)" > "$HB"; }

rm -f "$NEED"
write_ip
write_hb
log "loop start ip=$(cat "$IPF" 2>/dev/null || true)"

if ! sudo systemctl start claude-cockpit; then
  log 'systemctl start failed (dbus?)'
  printf 'dbus' > "$NEED"
  exit 42
fi

fail=0
while true; do
  write_ip
  write_hb
  listening=0
  if ss -ltn 2>/dev/null | grep -q ':7799'; then
    listening=1
  fi
  if [ "$listening" -ne 1 ]; then
    fail=$((fail + 1))
    log "7799 down fail=$fail"
    if ! sudo systemctl start claude-cockpit; then
      log 'systemctl start failed inside loop'
      printf 'dbus' > "$NEED"
      exit 42
    fi
    if [ "$fail" -ge 5 ]; then
      log '7799 still down after retries'
      printf 'down' > "$NEED"
      exit 43
    fi
  else
    fail=0
  fi
  sleep 20
done
