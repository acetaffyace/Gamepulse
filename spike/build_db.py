"""Spike: load the existing JSONL series and raw review backfills into SQLite.

Reads the v2 data directory read-only and writes spike/out/gamepulse.sqlite.
The goal is to measure database size and query speed, and to cross-check the
SQL metric views against the numbers v2 publishes; this is not yet the v3
ingest path.

    python spike/build_db.py --source ../game-ops-radar
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TZ = timezone(timedelta(hours=8))

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE game (
  game_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  developer     TEXT,
  steam_app_id  INTEGER NOT NULL,
  steam_release TEXT
);

CREATE TABLE version (
  game_id     TEXT NOT NULL REFERENCES game,
  version_id  TEXT NOT NULL,
  start_date  TEXT NOT NULL,              -- Steam 端开放日，UTC+8
  status      TEXT NOT NULL,              -- released | scheduled
  source      TEXT,
  source_url  TEXT,
  PRIMARY KEY (game_id, version_id)
);

-- 一条 Steam 评测一行：自助切片（语种 × 时长 × 版本）的基础
CREATE TABLE review (
  review_id          INTEGER PRIMARY KEY, -- Steam recommendationid
  game_id            TEXT NOT NULL REFERENCES game,
  created_date       TEXT NOT NULL,       -- UTC+8 业务日
  voted_up           INTEGER,             -- NULL = 未知，不能当作差评
  language           TEXT,
  playtime_at_review INTEGER,             -- 分钟
  playtime_forever   INTEGER,
  steam_purchase     INTEGER,
  received_for_free  INTEGER
);

-- SteamDB 日汇总：在线人数的唯一可比口径
CREATE TABLE online_daily (
  game_id      TEXT NOT NULL REFERENCES game,
  date         TEXT NOT NULL,
  avg_players  INTEGER,
  peak_players INTEGER,
  PRIMARY KEY (game_id, date)
) WITHOUT ROWID;

-- Steam 官方每日汇总（总评测数等存量）
CREATE TABLE steam_daily (
  game_id        TEXT NOT NULL REFERENCES game,
  date           TEXT NOT NULL,
  total_reviews  INTEGER,
  total_positive INTEGER,
  PRIMARY KEY (game_id, date)
) WITHOUT ROWID;

CREATE TABLE video (
  platform          TEXT NOT NULL,        -- bilibili | youtube
  video_id          TEXT NOT NULL,
  game_id           TEXT NOT NULL REFERENCES game,
  title             TEXT,
  channel           TEXT,
  locale            TEXT,                 -- 频道语区，不是观众地区
  published_date    TEXT,
  content_type      TEXT,
  version_id        TEXT,
  character_name    TEXT,
  pair_id           TEXT,
  identity_verified INTEGER,
  PRIMARY KEY (platform, video_id)
) WITHOUT ROWID;

-- 视频累计计数的每日观测；缺失保持 NULL
CREATE TABLE video_obs (
  platform TEXT NOT NULL,
  video_id TEXT NOT NULL,
  date     TEXT NOT NULL,
  views    INTEGER,
  likes    INTEGER,
  comments INTEGER,
  coins    INTEGER,
  favorites INTEGER,
  shares   INTEGER,
  danmaku  INTEGER,
  PRIMARY KEY (platform, video_id, date),
  FOREIGN KEY (platform, video_id) REFERENCES video
) WITHOUT ROWID;
"""

VIEWS = """
-- 版本窗口：本次开放日 → 下个已开放版本前一天；最后一个版本开放到今天
CREATE VIEW v_version AS
SELECT game_id, version_id, start_date,
       COALESCE(date(LEAD(start_date) OVER w, '-1 day'), date('now', '+8 hours')) AS end_date
FROM version WHERE status = 'released'
WINDOW w AS (PARTITION BY game_id ORDER BY start_date);

-- 评测事实表 + 所属版本 + 更新后第 N 天，所有评测类指标都从这里取
CREATE VIEW v_review AS
SELECT r.*, v.version_id,
       CAST(julianday(r.created_date) - julianday(v.start_date) AS INTEGER) AS day_index,
       CASE WHEN r.playtime_at_review IS NULL THEN NULL
            WHEN r.playtime_at_review < 120   THEN '<2h'
            WHEN r.playtime_at_review < 1200  THEN '2-20h'
            WHEN r.playtime_at_review < 6000  THEN '20-100h'
            ELSE '100h+' END AS playtime_band
FROM review r
LEFT JOIN v_version v
  ON v.game_id = r.game_id AND r.created_date BETWEEN v.start_date AND v.end_date;

CREATE VIEW v_review_daily AS
SELECT game_id, created_date AS date,
       COUNT(*) AS reviews,
       SUM(voted_up = 1) AS positive,
       SUM(voted_up = 0) AS negative
FROM review GROUP BY game_id, created_date;

-- 视频每日增量：相邻两次观测之差，跨缺采日的差值不冒充单日
CREATE VIEW v_video_delta AS
SELECT platform, video_id, date, views,
       views - LAG(views) OVER w AS views_delta,
       CAST(julianday(date) - julianday(LAG(date) OVER w) AS INTEGER) AS span_days
FROM video_obs
WINDOW w AS (PARTITION BY platform, video_id ORDER BY date);
"""


def business_date(ts: int) -> str:
    return datetime.fromtimestamp(int(ts), TZ).date().isoformat()


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_reviews(raw: Path, game_id: str) -> dict[str, dict]:
    """全量回填 + 与之衔接的增量回填，按评测 ID 去重（与 v2 rebuild_derived 同规则）。"""
    full_path = raw / "backfill" / f"steam_reviews_{game_id}.json"
    if not full_path.exists():
        return {}
    full = json.loads(full_path.read_text(encoding="utf-8"))
    rows = {str(r["recommendationid"]): r for r in full.get("reviews", []) if r.get("recommendationid")}
    inc_path = raw / "backfill" / f"steam_reviews_incremental_{game_id}.json"
    if inc_path.exists():
        inc = json.loads(inc_path.read_text(encoding="utf-8"))
        if inc.get("base_run_id") == (full.get("collected_at_utc") or full.get("collected_at")):
            rows.update({str(r["recommendationid"]): r for r in inc.get("reviews", []) if r.get("recommendationid")})
    return rows


def as_bool(value):
    return int(value) if isinstance(value, bool) else None


def build(source: Path, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    db = sqlite3.connect(out)
    db.executescript(SCHEMA)

    games = yaml.safe_load((source / "config" / "games.yml").read_text(encoding="utf-8"))["games"]
    versions = yaml.safe_load((source / "config" / "versions.yml").read_text(encoding="utf-8"))
    series = source / "data" / "series"
    raw = source / "data" / "raw"

    for g in games:
        gid = g["game_id"]
        db.execute("INSERT INTO game VALUES (?,?,?,?,?)",
                   (gid, g["display_name"], g.get("developer"), g["steam_app_id"], g.get("steam_release")))
        for vid, v in (versions.get(gid) or {}).items():
            start = v.get("steam_start_date") or (v.get("steam_start_at") or "")[:10]
            db.execute("INSERT INTO version VALUES (?,?,?,?,?,?)",
                       (gid, str(vid), start, v.get("status", "released"), v.get("source"), v.get("source_url")))

        db.executemany("INSERT INTO review VALUES (?,?,?,?,?,?,?,?,?)", [
            (int(rid), gid, business_date(r["timestamp_created"]), as_bool(r.get("voted_up")), r.get("language"),
             r.get("playtime_at_review"), r.get("playtime_forever"),
             as_bool(r.get("steam_purchase")), as_bool(r.get("received_for_free")))
            for rid, r in load_reviews(raw, gid).items() if r.get("timestamp_created")])

        db.executemany("INSERT INTO online_daily VALUES (?,?,?,?)", [
            (gid, r["date_local"], r.get("average_players"), r.get("current_players"))
            for r in read_jsonl(series / gid / "steamdb_online.jsonl")])

        db.executemany("INSERT INTO steam_daily VALUES (?,?,?,?)", [
            (gid, r["date_local"], r.get("total_reviews"), r.get("total_positive"))
            for r in read_jsonl(series / gid / "steam.jsonl")])

        for platform, id_key in (("bilibili", "bvid"), ("youtube", "video_id")):
            latest: dict[str, dict] = {}
            obs = []
            for day in read_jsonl(series / gid / f"{platform}.jsonl"):
                for v in day.get("videos", []):
                    if v.get("status") != "observed" or not v.get(id_key):
                        continue
                    latest[v[id_key]] = v
                    obs.append((platform, v[id_key], day["date_local"], v.get("view"), v.get("like"),
                                v.get("comment", v.get("reply")), v.get("coin"), v.get("favorite"),
                                v.get("share"), v.get("danmaku")))
            db.executemany("INSERT INTO video VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
                (platform, vid, gid, v.get("title"), v.get("channel_title") or v.get("owner_name"),
                 v.get("locale") or ("zh-CN" if platform == "bilibili" else None), v.get("pubdate"),
                 v.get("content_type"), v.get("version_id"), v.get("character_name"), v.get("pair_id"),
                 as_bool(v.get("identity_verified"))) for vid, v in latest.items()])
            db.executemany("INSERT OR REPLACE INTO video_obs VALUES (?,?,?,?,?,?,?,?,?,?)", obs)

    db.executescript(VIEWS)
    db.commit()
    db.execute("VACUUM")
    db.close()

    size = out.stat().st_size
    gz = len(gzip.compress(out.read_bytes(), 9))
    check = sqlite3.connect(out)
    counts = {t: check.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("game", "version", "review", "online_daily", "steam_daily", "video", "video_obs")}
    print(json.dumps({"file": str(out), "bytes": size, "gzip_bytes": gz, "rows": counts}, indent=2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=ROOT.parent / "game-ops-radar")
    ap.add_argument("--out", type=Path, default=HERE / "out" / "gamepulse.sqlite")
    args = ap.parse_args()
    if not (args.source / "data" / "series").is_dir():
        sys.exit(f"no v2 data under {args.source}")
    build(args.source.resolve(), args.out)
