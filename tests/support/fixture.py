"""测试用合成数据：两款虚构游戏，数据量小、固定随机种子、每次生成都完全相同。

构建测试、浏览器端查询测试、端到端页面测试都用它，所以 CI 不需要真实数据。
生成的是"配置目录 + 数据库"：维度表通过真实的 config_sync 从 YAML 同步，走的是正式路径。

    python -m tests.support.fixture OUT_DIR    # 写出 OUT_DIR/config/*.yml 与 OUT_DIR/gamepulse.sqlite
"""

from __future__ import annotations

import math
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yaml

from store import config_sync, db

START = date(2026, 6, 1)
END = date(2026, 9, 20)            # 评测覆盖到这一天
LANGUAGES = [("english", 0.55), ("schinese", 0.15), ("russian", 0.12), ("japanese", 0.10), ("koreana", 0.08)]

GAMES = [
    {"game_id": "alpha", "display_name": "测试甲", "short_name": "甲", "developer": "甲工作室",
     "steam_app_id": 1001, "steam_release": "2026-06-01", "active": True},
    {"game_id": "beta", "display_name": "测试乙", "short_name": "乙", "developer": "乙工作室",
     "steam_app_id": 1002, "steam_release": "2026-06-15", "active": True},
]
VERSIONS = {
    "alpha": {"1.0": "2026-06-01", "1.1": "2026-07-01", "1.2": "2026-08-01", "1.3": None},
    "beta": {"2.0": "2026-06-15", "2.1": "2026-07-20"},
}
# 每个版本一支角色 PV：B 站 + YouTube 全球 + 日语
PAIRS = [
    ("alpha", "1.1", "2026-06-28", "角色 A"), ("alpha", "1.2", "2026-07-29", "角色 B"),
    ("beta", "2.1", "2026-07-18", "角色 C"),
]


def _day(d: date) -> str:
    return d.isoformat()


def _days(a: date, b: date):
    for i in range((b - a).days + 1):
        yield a + timedelta(days=i)


def write_config(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    versions = {gid: {vid: ({"steam_start_date": start, "status": "released", "source": "steam_announcement",
                             "source_url": f"https://example.com/{gid}/{vid}"} if start else
                            {"cn_start_date": "2026-09-25", "status": "scheduled"})
                      for vid, start in vs.items()} for gid, vs in VERSIONS.items()}
    pairs, bili, yt = [], [], []
    for i, (gid, vid, pub, name) in enumerate(PAIRS):
        pair_id = f"{gid}_{vid}_pv"
        ids = {"bili": f"BVfix{i}", "global": f"YTglobal{i}", "ja": f"YTja{i}"}
        pairs.append({"pair_id": pair_id, "game_id": gid, "bvid": ids["bili"], "pubdate": pub,
                      "content_type": "character_trailer", "character_name": name, "version_id": vid,
                      "version_confirmed": True, "youtube": {"global": ids["global"], "ja": ids["ja"]}})
        bili.append({"bvid": ids["bili"], "game_id": gid, "title": f"{name} PV", "pubdate": pub,
                     "content_type": "character_trailer", "is_official_account": True, "active": True})
        for loc in ("global", "ja"):
            yt.append({"video_id": ids[loc], "game_id": gid, "locale": loc, "title": f"{name} Trailer ({loc})",
                       "pubdate": pub, "content_type": "character_trailer", "is_official_account": True,
                       "active": True})
    files = {
        "games.yml": {"games": GAMES},
        "versions.yml": versions,
        "bilibili_videos.yml": {"official_accounts": {g["game_id"]: {"mid": g["steam_app_id"], "name": g["display_name"]}
                                                      for g in GAMES}, "videos": bili},
        "youtube_videos.yml": {"official_channels": {g["game_id"]: {loc: {"channel_id": f"UC{g['game_id']}{loc}",
                                                                           "title": f"{g['display_name']} {loc}"}
                                                                     for loc in ("global", "ja")} for g in GAMES},
                               "videos": yt},
        "video_pairs.yml": {"videos": pairs},
    }
    for name, content in files.items():
        (folder / name).write_text(yaml.safe_dump(content, allow_unicode=True, sort_keys=False), encoding="utf-8")
    # 指标目录用项目里真实的那份
    (folder / "metrics.yml").write_text((config_sync.CONFIG_DIR / "metrics.yml").read_text(encoding="utf-8"),
                                        encoding="utf-8")


def _version_start(gid: str, d: date) -> date | None:
    starts = [date.fromisoformat(s) for s in VERSIONS[gid].values() if s and date.fromisoformat(s) <= d]
    return max(starts) if starts else None


def fill(conn, rng: random.Random) -> None:
    rid = 1
    for g in GAMES:
        gid = g["game_id"]
        release = date.fromisoformat(g["steam_release"])
        reviews = []
        for d in _days(release, END):
            since = (d - _version_start(gid, d)).days
            base = 6 if gid == "alpha" else 4
            n = rng.randint(0, base) + int(30 * math.exp(-since / 3))   # 版本更新后几天评测更多
            for _ in range(n):
                lang = rng.choices([l for l, _ in LANGUAGES], [w for _, w in LANGUAGES])[0]
                playtime = int(rng.lognormvariate(6.5, 1.3))
                forever = playtime + int(rng.expovariate(1 / 1500))
                ts = int(datetime(d.year, d.month, d.day, rng.randint(0, 23), tzinfo=timezone(timedelta(hours=8))).timestamp())
                reviews.append({"review_id": rid, "game_id": gid, "created_at": ts, "created_date": _day(d),
                                "voted_up": None if rng.random() < 0.005 else int(rng.random() < 0.84),
                                "language": lang, "playtime_at_review": playtime, "playtime_forever": forever,
                                "steam_purchase": 1, "received_for_free": 0,
                                "last_seen_at": "2026-09-20T08:00:00+00:00"})
                rid += 1
        db.upsert(conn, "review", reviews)
        db.insert(conn, "review_run", [{"game_id": gid, "mode": "full", "finished_at": "2026-09-20T08:00:00+00:00",
                                        "covered_through": _day(END), "pages": 10, "fetched": len(reviews),
                                        "total_expected": len(reviews), "stop_reason": "empty_page"}])

        online = []
        for d in _days(release - timedelta(days=1), END - timedelta(days=5)):
            since = (d - (_version_start(gid, d) or release)).days
            level = (9000 if gid == "alpha" else 5000) * (1 + 0.8 * math.exp(-since / 5)) * rng.uniform(0.93, 1.07)
            online.append({"game_id": gid, "date": _day(d), "avg_players": int(level),
                           "point_players": int(level * 1.2), "source_file": "fixture.csv",
                           "imported_at": "2026-09-16T00:00:00+00:00"})
        db.upsert(conn, "online_daily", online)

        total = sum(1 for r in reviews)
        steam = []
        for i, d in enumerate(_days(END - timedelta(days=19), END)):
            if i in (6, 7):   # 两天漏采
                continue
            steam.append({"game_id": gid, "date": _day(d), "total_reviews": total - (19 - i) * 5,
                          "total_positive": int((total - (19 - i) * 5) * 0.84), "review_score_desc": "Very Positive",
                          "current_players": rng.randint(4000, 9000), "observed_at": f"{_day(d)}T06:00:00+00:00"})
        db.upsert(conn, "steam_daily", steam)

    obs = []
    for i, (gid, vid, pub, _name) in enumerate(PAIRS):
        pub_day = date.fromisoformat(pub)
        for platform, video_id, scale in (("bilibili", f"BVfix{i}", 2.0), ("youtube", f"YTglobal{i}", 1.5),
                                          ("youtube", f"YTja{i}", 0.4)):
            first = pub_day + timedelta(days=0 if i == 0 else 3)     # 第二、三支视频缺少发布初期
            for d in _days(first, END):
                age = (d - pub_day).days
                views = int(scale * 1_000_000 * (1 - math.exp(-(age + 1) / 6)))
                obs.append({"platform": platform, "video_id": video_id, "date": _day(d), "views": views,
                            "likes": views // 40, "comments": None if platform == "bilibili" else views // 900,
                            "coins": views // 90 if platform == "bilibili" else None,
                            "favorites": views // 120 if platform == "bilibili" else None,
                            "shares": views // 300 if platform == "bilibili" else None,
                            "danmaku": views // 500 if platform == "bilibili" else None,
                            "observed_at": f"{_day(d)}T08:00:00+00:00"})
    db.upsert(conn, "video_obs", obs)

    for g in GAMES:
        for source in ("steam", "bilibili", "youtube", "reviews_full", "steamdb"):
            db.record_attempt(conn, source, g["game_id"], _day(END), "success", expected=1, succeeded=1,
                              attempted_at="2026-09-20T08:00:00+00:00")
    db.record_attempt(conn, "youtube", "beta", _day(END), "failed", expected=2, succeeded=0,
                      detail="request_error:ConnectTimeout: https://www.googleapis.com via http://127.0.0.1:7890",
                      attempted_at="2026-09-20T09:00:00+00:00")
    db.upsert(conn, "steam_news", [
        {"game_id": "alpha", "gid": "n1", "date": "2026-06-25", "published_at": None,
         "title": "Version 1.1 Preview Special Program", "url": "https://example.com/n1", "feed_label": "Community Announcements",
         "feed_name": "steam_community_announcements", "is_official": 1, "observed_at": "x"},
        {"game_id": "alpha", "gid": "n2", "date": "2026-09-10", "published_at": None,
         "title": "Version 1.4 Update Announcement", "url": "https://example.com/n2", "feed_label": "Community Announcements",
         "feed_name": "steam_community_announcements", "is_official": 1, "observed_at": "x"},
    ])


def build(folder: Path) -> Path:
    """在 folder 下生成 config/ 与 gamepulse.sqlite，返回数据库路径。"""
    config_dir = folder / "config"
    write_config(config_dir)
    path = folder / "gamepulse.sqlite"
    for suffix in ("", "-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)
    conn = db.connect(path)
    try:
        config_sync.sync(conn, config_dir)
        with db.transaction(conn):
            fill(conn, random.Random(7))
    finally:
        conn.close()
    return path


if __name__ == "__main__":
    print(build(Path(sys.argv[1])))
