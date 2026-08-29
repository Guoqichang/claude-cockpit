#!/usr/bin/env bash
# Run inside WSL as root (or sudo). Installs cockpit deps + systemd unit.
set -euo pipefail
USER=looper
HOME=/home/$USER
APP=$HOME/claude-cockpit

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends xz-utils ca-certificates curl git

cd "$APP"
if [[ ! -d node_modules ]]; then
  npm config set registry https://registry.npmmirror.com
  npm install --omit=dev
  chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
fi

install -m 644 "$APP/deploy/pcy02-cockpit.service" /etc/systemd/system/claude-cockpit.service
systemctl daemon-reload
systemctl enable --now claude-cockpit.service
systemctl --no-pager --full status claude-cockpit.service || true
echo COCKPIT_UNIT_OK
