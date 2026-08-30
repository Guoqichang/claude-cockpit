# Claude Cockpit

Local web cockpit for [Claude Code](https://docs.anthropic.com/en/docs/claude-code): browse sessions, chat in markdown, embed a real terminal, and SSH into another machine.

本地 Web 驾驶舱，接管 Claude Code：session 浏览 + markdown 聊天 + 内嵌真终端 + SSH 远程。也读 Cursor / Hermes 会话。

## 需要什么

- Node.js 18+
- 已安装并可在 `PATH` 里调用的 `claude`（Claude Code CLI）
- macOS 或 Linux（内嵌终端依赖 `node-pty`）

## 快速开始

```bash
git clone https://github.com/Guoqichang/claude-cockpit.git
cd claude-cockpit
npm install
npm start
```

浏览器打开 [http://127.0.0.1:7799](http://127.0.0.1:7799)。本机这个端口默认免认证。

macOS 想开机自启、崩溃自动重启：

```bash
bash deploy/install-macos.sh
```

```bash
launchctl print gui/$(id -u)/com.claudecockpit.server | grep -E 'state|pid'   # 状态
launchctl kickstart -k gui/$(id -u)/com.claudecockpit.server                  # 重启
launchctl bootout   gui/$(id -u)/com.claudecockpit.server                     # 停用
tail -f ~/Library/Logs/claude-cockpit.log                                    # 日志
```

`ProcessType=Interactive` 是为了避免 macOS 对后台任务做定时器节流（尾随读取靠 250ms 轮询）。**别用 `pkill -f "node server.js"` 关服务**——会连带杀掉同名测试实例；按端口 `lsof -ti :7799` 或走 launchctl。

## 功能

| 块 | 入口 | 原理 |
|---|---|---|
| Session 浏览 | 左侧列表 | 扫 `~/.claude/projects/*/`，标题取 JSONL 里的 `ai-title` |
| 续聊 / 新聊 | 点开 session 底部输入框 / ＋新会话 | `claude -p --resume <id> --output-format stream-json` 流式驱动 |
| 本地终端 | 「本地终端」按钮 | node-pty + xterm.js，可直接跑原生 claude TUI |
| SSH 远程 | 「SSH」按钮 | ssh2 密码认证，连上后可跑远程 claude |
| 运行状态灯 | 侧栏绿点 | 解析 `ps` 里的 `--resume=<id>` 判断进程持有 + JSONL mtime 判断是否在写 |
| 置顶 session | 侧栏条目悬停出现图钉 | 顺序存 `~/.claude-cockpit/pins.json`（服务端，跨浏览器一致） |
| 会话重命名 | 侧栏 ✎ / 双击标题 | 自定义名存 `~/.claude-cockpit/names.json`，不改引擎自己的会话文件 |
| 临时换模型 | 输入框打 `@` | `@haiku 问题…` 只对这一条生效；有自动补全 |
| 发图片 | 粘贴 / 拖入 / 回形针 | 走 `--input-format stream-json` 的视觉输入，不走 Read 工具 |

本机配置、密钥、置顶、令牌都在 `~/.claude-cockpit/`（权限 600），**不会进仓库**。

## 会话图谱

侧栏「◍ 会话图谱」把列表换成一张活地图。

- **大小** = 轮数（log）× 新鲜度，**颜色** = 聚类色系，同色靠内嵌小图标认人
- **状态环**：绿脉冲=正在跑、金色虚线=goal、蓝色点线=loop、红环=上轮报错
- **注意力优先**：正在跑 / 报错 / goal / loop / 新鲜度 重排，最该看的落在正中
- **聚类**：标题 + 目录名做 TF-IDF（中文按二元组），过大的目录桶再按时间拆开
- goal / loop 没有专用存储，是从会话尾部扫最近的 `/goal`、`/loop` 还原的

## 第三方模型（MiMo / DeepSeek / GLM …）

Claude Code 可以指向任何 **Anthropic 兼容**网关。「换模型」= 换 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + 模型 id。内置档案在 `lib/providers.js`，key 存在 `~/.claude-cockpit/providers.json`（接口只回传 `hasKey`）：

| 档案 | 网关 | 模型 |
|---|---|---|
| MiMo v2.5 Pro UltraSpeed | `api.xiaomimimo.com/anthropic` | `mimo-v2.5-pro-ultraspeed` |
| DeepSeek v4 Pro | `api.deepseek.com/anthropic` | `deepseek-v4-pro` |
| DeepSeek v4 Flash | 同上 | `deepseek-v4-flash` |

- **必须走 `/anthropic` 路径**，OpenAI 兼容路径会 404。
- **`ANTHROPIC_API_KEY` 要显式置空**，否则它优先于 `ANTHROPIC_AUTH_TOKEN`。
- 同时设 `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`，避免内部切回官方模型名。
- 加新供应商：在 `providers.json` 追加 `{id,label,baseUrl,model,apiKey}`，前端下拉自动出现。
- 智谱 GLM 的强制思考模型需要 `effort: 'high'`（`chat.js` 会追加 `--effort`）。4xx 不会进自动续跑。

## 手机访问（可选）

```
手机 ──HTTPS──> 你的中转机（Caddy 自动证书）
                 │ reverse_proxy 127.0.0.1:9080
                 ▼  反向 SSH 隧道
              本机 127.0.0.1:7788（强制令牌）
```

- **双监听口**：`7799` 本机桌面免认证；`7788` 只给隧道、强制令牌。反向隧道进来的请求在本机同样显示为 `127.0.0.1`，所以不能「本地一律免认证」。
- **令牌**：`~/.claude-cockpit/auth.json`。手机首次用二维码里的 `?t=`，服务端换成 HttpOnly Cookie。
- **配对二维码**：侧栏「▤ 手机访问」，公网地址存 `~/.claude-cockpit/config.json`。该接口只在 7799 上可用。
- **中转一次性配置**：`COCKPIT_DOMAIN=… SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" bash deploy/setup-relay.sh`
- **隧道守护**：`COCKPIT_RELAY_HOST=root@relay.example.com bash deploy/tunnel.sh`（可再包一层 LaunchAgent）
- **通知**：Web Push（VAPID 自签，密钥在 `~/.claude-cockpit/vapid.json`）。必须 HTTPS（localhost 除外）。

Android 壳在 `android/`：`bash android/build.sh [install]`，令牌构建期从本机配置注入，仓库不留密钥。

## 开放 HTTP 接口

其他 Agent（Hermes / 脚本）可以不走浏览器，直接调 `/api/open/*`。用法见 [`skills/claude-cockpit/SKILL.md`](skills/claude-cockpit/SKILL.md)。

```bash
curl -sS http://127.0.0.1:7799/api/open/sessions?limit=20
curl -sS -H 'Content-Type: application/json' \
  -d '{"engine":"claude","prompt":"列出当前目录","wait":true}' \
  http://127.0.0.1:7799/api/open/chat
```

## 抖动自动续跑

连接中断 / 网关抖动 / 电脑睡醒会让一轮半途而废。`lib/chat.js` 只对可恢复错误自动续（最多 2 次，退避 4s → 12s）：

- 可重试：`connection closed/reset`、`socket hang up`、`overloaded`、`502/503/504`、`timed out`、`went to sleep`
- **不重试**：体积超限、quota / credit、401 / 403，以及其它 4xx

关掉：`~/.claude-cockpit/config.json` 里设 `"autoRetry": false`。必须先判定再发 `done`，否则客户端会把这轮拆掉。

## 防睡眠（macOS）

- **自动**：有轮次在跑时持一个 `caffeinate -i -m -s`，全部结束即释放
- **手动**：「运行中」页右上角 ☾ 按钮，或 `GET/POST /api/awake`
- `caffeinate` 挡不住合盖休眠

## 轮次生命周期

聊天轮次是**脱离服务的独立进程**（`spawn(..., {detached:true})`），stream-json 落在 `~/.claude-cockpit/chats/<ch>.out`，服务只做尾随读取 + 广播。

- 关浏览器只断 WebSocket，轮次继续跑；重开页面会自动接管
- 服务被杀 / 重启不影响轮次；新服务 `restoreChats()` 扫盘判活
- 停止 = 对进程组发 SIGTERM（`kill(-pid)`）

每轮是独立的 `claude -p`，跑完即退出。无头模式没有「后台任务完成再唤起模型」——所以 `startChat` 会带 `--append-system-prompt`，要求必须在本轮内交付。想追加自己的规则：写 `~/.claude-cockpit/system-prompt.md`。

## 跨设备同步

两端读写同一批 `~/.claude/projects/*.jsonl`。`/api/active` 额外返回最近改动的 `mtime`，打开中的会话只拉增量；对端正在跑的轮次先补对方输入，再 `chat.attach` 接管实时流。

## 注意事项

- **权限模式**：聊天默认 `acceptEdits`，右上角可切；`bypassPermissions` 等于放开所有工具。
- **SSH 密码保存**：勾「保存该主机」会明文写入 `~/.claude-cockpit/hosts.json`（chmod 600）。
- **node-pty**：`npm install` 后 `spawn-helper` 可能丢可执行位，`postinstall` 会自动 `chmod +x`。
- **流式粒度**：token 级。`--include-partial-messages` 让 CLI 吐 `stream_event`，完整消息到达后丢弃预览、改用权威版本。
- **极小图片不可靠**：256×256 起稳定。
- **续聊分叉**：`--resume` 后以 result 事件返回的 `session_id` 为准。

## 已知边界

- 远程 session 的 markdown 聊天模式（目前远程只有终端 TUI）
- Electron / Tauri 壳（现为纯浏览器）
- 聊天中途的权限交互（headless 下被拒的工具调用直接失败）

## License

[MIT](LICENSE)
