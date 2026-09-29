"""构建时生成的派生表：时间轴事件（event）与数据质量提示（quality_issue）。

两张表每次构建整表重建，不手改。来源状态（是否过期、最近是否失败）随时间变化，
由视图 v_source_status 在查询时计算，不存在这里。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta

from store import db, news

CONTENT_TYPE_LABEL = {
    "version_trailer": "版本 PV", "character_trailer": "角色 PV", "character_demo": "角色演示",
    "character_ep": "角色 EP", "season_teaser": "先导 PV",
}
TIMELINE_LOCALES = ("zh-cn", "global")   # 时间轴只标 B 站和 YouTube 全球频道的发布，四个语区同一天各标一次没有意义
MISSING_DAYS_LISTED = 10


def _version_key(version: str) -> tuple[int, int] | None:
    try:
        major, minor = version.split(".")
        return int(major), int(minor)
    except ValueError:
        return None


def events(conn: sqlite3.Connection) -> list[dict]:
    out: list[dict] = []
    for r in conn.execute("SELECT game_id, version_id, start_date, source, source_url FROM version "
                          "WHERE status = 'released'"):
        out.append({"game_id": r["game_id"], "date": r["start_date"], "type": "version_update",
                    "version_id": r["version_id"], "label": f"{r['version_id']} 版本更新",
                    "evidence": f"versions.yml:{r['source'] or 'manual'}", "source_url": r["source_url"],
                    "is_version_boundary": 1})

    for r in conn.execute("SELECT game_id, date, title, url FROM steam_news WHERE is_official = 1 ORDER BY date"):
        if news.classify(r["title"]) != "version_preview":
            continue
        version = news.extract_version(r["title"])
        out.append({"game_id": r["game_id"], "date": r["date"], "type": "version_preview", "version_id": version,
                    "label": f"{version + ' ' if version else ''}前瞻节目", "evidence": "steam_news",
                    "source_url": r["url"], "is_version_boundary": 0})

    previous: dict[str, str] = {}
    for r in conn.execute("SELECT game_id, date, buildid, build_updated_date FROM steam_build ORDER BY game_id, date"):
        last = previous.get(r["game_id"])
        if last is not None and r["buildid"] != last:
            out.append({"game_id": r["game_id"], "date": r["build_updated_date"] or r["date"], "type": "build_update",
                        "version_id": None, "label": f"构建号更新 {last} → {r['buildid']}",
                        "evidence": "steamcmd.net", "source_url": None, "is_version_boundary": 0})
        previous[r["game_id"]] = r["buildid"]

    placeholders = ", ".join("?" for _ in TIMELINE_LOCALES)
    for r in conn.execute(f"SELECT game_id, pub_date, content_type, character_name, version_id, title, platform, video_id "
                          f"FROM v_video WHERE curated = 1 AND locale IN ({placeholders}) AND pub_date IS NOT NULL",
                          TIMELINE_LOCALES):
        kind = CONTENT_TYPE_LABEL.get(r["content_type"], "官方视频")
        name = f"{r['character_name']} {kind}" if r["character_name"] else kind
        url = (f"https://www.bilibili.com/video/{r['video_id']}" if r["platform"] == "bilibili"
               else f"https://www.youtube.com/watch?v={r['video_id']}")
        out.append({"game_id": r["game_id"], "date": r["pub_date"], "type": "video_release",
                    "version_id": r["version_id"], "label": f"{name}（{'B 站' if r['platform'] == 'bilibili' else 'YouTube'}）",
                    "evidence": "video_pairs.yml", "source_url": url, "is_version_boundary": 0})
    return sorted(out, key=lambda e: (e["game_id"], e["date"], e["type"]))


def quality_issues(conn: sqlite3.Connection) -> list[dict]:
    issues: list[dict] = []

    def add(game_id, level, code, message, **detail):
        issues.append({"game_id": game_id, "level": level, "code": code, "message": message,
                       "detail": json.dumps(detail, ensure_ascii=False) if detail else None})

    known = {(r[0], r[1]) for r in conn.execute("SELECT game_id, version_id FROM version")}
    for r in conn.execute("SELECT game_id, date, title, url FROM steam_news WHERE is_official = 1"):
        if news.classify(r["title"]) != "version_update":
            continue
        version = news.extract_version(r["title"])
        if version and (r["game_id"], version) not in known:
            add(r["game_id"], "warn", "version_not_in_table",
                f"公告提到 {version} 版本更新，但版本表里没有这个版本", version=version, date=r["date"], url=r["url"])

    released: dict[str, list[str]] = {}
    for r in conn.execute("SELECT game_id, version_id FROM version WHERE status = 'released' ORDER BY game_id, start_date"):
        released.setdefault(r[0], []).append(r[1])
    for game_id, versions in released.items():
        for a, b in zip(versions, versions[1:]):
            ka, kb = _version_key(a), _version_key(b)
            if ka and kb and ka[0] == kb[0] and kb[1] - ka[1] > 1:
                add(game_id, "warn", "version_gap", f"版本号从 {a} 跳到 {b}，中间可能漏登记了版本", after=a, before=b)

    for r in conn.execute("SELECT game_id, MIN(date), MAX(date), COUNT(*) FROM steam_daily GROUP BY game_id"):
        first, last = date.fromisoformat(r[1]), date.fromisoformat(r[2])
        have = {x[0] for x in conn.execute("SELECT date FROM steam_daily WHERE game_id = ?", (r[0],))}
        missing = [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)
                   if (first + timedelta(days=i)).isoformat() not in have]
        if missing:
            add(r[0], "warn", "missing_days", f"Steam 每日汇总有 {len(missing)} 天没有采到",
                count=len(missing), dates=missing[:MISSING_DAYS_LISTED])

    for r in conn.execute("SELECT game_id, date, total_reviews, prev_total FROM ("
                          "  SELECT game_id, date, total_reviews,"
                          "         LAG(total_reviews) OVER (PARTITION BY game_id ORDER BY date) AS prev_total"
                          "  FROM steam_daily WHERE total_reviews IS NOT NULL)"
                          " WHERE prev_total - total_reviews > MAX(50, prev_total * 0.01)"):
        add(r["game_id"], "warn", "review_total_regression",
            f"{r['date']} Steam 总评测数比上一次少了 {r['prev_total'] - r['total_reviews']} 条",
            date=r["date"], before=r["prev_total"], after=r["total_reviews"])

    for r in conn.execute("SELECT o.game_id, o.platform, o.video_id, o.date, o.views, o.views_delta FROM v_video_obs o "
                          "WHERE o.views_delta < 0"):
        add(r["game_id"], "warn", "video_view_regression",
            f"视频 {r['video_id']} 在 {r['date']} 的累计播放比上一次少了 {-r['views_delta']}",
            platform=r["platform"], video_id=r["video_id"], date=r["date"])
    return issues


def refresh(conn: sqlite3.Connection) -> dict:
    ev = events(conn)
    qi = quality_issues(conn)
    with db.transaction(conn):
        conn.execute("DELETE FROM event")
        conn.execute("DELETE FROM quality_issue")
        db.insert(conn, "event", ev)
        db.insert(conn, "quality_issue", qi)
    return {"event": len(ev), "quality_issue": len(qi)}
