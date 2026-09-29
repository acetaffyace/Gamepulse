"""把人工维护的 YAML 同步进维度表：游戏、版本、视频、视频配对。

YAML 是这些信息的唯一来源，数据库里的维度表每次构建都按它刷新：
- game、video：只增改。它们被事实表引用，登记表里移除的视频标 registered = 0，
  游戏从配置删除时只标 active = 0，历史数据保留。
- version、video_pair：没有被事实表引用，整表替换。
- 视频的采集字段（observed_title、published_at 等）不在这里覆盖。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import yaml

from store import db

CONFIG_DIR = db.ROOT / "config"

# 与 v2 相同的游戏配色顺序（games.yml 可用 color 字段覆盖）
SLOT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7", "#e87ba4"]
BILIBILI_LOCALE = "zh-cn"   # B 站视频的"频道语区"：面向中国大陆的中文频道


def load_yaml(name: str, config_dir: Path = CONFIG_DIR) -> dict:
    path = config_dir / name
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _flag(value) -> int | None:
    return None if value is None else int(bool(value))


def _date(value) -> str | None:
    return None if value in (None, "") else str(value)[:10]


def game_rows(config: dict) -> list[dict]:
    rows = []
    for index, g in enumerate(config.get("games") or []):
        rows.append({
            "game_id": g["game_id"],
            "display_name": g["display_name"],
            "short_name": g.get("short_name") or g["display_name"],
            "developer": g.get("developer"),
            "steam_app_id": int(g["steam_app_id"]),
            "steam_release": _date(g.get("steam_release")),
            "color": g.get("color") or SLOT_COLORS[index % len(SLOT_COLORS)],
            "active": _flag(g.get("active", True)),
        })
    return rows


def version_rows(config: dict, known_games: set[str]) -> list[dict]:
    rows = []
    for game_id, versions in (config or {}).items():
        if game_id not in known_games:
            raise ValueError(f"versions.yml: unknown game {game_id}")
        for version_id, v in (versions or {}).items():
            start_at = v.get("steam_start_at")
            start_date = v.get("steam_start_date") or (str(start_at)[:10] if start_at else None)
            status = v.get("status", "released")
            if not start_date and status == "released":
                raise ValueError(f"versions.yml: released version {game_id} {version_id} has no Steam start date")
            rows.append({
                "game_id": game_id, "version_id": str(version_id),
                "start_date": str(start_date) if start_date else None,
                "start_at": str(start_at) if start_at else None,
                "cn_start_date": _date(v.get("cn_start_date") or v.get("cn_start_at")),
                "status": status, "source": v.get("source"), "source_url": v.get("source_url"),
                "cn_source_url": v.get("cn_source_url"), "note": v.get("note"),
            })
    return rows


def pair_rows(config: dict) -> list[dict]:
    return [{
        "pair_id": p["pair_id"], "game_id": p["game_id"], "content_type": p["content_type"],
        "version_id": None if p.get("version_id") is None else str(p["version_id"]),
        "version_confirmed": _flag(p.get("version_confirmed", False)),
        "character_id": p.get("character_id"), "character_name": p.get("character_name"),
        "published_date": _date(p.get("pubdate")),
    } for p in config.get("videos") or []]


VIDEO_COLUMNS = ("platform", "video_id", "game_id", "pair_id", "title", "channel_id", "channel_name", "locale",
                 "published_date", "content_type", "version_id", "version_confirmed", "character_id",
                 "character_name", "identity_verified", "registered")


def video_rows(bilibili: dict, youtube: dict, pairs: dict) -> list[dict]:
    """登记表给出身份与标题，配对表给出精选范围与人工确认的版本归属（配对表优先）。"""
    videos: dict[tuple[str, str], dict] = {}

    accounts = bilibili.get("official_accounts") or {}
    for v in bilibili.get("videos") or []:
        account = accounts.get(v["game_id"]) or {}
        videos[("bilibili", v["bvid"])] = {
            "platform": "bilibili", "video_id": v["bvid"], "game_id": v["game_id"], "pair_id": None,
            "title": v.get("title"), "channel_id": str(account["mid"]) if account.get("mid") else None,
            "channel_name": account.get("name"), "locale": BILIBILI_LOCALE,
            "published_date": _date(v.get("pubdate")), "content_type": v.get("content_type"),
            "version_id": None if v.get("version_id") is None else str(v["version_id"]),
            "version_confirmed": _flag(v.get("version_confirmed", False)),
            "character_id": v.get("character_id"), "character_name": v.get("character_name"),
            "identity_verified": _flag(v.get("is_official_account")),
            "registered": _flag(v.get("active", True)),
        }

    channels = youtube.get("official_channels") or {}
    for v in youtube.get("videos") or []:
        channel = (channels.get(v["game_id"]) or {}).get(v.get("locale")) or {}
        videos[("youtube", v["video_id"])] = {
            "platform": "youtube", "video_id": v["video_id"], "game_id": v["game_id"], "pair_id": None,
            "title": v.get("title"), "channel_id": channel.get("channel_id"), "channel_name": channel.get("title"),
            "locale": v.get("locale"), "published_date": _date(v.get("pubdate")),
            "content_type": v.get("content_type"),
            "version_id": None if v.get("version_id") is None else str(v["version_id"]),
            "version_confirmed": _flag(v.get("version_confirmed", False)),
            "character_id": v.get("character_id"), "character_name": v.get("character_name"),
            "identity_verified": _flag(v.get("is_official_account")),
            "registered": _flag(v.get("active", True)),
        }

    for p in pairs.get("videos") or []:
        members = [("bilibili", p.get("bvid"), BILIBILI_LOCALE)]
        members += [("youtube", vid, locale) for locale, vid in (p.get("youtube") or {}).items()]
        for platform, video_id, locale in members:
            if not video_id:
                continue
            base = videos.get((platform, video_id)) or {
                "platform": platform, "video_id": video_id, "game_id": p["game_id"], "title": None,
                "channel_id": None, "channel_name": None, "identity_verified": None, "registered": 1,
            }
            if base["game_id"] != p["game_id"]:
                raise ValueError(f"video_pairs.yml: {video_id} belongs to {base['game_id']}, not {p['game_id']}")
            base.update({
                "pair_id": p["pair_id"], "locale": locale, "content_type": p["content_type"],
                "version_id": None if p.get("version_id") is None else str(p["version_id"]),
                "version_confirmed": _flag(p.get("version_confirmed", False)),
                "character_id": p.get("character_id"), "character_name": p.get("character_name"),
                "published_date": base.get("published_date") or _date(p.get("pubdate")),
            })
            videos[(platform, video_id)] = base
    return [{c: row.get(c) for c in VIDEO_COLUMNS} for row in videos.values()]


def sync(conn: sqlite3.Connection, config_dir: Path = CONFIG_DIR) -> dict:
    """在一个事务里刷新全部维度表，返回各表行数。"""
    games = game_rows(load_yaml("games.yml", config_dir))
    known = {g["game_id"] for g in games}
    versions = version_rows(load_yaml("versions.yml", config_dir), known)
    pairs_cfg = load_yaml("video_pairs.yml", config_dir)
    pairs = pair_rows(pairs_cfg)
    videos = video_rows(load_yaml("bilibili_videos.yml", config_dir),
                        load_yaml("youtube_videos.yml", config_dir), pairs_cfg)
    unknown = sorted({r["game_id"] for r in pairs + videos} - known)
    if unknown:
        raise ValueError(f"video registry refers to unknown games: {unknown}")

    with db.transaction(conn):
        existing = [r[0] for r in conn.execute("SELECT game_id FROM game")]
        db.upsert(conn, "game", games)
        missing = [gid for gid in existing if gid not in known]
        conn.executemany("UPDATE game SET active = 0 WHERE game_id = ?", [(gid,) for gid in missing])
        conn.execute("DELETE FROM version")
        db.upsert(conn, "version", versions)
        # video.pair_id 引用 video_pair：先解除引用再替换配对表
        conn.execute("UPDATE video SET pair_id = NULL")
        conn.execute("DELETE FROM video_pair")
        db.upsert(conn, "video_pair", pairs)
        conn.execute("UPDATE video SET registered = 0")
        db.upsert(conn, "video", videos)
    return {"game": len(games), "version": len(versions), "video_pair": len(pairs), "video": len(videos)}
