---
name: claude-cockpit
description: "调用本机 Claude Cockpit：列出/阅读 Claude Code、Cursor、Hermes 会话，并发起一轮对话。当用户要在 Cockpit 里开/续 Claude 或 Cursor 会话、查看驾驶舱里的对话、或把结果写回 Cockpit 时使用。"
---

# Claude Cockpit

通过 Cockpit 的开放 HTTP 接口查看会话并发一轮对话。不要用浏览器去点。

## 地址与鉴权

按顺序选一个能通的：

| 从哪里调 | Base URL | 令牌 |
|---|---|---|
| 本机 → 本机 Cockpit | `http://127.0.0.1:7799` | 默认不需要 |
| 其他机器 → 开了鉴权的 Cockpit | 你的 `COCKPIT_URL` | `Authorization: Bearer` |

环境变量优先：`COCKPIT_URL`、`COCKPIT_TOKEN`。本机令牌也可从 `~/.claude-cockpit/auth.json` 读。

```bash
URL="${COCKPIT_URL:-http://127.0.0.1:7799}"
TOK="${COCKPIT_TOKEN:-}"
if [ -z "$TOK" ] && [ -f "$HOME/.claude-cockpit/auth.json" ]; then
  TOK=$(python3 -c "import json; print(json.load(open('$HOME/.claude-cockpit/auth.json')).get('token',''))")
fi
H=()
[ -n "$TOK" ] && H=(-H "Authorization: Bearer $TOK")
```

## 列会话

```bash
curl -sS "${H[@]}" "$URL/api/open/sessions?limit=40"
# 可选 ?engine=claude|cursor|hermes  和  ?q=关键词
```

返回数组：`engine, slug, id, title, cwd, mtimeMs, msgCount`。

## 读会话

```bash
curl -sS "${H[@]}" "$URL/api/open/session/<slug>/<id>?limit=40"
```

`slug` 原样使用（Claude 是项目 slug，Cursor 是 `cursor:…`，Hermes 是 `hermes:telegram` / `hermes:cli`）。

## 发起一轮

```bash
curl -sS "${H[@]}" -H 'Content-Type: application/json' \
  -d '{"engine":"claude","prompt":"……","wait":true,"timeoutMs":180000}' \
  "$URL/api/open/chat"
```

| 字段 | 说明 |
|---|---|
| `engine` | `claude`（默认）/ `cursor` / `hermes` |
| `prompt` | 本轮用户话（必填） |
| `resume` / `sessionId` | 续聊已有会话 |
| `cwd` | 新 Claude/Cursor 会话的工作目录 |
| `model` | 可选 |
| `wait` | 默认 `true`，等本轮结束再返回 `{sessionId, text, code}` |
| `timeoutMs` | 默认 180000 |

不要 `wait:false` 除非你接着轮询 `GET /api/open/chats`。

停一轮：`POST /api/open/chat/<ch>/stop`。

## 用法

- 用户说「在 Cockpit 里用 Claude 做某事」→ `engine=claude`，需要续旧会话就先 `?q=` 搜再带 `resume`。
- 用户说「看一下驾驶舱里那个会话」→ `open/sessions` + `open/session`。
- 不要把密钥写进 prompt。把结果用一两段话回给用户，并带上 `sessionId`。
