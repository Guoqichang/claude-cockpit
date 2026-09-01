# Claude Cockpit

本地 Web 驾驶舱：把 [OpenCode](https://opencode.ai)、[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、Cursor Agent、Hermes 的会话收进同一个页面——列表、续聊、真终端、会话图谱。

**最小路径不是「先装一堆 CLI」。** 先让 OpenCode 跑通：一个安装脚本 + 一把 API Key。Cockpit 能聊了，再按需接 Claude / Cursor / Hermes。

## 傻瓜安装（推荐）

### macOS / Linux / WSL

终端里一行：

```bash
curl -fsSL https://raw.githubusercontent.com/Guoqichang/claude-cockpit/master/deploy/install.sh | bash
```

脚本会：克隆仓库 → `npm install` → 装 OpenCode → 登记开机自启 → 打开 [http://127.0.0.1:7799/#setup](http://127.0.0.1:7799/#setup)。

已有仓库时，在仓库根目录跑 `bash deploy/install.sh` 即可。

### Windows（原生，不是 WSL）

用 **PowerShell**（不要用 cmd）：

```powershell
irm https://raw.githubusercontent.com/Guoqichang/claude-cockpit/master/deploy/install.ps1 | iex
```

脚本会：必要时用 winget 装 Node → 克隆仓库 → `npm install` → 装 OpenCode → 登记「登录时启动」的计划任务 `ClaudeCockpit` → 打开同一个向导页。

已经在用 WSL Ubuntu 的人：进 Linux 子系统后跑上面的 `install.sh`，不要混用两套。

需要的环境：

- Node.js 18+（Windows 脚本可代劳）
- 能上网（拉仓库、装 OpenCode、调模型 API）
- Python 3 可选：没有也能先聊；导入磁盘上已有的 OpenCode 会话时才需要

## 向导里做什么

浏览器打开后按四步走，不要跳去翻配置文件。

1. **看这台电脑缺什么**  
   绿点 = 已就绪。OpenCode 二进制和 API Key 是唯一的硬条件。
2. **装 OpenCode**  
   没有才出现按钮。也可以自己在终端跑官方命令：  
   - macOS / Linux：`curl -fsSL https://opencode.ai/install | bash`  
   - Windows：`irm https://opencode.ai/install | iex`
3. **贴一把 API Key**  
   推荐 [DeepSeek 官方](https://platform.deepseek.com/api_keys)。新建一把，整段贴进向导。Key 只写到你电脑上的：
   - macOS / Linux：`~/.config/opencode/opencode.json`
   - Windows：`%USERPROFILE%\.config\opencode\opencode.json`  
   **不会进 git，也不会出现在页面回复里。**
4. **开一条 OpenCode**  
   向导会拉起本机 `opencode serve`（默认 `127.0.0.1:7801`），并新建 reverse 会话。之后点左侧 **＋ OpenCode** 就是同一条飞轮。

Claude / Cursor / Hermes 是加餐：有 CLI 或本地数据就会出现在侧栏，没有也不挡先聊。

侧栏按钮 **◎** 随时可以再打开向导（换 Key、补装 OpenCode）。

## 手动启动（不走一键脚本时）

```bash
git clone https://github.com/Guoqichang/claude-cockpit.git
cd claude-cockpit
npm install
npm start
```

浏览器打开 [http://127.0.0.1:7799](http://127.0.0.1:7799)。本机这个端口默认免认证。

### 自启

| 系统 | 命令 |
|---|---|
| macOS | `bash deploy/install-macos.sh` |
| Linux | `bash deploy/install.sh`（写 systemd --user） |
| Windows | `powershell -ExecutionPolicy Bypass -File deploy\install.ps1` |

macOS 常用：

```bash
launchctl print gui/$(id -u)/com.claudecockpit.server | grep -E 'state|pid'   # 状态
launchctl kickstart -k gui/$(id -u)/com.claudecockpit.server                  # 重启
launchctl bootout   gui/$(id -u)/com.claudecockpit.server                     # 停用
tail -f ~/Library/Logs/claude-cockpit.log                                    # 日志
```

`ProcessType=Interactive` 是为了避免 macOS 对后台任务做定时器节流。**别用 `pkill -f "node server.js"` 关服务**——会连带杀掉同名测试实例；按端口或走 launchctl / 计划任务。

Windows 停用自启：

```powershell
Unregister-ScheduledTask -TaskName ClaudeCockpit -Confirm:$false
```

日志在启动终端里，或计划任务拉起的 `cmd` 窗口。

## 功能

| 块 | 入口 | 原理 |
|---|---|---|
| Session 浏览 | 左侧列表 | Claude 扫 `~/.claude/projects/*/`；Cursor / Hermes / OpenCode 走各自存储 |
| 续聊 / 新聊 | 点开 session 底部输入框 / ＋按钮 | Claude/Cursor：CLI stream-json；OpenCode：`opencode serve` + SSE |
| OpenCode TUI | reverse agent | 黑底流式、Thought、MCP/Todo 侧栏、底栏 tokens |
| 本地终端 | 「本地终端」按钮 | node-pty + xterm.js（Windows 开 PowerShell） |
| SSH 远程 | 「SSH」按钮 | ssh2 密码认证 |
| 运行状态灯 | 侧栏绿点 | 进程命令行里的 `--resume=` + 会话文件 mtime |
| 置顶 session | 侧栏条目悬停出现图钉 | 顺序存 `~/.claude-cockpit/pins.json` |
| 会话重命名 | 侧栏 ✎ / 双击标题 | 自定义名存 `~/.claude-cockpit/names.json` |
| 临时换模型 | 输入框打 `@` | `@haiku 问题…` 只对这一条生效 |
| 发图片 | 粘贴 / 拖入 / 回形针 | Claude 视觉输入 |

本机配置、密钥、置顶、令牌都在 `~/.claude-cockpit/`（权限 600），**不会进仓库**。OpenCode 的 Key 在 `~/.config/opencode/`。

## Windows 路径对照

OpenCode 在 Windows 上仍然用「用户主目录下的点目录」，不是 `%APPDATA%`：

| 东西 | 位置 |
|---|---|
| 配置 | `%USERPROFILE%\.config\opencode\opencode.json` |
| 会话库 | `%USERPROFILE%\.local\share\opencode\opencode.db` |
| 二进制 | `%USERPROFILE%\.opencode\bin\opencode.exe` |
| Cockpit 自己的状态 | `%USERPROFILE%\.claude-cockpit\` |

内嵌终端默认 PowerShell。若 `npm install` 编 `node-pty` 失败，先装 [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 的「Desktop development with C++」，再在仓库里重跑 `npm install`。没有内嵌终端时，聊天（OpenCode / Claude）仍可用。

## 会话图谱

侧栏「◍ 会话图谱」把列表换成一张活地图。

- **大小** = 轮数（log）× 新鲜度，**颜色** = 聚类色系，同色靠内嵌小图标认人
- **状态环**：绿脉冲=正在跑、金色虚线=goal、蓝色点线=loop、红环=上轮报错
- **注意力优先**：正在跑 / 报错 / goal / loop / 新鲜度 重排，最该看的落在正中
- **聚类**：标题 + 目录名做 TF-IDF（中文按二元组），过大的目录桶再按时间拆开

## 第三方模型（MiMo / DeepSeek / GLM …）走 Claude Code 时

Claude Code 可以指向任何 **Anthropic 兼容**网关。「换模型」= 换 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + 模型 id。内置档案在 `lib/providers.js`，key 存在 `~/.claude-cockpit/providers.json`（接口只回传 `hasKey`）：

| 档案 | 网关 | 模型 |
|---|---|---|
| MiMo v2.5 Pro UltraSpeed | `api.xiaomimimo.com/anthropic` | `mimo-v2.5-pro-ultraspeed` |
| DeepSeek v4 Pro | `api.deepseek.com/anthropic` | `deepseek-v4-pro` |
| DeepSeek v4 Flash | 同上 | `deepseek-v4-flash` |

- **必须走 `/anthropic` 路径**，OpenAI 兼容路径会 404。
- **`ANTHROPIC_API_KEY` 要显式置空**，否则它优先于 `ANTHROPIC_AUTH_TOKEN`。
- OpenCode 自己走 OpenAI 兼容路径（`https://api.deepseek.com/v1`），和上面这套 Claude 网关不是同一条。

## 手机访问（可选）

```
手机 ──HTTPS──> 你的中转机（Caddy 自动证书）
                 │ reverse_proxy 127.0.0.1:9080
                 ▼  反向 SSH 隧道
              本机 127.0.0.1:7788（强制令牌）
```

- **双监听口**：`7799` 本机桌面免认证；`7788` 只给隧道、强制令牌。
- **令牌**：`~/.claude-cockpit/auth.json`。手机首次用二维码里的 `?t=`，服务端换成 HttpOnly Cookie。
- **配对二维码**：侧栏「▤ 手机访问」。该接口只在 7799 上可用。
- **中转一次性配置**：`COCKPIT_DOMAIN=… SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" bash deploy/setup-relay.sh`
- **隧道守护**：`COCKPIT_RELAY_HOST=root@relay.example.com bash deploy/tunnel.sh`

Android 壳在 `android/`：`bash android/build.sh [install]`，令牌构建期从本机配置注入，仓库不留密钥。

## 开放 HTTP 接口

其他 Agent（Hermes / 脚本）可以不走浏览器，直接调 `/api/open/*`。用法见 [`skills/claude-cockpit/SKILL.md`](skills/claude-cockpit/SKILL.md)。

```bash
curl -sS http://127.0.0.1:7799/api/open/sessions?limit=20
curl -sS -H 'Content-Type: application/json' \
  -d '{"engine":"opencode","prompt":"列出当前目录","wait":true}' \
  http://127.0.0.1:7799/api/open/chat
```

## 抖动自动续跑

连接中断 / 网关抖动 / 电脑睡醒会让一轮半途而废。`lib/chat.js` 只对可恢复错误自动续（最多 2 次，退避 4s → 12s）。**OpenCode 轮次不自动 retry**（serve 自己管流）。

关掉：`~/.claude-cockpit/config.json` 里设 `"autoRetry": false`。

## 防睡眠（macOS）

- **自动**：有轮次在跑时持一个 `caffeinate -i -m -s`，全部结束即释放
- **手动**：「运行中」页右上角 ☾ 按钮，或 `GET/POST /api/awake`
- Windows / Linux 没有等价实现，笔记本请自己关休眠

## 轮次生命周期

Claude / Cursor 聊天轮次是**脱离服务的独立进程**，stream-json 落在 `~/.claude-cockpit/chats/<ch>.out`。OpenCode 轮次走 `opencode serve` 的 HTTP/SSE，停一轮会调 `/session/{id}/abort`。

- 关浏览器只断 WebSocket，轮次继续跑；重开页面会自动接管
- 服务被杀 / 重启不影响已在跑的 Claude 轮次；新服务 `restoreChats()` 扫盘判活

想追加自己的规则：写 `~/.claude-cockpit/system-prompt.md`（作用于 Claude 无头轮次）。

## 注意事项

- **权限模式**：Claude 聊天默认 `acceptEdits`，右上角可切；`bypassPermissions` 等于放开所有工具。
- **SSH 密码保存**：勾「保存该主机」会明文写入 `~/.claude-cockpit/hosts.json`（chmod 600）。
- **node-pty**：Unix 上 `postinstall` 会给 `spawn-helper` 加可执行位；Windows 跳过 chmod。
- **部署向导**：`/api/setup/*` 只在本机 7799 可用，隧道口 7788 会拒绝，避免从公网改 Key。

## 已知边界

- 远程 session 的 markdown 聊天模式（目前远程只有终端 TUI）
- Electron / Tauri 壳（现为纯浏览器）
- 聊天中途的权限交互（headless 下被拒的工具调用直接失败）
- Windows 上 `wmic` 已逐渐弃用；侧栏「进程持有」指示在部分新系统上可能不准，不影响聊天

## License

[MIT](LICENSE)
