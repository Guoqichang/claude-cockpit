#!/usr/bin/env python3
"""Read Hermes Agent's SQLite session store (~/.hermes/state.db)."""
import json
import os
import sqlite3
import sys

HOME = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
DB = os.path.join(HOME, "state.db")


def connect():
    if not os.path.exists(DB):
        raise SystemExit("no-db")
    uri = f"file:{DB}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def ts_ms(v):
    if v is None:
        return 0
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0
    return int(n * 1000) if n < 1e12 else int(n)


def jloads(v, default=None):
    if v is None or v == "":
        return default
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return default


def session_row(r):
    return {
        "id": r["id"],
        "source": r["source"] or "cli",
        "title": r["title"] or r["display_name"] or r["id"],
        "cwd": r["cwd"] or "",
        "model": r["model"] or "",
        "mtimeMs": ts_ms(r["last_activity_at"] or r["started_at"]),
        "msgCount": int(r["message_count"] or 0),
        "pinned": bool(r["pinned"]),
        "archived": bool(r["archived"]),
    }


def list_sessions():
    con = connect()
    rows = con.execute(
        """
        SELECT id, source, title, display_name, cwd, model,
               last_activity_at, started_at, message_count, pinned, archived, hidden
        FROM sessions
        WHERE COALESCE(hidden, 0) = 0 AND COALESCE(archived, 0) = 0
        ORDER BY COALESCE(last_activity_at, started_at) DESC
        LIMIT 400
        """
    ).fetchall()
    print(json.dumps([session_row(r) for r in rows], ensure_ascii=False))


def content_text(raw):
    if raw is None:
        return ""
    if isinstance(raw, str):
        parsed = jloads(raw, raw)
        raw = parsed
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        parts = []
        for b in raw:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict):
                parts.append(b.get("text") or b.get("content") or "")
        return "\n".join(p for p in parts if p)
    if isinstance(raw, dict):
        return raw.get("text") or raw.get("content") or json.dumps(raw, ensure_ascii=False)
    return str(raw)


def normalize_message(r):
    role = (r["role"] or "").lower()
    if role in ("system",):
        return None
    if role == "tool":
        role = "assistant"
        blocks = [{
            "type": "tool_result",
            "tool_use_id": r["tool_call_id"] or "",
            "text": content_text(r["content"]),
            "is_error": False,
        }]
        return {"role": "user" if False else "assistant", "blocks": blocks,
                "timestamp": ts_ms(r["timestamp"]) or None}

    blocks = []
    thinking = r["reasoning_content"] or r["reasoning"]
    if thinking and str(thinking).strip():
        blocks.append({"type": "thinking", "text": str(thinking).strip()})

    calls = jloads(r["tool_calls"], None)
    if isinstance(calls, list):
        for c in calls:
            if not isinstance(c, dict):
                continue
            fn = c.get("function") or {}
            name = c.get("name") or fn.get("name") or "tool"
            args = c.get("arguments") or fn.get("arguments") or c.get("input") or {}
            if isinstance(args, str):
                args = jloads(args, {"raw": args})
            blocks.append({
                "type": "tool_use",
                "id": c.get("id") or "",
                "name": name,
                "input": args if isinstance(args, dict) else {"value": args},
            })

    if role == "tool":
        text = content_text(r["content"])
        blocks.append({
            "type": "tool_result",
            "tool_use_id": r["tool_call_id"] or "",
            "text": text,
            "is_error": False,
        })
        return {"role": "assistant", "blocks": blocks, "timestamp": ts_ms(r["timestamp"]) or None}

    text = content_text(r["content"])
    if text.strip():
        blocks.append({"type": "text", "text": text})
    if not blocks:
        return None
    out_role = "assistant" if role in ("assistant", "model", "hermes") else "user"
    return {"role": out_role, "blocks": blocks, "timestamp": ts_ms(r["timestamp"]) or None}


def read_session(sid, end=None, limit=200):
    con = connect()
    s = con.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    if not s:
        raise SystemExit("not-found")
    rows = con.execute(
        """
        SELECT role, content, tool_call_id, tool_calls, tool_name,
               timestamp, reasoning, reasoning_content
        FROM messages
        WHERE session_id = ? AND COALESCE(active, 1) = 1
        ORDER BY id ASC
        """,
        (sid,),
    ).fetchall()
    messages = []
    for r in rows:
        m = normalize_message(r)
        if m:
            messages.append(m)
    total = len(messages)
    to = total if end is None else min(int(end), total)
    frm = max(0, to - int(limit))
    meta = session_row(s)
    print(json.dumps({
        "id": sid,
        "slug": "hermes:" + (meta["source"] or "cli"),
        "engine": "hermes",
        "cwd": meta["cwd"],
        "title": meta["title"],
        "model": meta["model"],
        "total": total,
        "start": frm,
        "messages": messages[frm:to],
        "bytes": 0,
    }, ensure_ascii=False))


def find_meta(sid):
    con = connect()
    s = con.execute(
        "SELECT * FROM sessions WHERE id = ? AND COALESCE(hidden,0)=0",
        (sid,),
    ).fetchone()
    if not s:
        raise SystemExit("not-found")
    meta = session_row(s)
    meta["slug"] = "hermes:" + (meta["source"] or "cli")
    meta["engine"] = "hermes"
    print(json.dumps(meta, ensure_ascii=False))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        list_sessions()
    elif cmd == "read":
        sid = sys.argv[2]
        end = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != "" else None
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 200
        read_session(sid, end, limit)
    elif cmd == "meta":
        find_meta(sys.argv[2])
    else:
        raise SystemExit("bad-cmd")


if __name__ == "__main__":
    main()
