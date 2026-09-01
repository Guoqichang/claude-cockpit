#!/usr/bin/env python3
"""Read OpenCode's SQLite session store (~/.local/share/opencode/opencode.db)."""
import json
import os
import sqlite3
import sys

DB = os.environ.get("OPENCODE_DB") or os.path.expanduser(
    "~/.local/share/opencode/opencode.db"
)


def connect():
    if not os.path.exists(DB):
        raise SystemExit("no-db")
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=8)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=5000")
    return con


def jloads(v, default=None):
    if v is None or v == "":
        return default
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return default


def ts_ms(v):
    if v is None:
        return 0
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0
    return int(n * 1000) if n < 1e12 else int(n)


def parse_model(raw):
    obj = jloads(raw, None)
    if isinstance(obj, dict):
        mid = obj.get("id") or obj.get("modelID") or ""
        pid = obj.get("providerID") or obj.get("provider") or ""
        return {"id": mid, "providerID": pid}
    if isinstance(raw, str) and raw.strip():
        return {"id": raw.strip(), "providerID": ""}
    return {"id": "", "providerID": ""}


def group_of(agent, title):
    a = (agent or "").strip() or "opencode"
    if a == "reverse" and str(title or "").startswith("tool-eval"):
        return "eval"
    return a


def session_row(r, msg_count=None):
    model = parse_model(r["model"])
    title = r["title"] or r["id"]
    agent = r["agent"] or ""
    tokens_in = int(r["tokens_input"] or 0)
    tokens_out = int(r["tokens_output"] or 0)
    return {
        "id": r["id"],
        "agent": agent,
        "group": group_of(agent, title),
        "title": title,
        "cwd": r["directory"] or "",
        "model": model.get("id") or "",
        "provider": model.get("providerID") or "",
        "mtimeMs": ts_ms(r["time_updated"] or r["time_created"]),
        "msgCount": int(msg_count if msg_count is not None else 0),
        "cost": float(r["cost"] or 0),
        "tokensInput": tokens_in,
        "tokensOutput": tokens_out,
        "tokensReasoning": int(r["tokens_reasoning"] or 0),
        "version": r["version"] or "",
    }


def list_sessions():
    con = connect()
    counts = {
        r["session_id"]: r["n"]
        for r in con.execute(
            "SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id"
        )
    }
    rows = con.execute(
        """
        SELECT id, project_id, slug, directory, title, version, cost,
               tokens_input, tokens_output, tokens_reasoning, agent, model,
               time_created, time_updated, time_archived
        FROM session
        WHERE time_archived IS NULL
        ORDER BY COALESCE(time_updated, time_created) DESC
        LIMIT 400
        """
    ).fetchall()
    out = [session_row(r, counts.get(r["id"], 0)) for r in rows]
    print(json.dumps(out, ensure_ascii=False))


def thought_ms(part):
    tm = part.get("time") or {}
    start, end = tm.get("start"), tm.get("end")
    if start and end and end >= start:
        return int(end - start)
    return None


def part_blocks(part):
    t = part.get("type")
    if t == "reasoning":
        text = str(part.get("text") or "")
        if not text.strip():
            return []
        return [{"type": "oc_thought", "text": text, "durationMs": thought_ms(part)}]
    if t == "tool":
        st = part.get("state") or {}
        inp = st.get("input") if isinstance(st.get("input"), dict) else {}
        out = st.get("output") or ""
        if not isinstance(out, str):
            out = json.dumps(out, ensure_ascii=False)
        err = st.get("error")
        if err and not isinstance(err, str):
            err = json.dumps(err, ensure_ascii=False)
        cmd = inp.get("command") or inp.get("cmd") or ""
        return [{
            "type": "oc_tool",
            "id": part.get("id") or part.get("callID") or "",
            "name": part.get("tool") or "tool",
            "title": st.get("title") or part.get("tool") or "tool",
            "command": cmd,
            "input": inp,
            "output": out[:80000],
            "status": st.get("status") or "",
            "error": err or "",
            "durationMs": thought_ms({"time": st.get("time") or {}}),
        }]
    if t == "text":
        text = str(part.get("text") or "")
        if not text.strip():
            return []
        return [{"type": "text", "text": text}]
    if t == "compaction":
        return [{"type": "oc_note", "text": "上下文已压缩"}]
    return []


def read_session(sid, end=None, limit=200):
    con = connect()
    s = con.execute("SELECT * FROM session WHERE id = ?", (sid,)).fetchone()
    if not s:
        raise SystemExit("not-found")
    msgs = con.execute(
        """
        SELECT id, time_created, data
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC, id ASC
        """,
        (sid,),
    ).fetchall()
    parts_by_msg = {}
    for p in con.execute(
        """
        SELECT message_id, data
        FROM part
        WHERE session_id = ?
        ORDER BY time_created ASC, id ASC
        """,
        (sid,),
    ):
        parts_by_msg.setdefault(p["message_id"], []).append(jloads(p["data"], {}))

    messages = []
    for m in msgs:
        info = jloads(m["data"], {}) or {}
        role = (info.get("role") or "").lower()
        if role in ("system",):
            continue
        blocks = []
        for part in parts_by_msg.get(m["id"], []):
            if not isinstance(part, dict):
                continue
            blocks.extend(part_blocks(part))
        if role == "assistant":
            created = ((info.get("time") or {}).get("created"))
            completed = ((info.get("time") or {}).get("completed"))
            dur = None
            if created and completed and completed >= created:
                dur = int(completed - created)
            agent = info.get("agent") or info.get("mode") or s["agent"] or ""
            mid = info.get("modelID") or parse_model(s["model"]).get("id")
            pid = info.get("providerID") or parse_model(s["model"]).get("providerID")
            if blocks:
                blocks.append({
                    "type": "oc_footer",
                    "agent": agent,
                    "model": mid or "",
                    "provider": pid or "",
                    "durationMs": dur,
                    "cost": info.get("cost"),
                })
        if not blocks:
            continue
        out_role = "assistant" if role in ("assistant", "model") else "user"
        messages.append({
            "role": out_role,
            "blocks": blocks,
            "timestamp": ts_ms(m["time_created"]),
        })

    total = len(messages)
    to = total if end is None else min(int(end), total)
    frm = max(0, to - int(limit))
    meta = session_row(s, total)
    todos = [
        {
            "content": t["content"] or "",
            "status": t["status"] or "pending",
            "priority": t["priority"] or "medium",
            "position": t["position"] if t["position"] is not None else 0,
        }
        for t in con.execute(
            """
            SELECT content, status, priority, position
            FROM todo WHERE session_id = ?
            ORDER BY COALESCE(position, 0) ASC, time_created ASC
            """,
            (sid,),
        )
    ]
    print(json.dumps({
        "id": sid,
        "slug": "opencode:" + meta["group"],
        "engine": "opencode",
        "cwd": meta["cwd"],
        "title": meta["title"],
        "model": meta["model"],
        "provider": meta["provider"],
        "agent": meta["agent"],
        "cost": meta["cost"],
        "tokensInput": meta["tokensInput"],
        "tokensOutput": meta["tokensOutput"],
        "tokensReasoning": meta["tokensReasoning"],
        "version": meta["version"],
        "todos": todos,
        "total": total,
        "start": frm,
        "messages": messages[frm:to],
        "bytes": 0,
    }, ensure_ascii=False))


def find_meta(sid):
    con = connect()
    s = con.execute(
        "SELECT * FROM session WHERE id = ? AND time_archived IS NULL",
        (sid,),
    ).fetchone()
    if not s:
        raise SystemExit("not-found")
    n = con.execute(
        "SELECT COUNT(*) AS n FROM message WHERE session_id = ?", (sid,)
    ).fetchone()["n"]
    meta = session_row(s, n)
    meta["slug"] = "opencode:" + meta["group"]
    meta["engine"] = "opencode"
    print(json.dumps(meta, ensure_ascii=False))


def snippet_around(text, q, radius=42):
    raw = " ".join(str(text or "").split())
    if not raw:
        return ""
    i = raw.lower().find(q.lower())
    if i < 0:
        return raw[:80]
    start = max(0, i - radius)
    end = min(len(raw), i + len(q) + radius)
    return ("…" if start else "") + raw[start:end] + ("…" if end < len(raw) else "")


def part_text(raw):
    d = jloads(raw, None)
    if not isinstance(d, dict):
        return str(raw or "")
    t = d.get("type")
    if t in ("text", "reasoning"):
        return str(d.get("text") or "")
    if t == "tool":
        st = d.get("state") or {}
        bits = [d.get("tool") or "", st.get("title") or ""]
        inp = st.get("input")
        if isinstance(inp, dict):
            bits.append(inp.get("command") or "")
            bits.append(json.dumps(inp, ensure_ascii=False)[:400])
        out = st.get("output")
        if isinstance(out, str):
            bits.append(out[:2000])
        return " ".join(b for b in bits if b)
    return str(d.get("text") or "")


def search(q, limit=50):
    q = (q or "").strip()[:80]
    if not q:
        print("[]")
        return
    con = connect()
    like = "%" + q.replace("%", "").replace("_", "") + "%"
    rows = con.execute(
        """
        SELECT p.session_id, p.data, s.title, s.agent, s.directory
        FROM part p
        JOIN session s ON s.id = p.session_id
        WHERE s.time_archived IS NULL
          AND p.data LIKE ?
        ORDER BY p.time_updated DESC
        LIMIT ?
        """,
        (like, limit * 6),
    ).fetchall()
    seen = {}
    ql = q.lower()
    for r in rows:
        sid = r["session_id"]
        if sid in seen:
            continue
        text = part_text(r["data"])
        if ql not in text.lower() and ql not in (r["title"] or "").lower():
            text = str(r["data"] or "")
            if ql not in text.lower():
                continue
        group = group_of(r["agent"], r["title"])
        seen[sid] = {
            "id": sid,
            "slug": "opencode:" + group,
            "engine": "opencode",
            "title": r["title"] or sid,
            "snippet": snippet_around(text, q),
        }
        if len(seen) >= limit:
            break
    if len(seen) < limit:
        for r in con.execute(
            """
            SELECT id, title, agent FROM session
            WHERE time_archived IS NULL AND title LIKE ?
            ORDER BY time_updated DESC LIMIT ?
            """,
            (like, limit),
        ):
            if r["id"] in seen:
                continue
            group = group_of(r["agent"], r["title"])
            seen[r["id"]] = {
                "id": r["id"],
                "slug": "opencode:" + group,
                "engine": "opencode",
                "title": r["title"] or r["id"],
                "snippet": snippet_around(r["title"] or "", q),
            }
            if len(seen) >= limit:
                break
    print(json.dumps(list(seen.values()), ensure_ascii=False))


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
    elif cmd == "search":
        q = sys.argv[2] if len(sys.argv) > 2 else ""
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        search(q, limit)
    else:
        raise SystemExit("bad-cmd")


if __name__ == "__main__":
    main()
