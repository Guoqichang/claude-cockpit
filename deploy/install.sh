#!/usr/bin/env bash
# 一键装 Claude Cockpit：克隆仓库、npm install、装 OpenCode、登记自启，然后打开部署向导填 Key。
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Guoqichang/claude-cockpit.git}"
OPEN_URL="http://127.0.0.1:7799/#setup"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "找不到 $1。$2"
}

script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$script_dir" ] && [ -f "$script_dir/../server.js" ]; then
  ROOT="$(cd "$script_dir/.." && pwd)"
else
  ROOT="${COCKPIT_DIR:-$HOME/claude-cockpit}"
  need git "macOS：xcode-select --install ；Linux：装 git。"
  if [ ! -f "$ROOT/server.js" ]; then
    say "正在克隆 $REPO_URL → $ROOT"
    git clone "$REPO_URL" "$ROOT"
  else
    say "已有 $ROOT，尝试 git pull"
    git -C "$ROOT" pull --ff-only || true
  fi
fi

need node "请先装 Node.js 18+：https://nodejs.org/"
major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$major" -lt 18 ]; then
  die "Node.js 版本是 $(node -v)，需要 18+"
fi
need npm "npm 应随 Node 一起出现。"

cd "$ROOT"
if [ ! -d node_modules ]; then
  say "正在 npm install…"
  npm install
else
  say "node_modules 已在，跳过 npm install（要重装请自己跑 npm install）"
fi

if ! command -v opencode >/dev/null 2>&1 && [ ! -x "$HOME/.opencode/bin/opencode" ]; then
  say "正在安装 OpenCode（官方脚本）…"
  curl -fsSL https://opencode.ai/install | bash
else
  say "OpenCode 已在 PATH 或 ~/.opencode/bin"
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  say "提示：没找到 Python 3。先聊不受影响；导入已有 OpenCode 会话时再装。"
fi

os="$(uname -s)"
case "$os" in
  Darwin)
    say "登记 macOS LaunchAgent…"
    bash "$ROOT/deploy/install-macos.sh"
    ;;
  Linux)
    unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    node_bin="$(command -v node)"
    cat > "$unit_dir/claude-cockpit.service" <<EOF
[Unit]
Description=Claude Cockpit
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$node_bin $ROOT/server.js
Restart=on-failure
RestartSec=3
Environment=HOME=$HOME
Environment=PATH=$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable --now claude-cockpit.service
      say "已启用 systemd --user：claude-cockpit.service"
    else
      say "这台 Linux 没有可用的 systemd --user。下面用 nohup 拉起一次。"
      mkdir -p "$HOME/.claude-cockpit"
      if ! (command -v lsof >/dev/null && lsof -nP -iTCP:7799 -sTCP:LISTEN >/dev/null 2>&1); then
        nohup "$node_bin" "$ROOT/server.js" >"$HOME/.claude-cockpit/cockpit.log" 2>&1 &
        say "已后台启动，日志 $HOME/.claude-cockpit/cockpit.log"
      fi
    fi
    ;;
  *)
    say "未识别的系统 $os，直接 npm start 即可。"
    ;;
esac

sleep 1
if command -v open >/dev/null 2>&1; then
  open "$OPEN_URL" || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$OPEN_URL" || true
fi

say
say "打开浏览器： $OPEN_URL"
say "在向导里贴一把 DeepSeek（或其它）API Key，再点「开一条 OpenCode」。"
say "仓库：$ROOT"
