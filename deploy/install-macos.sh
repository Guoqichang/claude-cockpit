#!/usr/bin/env bash
# 把 Claude Cockpit 装成 macOS LaunchAgent：开机自启、崩溃自动重启。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.claudecockpit.server
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
NODE="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js 18+" >&2
  exit 1
fi

cd "$ROOT"
if [ ! -d node_modules ]; then
  echo "正在 npm install…"
  "${NPM_BIN:-npm}" install
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# ~/.local/bin 里通常有 claude；PATH 必须带上，否则 Agent 找不到 CLI
PATH_VALUE="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
if [ -n "${PATH:-}" ]; then
  PATH_VALUE="$PATH_VALUE:$PATH"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_VALUE}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/claude-cockpit.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/claude-cockpit.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo
echo "已安装 LaunchAgent：${LABEL}"
echo "打开：  http://127.0.0.1:7799"
echo "状态：  launchctl print gui/\$(id -u)/${LABEL} | grep -E 'state|pid'"
echo "重启：  launchctl kickstart -k gui/\$(id -u)/${LABEL}"
echo "停用：  launchctl bootout gui/\$(id -u)/${LABEL}"
echo "日志：  tail -f ${LOG_DIR}/claude-cockpit.log"
