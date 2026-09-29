"""一次性把 v2 的数据导入 v3 数据库。

读取 v2 目录（只读）：
  data/series/<game>/*.jsonl        逐日采集与 SteamDB 导入
  data/raw/backfill/*.json          评测明细（全量 + 与之衔接的增量）

v2 里"失败时保留旧观测"写下的行，只有标为 observed 的字段才导入；
失败的采集不导入事实表，只保留在 collection_attempt 里。

    python -m store.migrate_v2 --source ../game-ops-radar
    python -m store.migrate_v2 --source ../game-ops-radar --db data/gamepulse.sqlite --replace
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from store import config_sync, db, news

BUSINESS_TZ = timezone(timedelta(hours=8))

# v2 采集记录的来源名 → v3 名称（小时在线在 v3 停采，保留原名只作历史）
ATTEMPT_SOURCES = {
    "steam_reviews_incremental": "reviews_incremental",
    "steam_reviews_backfill": "reviews_full",
}


def business_date(ts: int) -> str:
    return datetime.fromtimestamp(int(ts), BUSINESS_TZ).date().isoformat()


def local_day_start_utc(day: str) -> str:
    """业务日 0 点（UTC+8）换成 UTC ISO，用于只记录了日期的 v2 运行。"""
    start = datetime.fromisoformat(day).replace(tzinfo=BUSINESS_TZ)
    return start.astimezone(timezone.utc).isoformat(timespec="seconds")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _flag(value) -> int | None:
    return int(value) if isinstance(value, bool) else None


def review_rows(raw_dir: Path, game_id: str) -> tuple[list[dict], list[dict]]:
    """返回 (评测行, 回填运行记录)。增量回填只在它衔接当前全量时才合并（与 v2 相同）。"""
    full_path = raw_dir / "backfill" / f"steam_reviews_{game_id}.json"
    if not full_path.exists():
        return [], []
    full = json.loads(full_path.read_text(encoding="utf-8"))
    full_seen = full.get("collected_at_utc") or local_day_start_utc(full["collected_at"])
    rows = {str(r["recommendationid"]): (r, full_seen) for r in full.get("reviews", []) if r.get("recommendationid")}
    meta = full.get("meta") or {}
    runs = [{"game_id": game_id, "mode": "full", "finished_at": full_seen, "covered_through": full["collected_at"],
             "cutoff": None, "pages": meta.get("pages"), "fetched": meta.get("collected"),
             "total_expected": meta.get("total_expected"), "stop_reason": meta.get("stop_reason")}]

    inc_path = raw_dir / "backfill" / f"steam_reviews_incremental_{game_id}.json"
    if inc_path.exists():
        inc = json.loads(inc_path.read_text(encoding="utf-8"))
        if inc.get("base_run_id") == (full.get("collected_at_utc") or full.get("collected_at")):
            inc_seen = local_day_start_utc(inc["collected_at"])
            rows.update({str(r["recommendationid"]): (r, inc_seen)
                         for r in inc.get("reviews", []) if r.get("recommendationid")})
            meta = inc.get("meta") or {}
            runs.append({"game_id": game_id, "mode": "incremental", "finished_at": inc_seen,
                         "covered_through": inc["collected_at"], "cutoff": meta.get("cutoff"),
                         "pages": meta.get("pages"), "fetched": meta.get("fetched"),
                         "total_expected": meta.get("total_expected"), "stop_reason": meta.get("stop_reason")})

    out = []
    for rid, (r, seen) in rows.items():
        if not r.get("timestamp_created"):
            continue
        out.append({
            "review_id": int(rid), "game_id": game_id, "created_at": int(r["timestamp_created"]),
            "created_date": business_date(r["timestamp_created"]), "voted_up": _flag(r.get("voted_up")),
            "language": r.get("language"), "playtime_at_review": r.get("playtime_at_review"),
            "playtime_forever": r.get("playtime_forever"), "steam_purchase": _flag(r.get("steam_purchase")),
            "received_for_free": _flag(r.get("received_for_free")), "last_seen_at": seen,
        })
    return out, runs


def steam_daily_rows(records: list[dict], game_id: str) -> list[dict]:
    rows = []
    for r in records:
        reviews_ok = r.get("reviews_status") == "observed"
        players_ok = r.get("current_players_status") == "observed"
        if not (reviews_ok or players_ok):
            continue
        rows.append({
            "game_id": game_id, "date": r["date_local"],
            "total_reviews": r.get("total_reviews") if reviews_ok else None,
            "total_positive": r.get("total_positive") if reviews_ok else None,
            "review_score_desc": r.get("review_score_desc") if reviews_ok else None,
            "current_players": r.get("current_players") if players_ok else None,
            "observed_at": r.get("sampled_at") or local_day_start_utc(r["date_local"]),
        })
    return rows


def video_obs_rows(records: list[dict], platform: str, known: set[tuple[str, str]],
                   skipped: Counter) -> tuple[list[dict], dict[str, dict]]:
    id_key = "bvid" if platform == "bilibili" else "video_id"
    rows: dict[tuple[str, str], dict] = {}
    latest_meta: dict[str, dict] = {}
    for day in records:
        for v in day.get("videos") or []:
            vid = v.get(id_key)
            if not vid:
                continue
            if v.get("status") != "observed" or v.get("view") is None:
                skipped["video_not_observed"] += 1
                continue
            if v.get("identity_verified") is False:
                skipped["video_identity_rejected"] += 1
                continue
            if (platform, vid) not in known:
                skipped["video_not_registered"] += 1
                continue
            comments = v.get("reply") if platform == "bilibili" else v.get("comment")
            rows[(vid, day["date_local"])] = {
                "platform": platform, "video_id": vid, "date": day["date_local"], "views": v.get("view"),
                "likes": v.get("like"), "comments": comments, "coins": v.get("coin"),
                "favorites": v.get("favorite"), "shares": v.get("share"), "danmaku": v.get("danmaku"),
                "observed_at": v.get("observed_at") or day.get("sampled_at") or local_day_start_utc(day["date_local"]),
            }
            latest_meta[vid] = {
                "observed_title": v.get("title"),
                "observed_channel": v.get("channel_title") or v.get("owner_name"),
                "published_at": v.get("published_at"),
            }
    return list(rows.values()), latest_meta


def news_rows(records: list[dict], game_id: str) -> list[dict]:
    rows: dict[str, dict] = {}
    for day in records:
        for item in day.get("items") or []:
            gid = item.get("gid")
            if not gid or gid in rows or not item.get("date_local"):
                continue
            rows[gid] = {
                "game_id": game_id, "gid": str(gid), "date": item["date_local"],
                "published_at": item.get("timestamp"), "title": item.get("title"), "url": item.get("url"),
                "feed_label": item.get("feedlabel"), "feed_name": item.get("feedname"),
                "is_official": int(news.is_official(item.get("feedname"), item.get("feedlabel"))),
                "observed_at": day.get("sampled_at") or local_day_start_utc(day["date_local"]),
            }
    return list(rows.values())


def migrate(source: Path, conn: sqlite3.Connection, config_dir: Path = config_sync.CONFIG_DIR) -> dict:
    series = source / "data" / "series"
    raw = source / "data" / "raw"
    imported_at = db.now_iso()
    counts: Counter = Counter()
    skipped: Counter = Counter()

    with db.transaction(conn):
        counts.update({f"dim_{k}": v for k, v in config_sync.sync(conn, config_dir).items()})
        games = [r[0] for r in conn.execute("SELECT game_id FROM game")]
        known_videos = {(r[0], r[1]) for r in conn.execute("SELECT platform, video_id FROM video")}

        for gid in games:
            folder = series / gid
            reviews, runs = review_rows(raw, gid)
            counts["review"] += db.upsert(conn, "review", reviews)
            counts["review_run"] += db.insert(conn, "review_run", runs)

            online = [{"game_id": gid, "date": r["date_local"], "avg_players": r.get("average_players"),
                       "point_players": r.get("current_players"), "source_file": "v2:steamdb_online.jsonl",
                       "imported_at": imported_at}
                      for r in read_jsonl(folder / "steamdb_online.jsonl")]
            counts["online_daily"] += db.upsert(conn, "online_daily", online)

            hourly = [{"game_id": gid, "date": r["date_local"], "hour": r["hour_local"], "players": r["players"],
                       "sampled_at": r["sampled_at"]}
                      for r in read_jsonl(folder / "steam_online.jsonl")
                      if r.get("status") == "observed" and r.get("players") is not None]
            counts["online_hourly"] += db.upsert(conn, "online_hourly", hourly)

            counts["steam_daily"] += db.upsert(conn, "steam_daily",
                                               steam_daily_rows(read_jsonl(folder / "steam.jsonl"), gid))

            for platform in ("bilibili", "youtube"):
                obs, meta = video_obs_rows(read_jsonl(folder / f"{platform}.jsonl"), platform, known_videos, skipped)
                counts["video_obs"] += db.upsert(conn, "video_obs", obs)
                conn.executemany(
                    "UPDATE video SET observed_title = ?, observed_channel = ?, published_at = ? "
                    "WHERE platform = ? AND video_id = ?",
                    [(m["observed_title"], m["observed_channel"], m["published_at"], platform, vid)
                     for vid, m in meta.items()])

            counts["steam_news"] += db.upsert(conn, "steam_news", news_rows(read_jsonl(folder / "steam_news.jsonl"), gid))

            builds = [{"game_id": gid, "date": r["date_local"], "buildid": r["buildid"],
                       "build_updated_at": r.get("build_updated_at"), "build_updated_date": r.get("build_updated_date"),
                       "observed_at": r.get("sampled_at") or local_day_start_utc(r["date_local"])}
                      for r in read_jsonl(folder / "steam_build.jsonl") if r.get("buildid")]
            counts["steam_build"] += db.upsert(conn, "steam_build", builds)

            for a in read_jsonl(folder / "collection_attempts.jsonl"):
                db.record_attempt(conn, ATTEMPT_SOURCES.get(a["source"], a["source"]), gid, a["date_local"], a["status"],
                                  expected=a.get("expected"), succeeded=a.get("succeeded"),
                                  detail=a.get("detail") or None, attempted_at=a.get("attempted_at"))
                counts["collection_attempt"] += 1
    return {"imported": dict(counts), "skipped": dict(skipped)}


def main() -> int:
    parser = argparse.ArgumentParser(description="把 v2 的 JSONL 与评测回填导入 v3 数据库")
    parser.add_argument("--source", type=Path, required=True, help="v2 项目根目录")
    parser.add_argument("--db", type=Path, default=db.DB_PATH)
    parser.add_argument("--replace", action="store_true", help="数据库已存在时删除后重建")
    args = parser.parse_args()

    if not (args.source / "data" / "series").is_dir():
        print(f"找不到 v2 数据：{args.source / 'data' / 'series'}")
        return 1
    if args.db.exists():
        if not args.replace:
            print(f"{args.db} 已存在；确认要重建请加 --replace")
            return 1
        for suffix in ("", "-wal", "-shm"):
            Path(f"{args.db}{suffix}").unlink(missing_ok=True)
    conn = db.connect(args.db)
    try:
        result = migrate(args.source.resolve(), conn)
    finally:
        conn.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
