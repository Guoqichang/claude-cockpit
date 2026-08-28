# Claude Cockpit

本地 Web 驾驶舱，接管 Claude Code：session 浏览 + markdown 聊天 + 内嵌真终端 + SSH 远程。

## 启动

服务是**常驻 launchd Agent**（开机自启、崩溃自动重启），平时不用管它。双击 `~/Desktop/Claude Cockpit.app` 只是开窗口（Edge `--app` 无边框模式）；服务没应答时壳会 bootstrap/kickstart 该 Agent，不再自己 spawn node。

```bash
launchctl print gui/$(id -u)/com.looperhome.claude-cockpit | grep -E 'state|pid'   # 状态
launchctl kickstart -k gui/$(id -u)/com.looperhome.claude-cockpit                  # 重启（部署新代码）
launchctl bootout   gui/$(id -u)/com.looperhome.claude-cockpit                     # 停用（含开机自启）
tail -f ~/Library/Logs/claude-cockpit.log                                          # 日志
```

plist 在 `~/Library/LaunchAgents/com.looperhome.claude-cockpit.plist`：`PATH` 里必须含 `~/.local/bin`（`claude` 在那），`ProcessType=Interactive` 防止 macOS 对后台任务做定时器节流（尾随读取靠 250ms 轮询）。

**别用 `pkill -f "node server.js"`** 关服务——会连带杀掉同名的测试实例；按端口 `lsof -ti :7799` 或走 launchctl。

## 四块功能

| 块 | 入口 | 原理 |
|---|---|---|
| Session 浏览 | 左侧列表 | 扫 `~/.claude/projects/*/`，标题取 JSONL 里的 `ai-title` |
| 续聊/新聊 | 点开 session 底部输入框 / ＋新会话 | `claude -p --resume <id> --output-format stream-json` 流式驱动 |
| 本地终端 | 「本地终端」按钮 | node-pty + xterm.js，可直接跑原生 claude TUI |
| SSH 远程 | 「SSH」按钮 | ssh2 密码认证，连上后可跑远程 claude |
| 运行状态灯 | 侧栏绿点 | 解析 `ps` 里的 `--resume=<id>` 判断进程持有 + JSONL mtime 判断是否在写；亮绿脉冲=正在跑，暗绿空心=打开但空闲 |
| 置顶 session | 侧栏条目悬停出现图钉 | 顺序存 `~/.claude-cockpit/pins.json`（服务端，跨浏览器/标签一致）；置顶项聚到顶部「置顶」组，不在原项目组重复出现 |
| 会话重命名 | 侧栏条目 ✎ 按钮 / 双击标题 | 自定义名存 `~/.claude-cockpit/names.json`（600），**不改 Claude/Cursor 自己的会话文件**；在 `session-router.js` 单点收口，两种引擎与推送通知统一生效；留空恢复自动标题，改过的条目带 ✎ 角标、悬停可见原标题 |
| 临时换模型 | 输入框打 `@` | `@haiku 问题…` 只对这一条生效，下拉框的默认模型不动；有自动补全（下拉里的 ID + `opus/sonnet/haiku/fable` 别名），气泡下方标注「本轮使用 X」，排队消息也支持 |
| 发图片 | 输入框粘贴 / 拖入 / 回形针按钮 | 有附件时改用 `--input-format stream-json`，把 `{type:'image',source:{base64}}` 内容块写进 stdin（真视觉输入，不走 Read 工具）；前端超 1568px 长边先 canvas 降采样 |

## 手机端（PWA + 反向隧道）

```
Android ──HTTPS──> quant 38.76.164.215 (Caddy 自动证书)
                     │ reverse_proxy 127.0.0.1:9080
                     ▼  反向 SSH 隧道（Mac 主动外连，launchd 守护）
                  Mac: 127.0.0.1:7788（强制令牌的监听口）
```

- **双监听口**：`7799` 本机桌面用、免认证；`7788` 只给隧道、强制令牌。**不能用「本地免认证」一刀切**——反向隧道进来的请求在 Mac 上同样显示为 127.0.0.1。
- **令牌**：`~/.claude-cockpit/auth.json`（600）。手机首次访问用二维码里的 `?t=` 链接，服务端换成 HttpOnly Cookie；也可在登录页手动粘贴。失败 10 次锁 15 分钟（限速按 `X-Forwarded-For` 计，因为经 Caddy 后源 IP 都是本地）。
- **配对二维码**：侧栏「▤ 手机访问」，公网地址存 `~/.claude-cockpit/config.json`。该接口只在 7799 上可用（7788 访问返回 403）。
- **服务端一次性配置**：`deploy/setup-relay.sh`（装公钥 + 开 sshd PubkeyAuthentication + 加 Caddy 站点，幂等、自动备份）。
- **隧道守护**：`~/Library/LaunchAgents/com.looperhome.cockpit-tunnel.plist` → `deploy/tunnel.sh`，`launchctl kickstart -k gui/$(id -u)/com.looperhome.cockpit-tunnel` 重启，日志 `~/Library/Logs/cockpit-tunnel.log`。
- ⚠️ **僵尸端口死循环**：服务端 sshd 没开 ClientAlive，网络突断会留下占着 9080 的僵尸 sshd 会话；新隧道 bind 失败（`remote port forwarding failed`）→ `ExitOnForwardFailure` 退出 → launchd 重拉 → 无限循环，表现是公网全 000。`tunnel.sh` 每次连接前先按端口清掉占用者，已实测 SIGKILL 后 ~10 秒自愈。
- ⚠️ **验证免密时必须加 `-o ControlPath=none`**：`~/.ssh/config` 开了 ControlMaster + ControlPersist 10m，复用的旧连接会让「免密已通」变成假象。
- **通知**：Web Push（VAPID 自签，密钥在 `~/.claude-cockpit/vapid.json`，订阅在 `push-subs.json`）。轮次结束由 `onChatDone` 触发，推送带标题/耗时/花费，点击深链 `/?session=<slug>/<id>` 直达会话。**必须 HTTPS**（localhost 除外）。

## Android APK（`android/`）

WebView 壳，不用 Gradle：`bash android/build.sh [install]`，走 aapt2 → javac → d8 → zipalign → apksigner，产物 `android/build/cockpit.apk`（约 33KB）。

- **令牌构建期注入**：`build.sh` 从 `~/.claude-cockpit/{auth,config}.json` 读令牌与公网地址写进 `res/values/build.xml`，仓库里不留密钥；首次加载 `?t=` 换成 Cookie 后只存干净 URL。
- **怎么装到手机**：桌面侧栏「▤ 手机访问」弹窗里有两个二维码——①网页/装主屏，②直接下载 APK（链接带令牌，`GET /cockpit.apk` 只在认证入口开放，匿名下载 401）。APK 里嵌着令牌，**不要放到任何匿名可下的地方**。
- **WatchService**：前台服务每 20 秒轮询 `/api/chats`，发现「上次在跑、这次不在了」就发系统通知。**WebView 里没有 Web Push**（`Notification` / `PushManager` 均不存在），所以壳自己做监控；网页端检测到缺 API 会隐藏 🔔 按钮。
- SDK 装在 `/opt/homebrew/share/android-commandlinetools`（不是 `~/Library/Android/sdk`），`build.sh` 会自动探测两处。
- 签名用 `android/debug.keystore`（自动生成，口令 cockpit），仅供自己侧载。

## 两类"看起来坏了"的病（已修）

- **中文乱码**：尾随读取按文件当前大小切块，切点落在汉字（3 字节）中间的概率 2/3，旧 `toString()` 每个切点产生一对 `�`——实测 300 个切点 200 个坏。修法 `StringDecoder`（残字节留到下一块）。凡是"分块读 UTF-8 再拼接"的地方都要用它，教训通用。
- **僵尸转圈**（`运行中 16056s`）：服务端早已结束，前端错过了 done 消息（服务重启窗口等）。双保险：前端 spinner 每 60 秒和 `/api/chats` 核对，不在 running 里就自动收尾并拉真实结果；服务端 30 分钟无输出增长判定挂死，杀进程组并解锁 UI（`COCKPIT_STALL_MS` 可调）。

## 抖动自动续跑

连接中断/网关抖动/电脑睡醒会让一轮半途而废。`lib/chat.js` 在轮次结束时判定错误性质，**只对可恢复的**自动续：

- 可重试：`connection closed/reset`、`socket hang up`、`overloaded`、`502/503/504`、`timed out`、`went to sleep`
- **不重试**（重试也没用，只会烧钱）：`maximum request body size`、各种 limit/quota/credit、401/403
- 最多 2 次，退避 4s → 12s；续跑发的是「从中断处继续、别重复」的提示词，靠 `--resume` 带上下文
- 续跑跑在**新频道**上，客户端通过 `chat.retried` 跟随；手机没开也照常自动续，因为判定在服务端
- 关掉：`~/.claude-cockpit/config.json` 里设 `"autoRetry": false`

**顺序有坑**：必须先判定再决定发不发 `done`。先发 `done` 的话客户端会把这轮拆掉，随后的重试通知就无处可挂（踩过）。同理 `subscribe()` 对 `retryPending` 的轮次不能补发 `done`。

## 防睡眠

这台机器电池模式 `sleep 1`（闲置 1 分钟整机睡眠），长轮次必被打断，报 `Your computer went to sleep mid-response`。

- **自动**：`lib/awake.js` 在有轮次运行时持一个 `caffeinate -i -m -s`，全部结束即释放（`setBusy` 由 chat 的启动/结束/恢复三处驱动）。
- **手动**：「运行中」页右上角 ☾ 按钮，选小时数（≤12），到点自动释放；接口 `GET/POST /api/awake`。
- **命令行**（VSCode / 终端里跑长任务时）：`caffeinate -ims -t 14400`（4 小时），或 `caffeinate -ims -w <pid>` 跟着某个进程。
- ⚠️ **合盖照睡**：`caffeinate` 挡不住合盖休眠。合盖还要跑就得接电源 + 外接显示器，或改 `pmset` 策略。

## 第三方模型（MiMo / DeepSeek …）

Claude Code 本体可以指向任何 **Anthropic 兼容**网关，所以「换模型」= 换 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + 模型 id。已内置三个档案（`lib/providers.js`），key 存在 `~/.claude-cockpit/providers.json`（600，不进仓库，接口只回传 `hasKey` 不回传明文）：

| 档案 | 网关 | 模型 |
|---|---|---|
| MiMo v2.5 Pro UltraSpeed | `api.xiaomimimo.com/anthropic` | `mimo-v2.5-pro-ultraspeed` |
| DeepSeek v4 Pro | `api.deepseek.com/anthropic` | `deepseek-v4-pro` |
| DeepSeek v4 Flash | 同上 | `deepseek-v4-flash` |

要点：

- **必须走 `/anthropic` 路径**，两家的 OpenAI 兼容路径（`/v1/messages`）会 404。
- **`ANTHROPIC_API_KEY` 要显式置空**，否则它优先于 `ANTHROPIC_AUTH_TOKEN`，会打回官方端点。
- 同时设 `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`，避免 Claude Code 内部按用途切回官方模型名。
- 加新供应商：编辑 `providers.json` 追加 `{id,label,baseUrl,model,apiKey}` 即可，前端下拉自动出现。
- **GLM（智谱 `open.bigmodel.cn/api/anthropic`）**：`glm-5` 可用（骐畅个人 key）；`glm-5.3` 是**强制思考**模型——不带思考参数直接 400(1210)，`MAX_THINKING_TOKENS` 环境变量传不进请求，唯一有效的是 **`--effort` 旗标**（providers 里配 `effort: 'high'`，chat.js 自动追加）。当前个人 key 报 403(1220) 无权访问、公司 key 429 欠费——配置已就绪，账号开通即用。
- **重试判定坑**：4xx（参数/权限错）绝不能进自动续跑，重试只会原样再错——glm-5.3 的 400 曾把一次测试拖成 6 分钟重试循环。

## 单轮语义（为什么会「说好了给我结果，然后没下文」）

每轮是独立的 `claude -p` 进程，跑完即退出。交互式 Claude Code 里后台任务完成会重新唤起模型，**无头模式没有这个机制**——所以模型一旦按交互式习惯说「我先放后台跑，好了给你」，那个「好了」永远不会到来，用户只看到一段没有下文的话。

修法：`startChat` 每轮带 `--append-system-prompt`，明确告诉模型本轮是一次性进程、没有后续唤醒，需要等待的工作必须在本轮内前台等完再交付；实在超时就交付半成品并写清用户下一步发什么。实测：诱导「后台跑 18 秒再报」的提示词，模型改为等 33.5 秒、`Bash` + `Read` 后把产物内容一并给出。

想追加自己的全局规则：写 `~/.claude-cockpit/system-prompt.md`，会拼在内置规则后面。

## 跨设备同步（手机 ↔ PC）

两端读写同一批 `~/.claude/projects/*.jsonl`，但**前端一度只在打开时读一次**，所以对端写入看不到。现在的机制：

- `/api/active` 额外返回 `changed: {sessionId: mtimeMs}`（10 分钟窗口，纯 `stat` 很便宜），客户端每 4 秒轮询。
- 打开中的会话若 mtime 变了 → `syncSession()` 只拉增量：比较服务端 `total` 与本地水位 `v.total`，把多出来的几条 append，不重渲染整个对话。
- 对端**正在跑**的轮次 → 先 `syncSession()` 补上对方输入的那条 prompt，再 `chat.attach {fresh:true}` 接管实时流。**顺序不能反**：fresh 只给后续事件，先接管就会永远丢掉对方的用户消息（实测踩过）。
- 本页自己发的轮次流式渲染完，从服务端重置水位 `v.total`，避免同步机制把刚渲染过的内容再 append 一遍。
- 侧栏在 `changed` 出现新 mtime 时整体刷新，新会话/新标题/条数自动出现。

## 轮次生命周期（关键架构）

聊天轮次是**脱离服务的独立进程**（`spawn(..., {detached:true, stdio:['pipe', outFd, errFd]})`），stream-json 落在 `~/.claude-cockpit/chats/<ch>.out`，服务只做尾随读取（250ms 轮询）+ 广播。由此：

- 关浏览器/关窗口 → 只断 WebSocket 订阅，轮次继续跑；重开页面点进该 session 会**自动接管**仍在跑的轮次（`/api/chats` 按 sessionId 匹配，`chat.attach {fresh:true}` 只要后续事件，历史从 JSONL 读）
- 服务被杀/重启 → 轮次不受影响；新服务启动时 `restoreChats()` 扫 `chats/*.json`，用 `kill(pid,0)` 判活，把 `.out` 重放进缓冲并继续尾随
- 服务进程**不再**在退出时杀子轮次（早期版本会），且忽略 SIGHUP
- 停止 = 对脱离进程的**进程组**发 SIGTERM（`kill(-pid)`），连它拉起的工具子进程一起收

## 注意事项

- **权限模式**：聊天默认 `acceptEdits`，右上角可切；`bypassPermissions` 等于放开所有工具，慎用。
- **SSH 密码保存**：勾「保存该主机」会明文写入 `~/.claude-cockpit/hosts.json`（chmod 600），不勾则只在内存里。
- **node-pty**：`npm install` 后 `spawn-helper` 会丢可执行位（报 `posix_spawnp failed`），postinstall 脚本已自动 `chmod +x` 修复。
- **流式粒度**：token 级。`--include-partial-messages` 让 CLI 吐 `stream_event`（`content_block_delta` 逐字、`message_delta` 带 usage），前端据此做**实时预览**：正文/思考逐字显示、状态行滚动显示 `● 模型 · 正在用 Bash · 12s · 285 tok`。完整消息到达时预览被丢弃、改用权威版本重渲染，所以不会重影。
  - 工具名要**撑到结果回来**才清：工具真正执行发生在 `message_stop` 之后，在那里清掉的话「正在用 X」几乎看不见（踩过）。
- **极小图片不可靠**：实测 64×64 的纯色 PNG 有时模型报告「看不到图片」（同一张图换目录跑结果不同），256×256 起稳定。截图正常尺寸不受影响，但别拿几十像素的图测试。
- **续聊分叉**：`--resume` 后以 result 事件返回的 `session_id` 为准，前端已自动跟踪。

## 已知边界（未做）

- 远程 session 的 markdown 聊天模式（目前远程只有终端 TUI）
- Electron / Tauri 壳（现为纯浏览器）
- 聊天中途的权限交互（headless 模式下被拒的工具调用直接失败）
