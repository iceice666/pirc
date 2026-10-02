#!/usr/bin/env python3
"""Read-only PTC statistics for indexed coding sessions on one pirc node.

Usage: python3 scripts/ptc-stats.py /path/to/node/state
   or: python3 scripts/ptc-stats.py /path/to/gateway.sqlite

Scans all retained JSONL branches, including nested agent sessions.
Prints only aggregate counts, never message content or tool arguments.
"""

import argparse
import json
import sqlite3
from collections import Counter
from pathlib import Path


def ratio(n, d):
    return f"{n}/{d} ({n / d:.1%})" if d else "N/A"


def analyze(database):
    conn = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        conn.execute("PRAGMA query_only = ON")
        rows = conn.execute("""
            SELECT s.private_session_path
            FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
            WHERE w.kind = 'directory'
        """).fetchall()
    finally:
        conn.close()

    files = {}
    missing = scan_errors = 0
    for (directory,) in rows:
        if not directory or directory.startswith("node://"):
            missing += 1
            continue
        root = Path(directory).expanduser()
        if not root.is_absolute():
            # The service's working directory cannot safely be inferred here.
            missing += 1
            continue
        main = root / "session.jsonl"
        try:
            if not main.is_file():
                missing += 1
            for file in root.rglob("session.jsonl"):
                file = file.resolve()
                kind = "主 session" if file == main.resolve() else "子／巢狀 session"
                if file not in files or kind == "主 session":
                    files[file] = kind
        except OSError:
            scan_errors += 1

    stats = {k: Counter() for k in ("主 session", "子／巢狀 session")}
    tools, inner_tools = Counter(), Counter()
    bad_lines = unreadable = 0
    for file, kind in files.items():
        calls, results, seen = {}, {}, set()
        try:
            with file.open(encoding="utf-8") as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    try:
                        entry = json.loads(line)
                        if not isinstance(entry, dict):
                            raise ValueError()
                    except (ValueError, TypeError):
                        bad_lines += 1
                        continue
                    eid = entry.get("id")
                    if isinstance(eid, str):
                        if eid in seen:
                            continue
                        seen.add(eid)
                    if entry.get("type") != "message":
                        continue
                    msg = entry.get("message")
                    if not isinstance(msg, dict):
                        bad_lines += 1
                        continue
                    if msg.get("role") == "assistant":
                        content = msg.get("content", [])
                        if not isinstance(content, list):
                            continue
                        for part in content:
                            if not isinstance(part, dict) or part.get("type") != "toolCall":
                                continue
                            cid, name = part.get("id"), part.get("name")
                            if isinstance(cid, str) and isinstance(name, str):
                                calls[cid] = name
                    elif msg.get("role") == "toolResult":
                        cid = msg.get("toolCallId")
                        if isinstance(cid, str):
                            results[cid] = msg
        except (OSError, UnicodeError):
            unreadable += 1
            continue

        s = stats[kind]
        s["sessions"] += 1
        s["tool_sessions"] += bool(calls)
        s["calls"] += len(calls)
        tools.update(calls.values())
        ptc = [cid for cid, name in calls.items() if name == "code"]
        s["ptc_sessions"] += bool(ptc)
        s["ptc"] += len(ptc)
        for cid in ptc:
            result = results.get(cid)
            if result is None:
                s["no_result"] += 1
                continue
            s["results"] += 1
            s["errors"] += bool(result.get("isError"))
            details = result.get("details")
            nested = details.get("toolCalls") if isinstance(details, dict) else None
            if isinstance(nested, list):
                s["with_details"] += 1
                s["inner_calls"] += len(nested)
                s["multi_call"] += len(nested) >= 2
                for item in nested:
                    if isinstance(item, dict):
                        name = item.get("name")
                        if isinstance(name, str):
                            inner_tools[name] += 1
                        s["inner_errors"] += bool(item.get("isError"))

    total = Counter()
    for s in stats.values():
        total.update(s)
    print("範圍：本機 node、索引中的 coding workspace、全部保留分支。")
    print("子 agent 分開計算；不代表所有 session 都曾啟用 PTC。")
    print(f"coding 主 session 索引數：{len(rows)}")
    print(f"缺少紀錄／無法定位：{missing}；掃描目錄失敗：{scan_errors}")
    print(f"讀取失敗檔案：{unreadable}；無效 JSONL 行：{bad_lines}")
    for label, s in [*stats.items(), ("合計", total)]:
        print(f"\n【{label}】")
        print(f"讀取紀錄檔：{s['sessions']}；有工具呼叫：{s['tool_sessions']}")
        print("用過 PTC／全部紀錄檔：", ratio(s["ptc_sessions"], s["sessions"]))
        print("用過 PTC／有工具呼叫：", ratio(s["ptc_sessions"], s["tool_sessions"]))
        print("PTC／模型直接工具呼叫：", ratio(s["ptc"], s["calls"]))
        print("PTC 有結果：", s["results"], "；缺少結果：", s["no_result"])
        print("PTC 錯誤／有結果：", ratio(s["errors"], s["results"]))
        print("含內部呼叫明細的 PTC：", s["with_details"])
        print("一次 ≥2 個內部工具：", ratio(s["multi_call"], s["with_details"]))
        avg = s["inner_calls"] / s["with_details"] if s["with_details"] else None
        print("平均內部工具呼叫：", f"{avg:.2f}" if avg is not None else "N/A")
        print("內部工具呼叫合計：", s["inner_calls"], "；回報錯誤：", s["inner_errors"])
    print("\n模型直接呼叫的工具 Top 15：")
    for name, count in tools.most_common(15):
        print(f"  {name}: {count}")
    print("\nPTC 內部呼叫的工具 Top 15：")
    for name, count in inner_tools.most_common(15):
        print(f"  {name}: {count}")
    print("\n注意：這些次數不能直接換算成節省的模型回合或 token。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="node state 目錄，或 node SQLite 資料庫路徑")
    args = parser.parse_args()
    database = args.path.expanduser().resolve()
    if database.is_dir():
        database /= "gateway.sqlite"
    if not database.is_file():
        parser.exit(1, "找不到 node 資料庫；請確認 state 目錄或資料庫路徑。\n")
    try:
        analyze(database)
    except (sqlite3.Error, OSError) as error:
        parser.exit(1, f"無法統計（{type(error).__name__}）；請確認使用的是本機 node 資料庫及讀取權限。\n")


if __name__ == "__main__":
    main()
