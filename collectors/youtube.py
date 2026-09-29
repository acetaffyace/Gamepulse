"""YouTube 官方频道视频的公开计数（Data API v3 免费层）。

语区（locale）
    每款游戏有 global / ja / ko / zh-tw 等官方频道，同一支 PV 在各频道各发一次，是不同的 video_id。
    统计一律按语区分开（指标目录强制 must_group_by: locale）：把各语区播放量相加等于把同一支片子数好几遍。
身份核验
    返回的 channel_id 必须属于本游戏登记的官方频道，而且就是登记的那个语区；
    不符的（误配的同人号、语区标错）不写入，只记在采集记录里。
配额
    videos.list 一次最多 50 个 ID、1 unit；200 个视频 = 4 units。不使用 search.list（100 units/次）。
字段
    viewCount 是观看次数不是独立观众；likeCount / commentCount 被创作者关闭时接口直接不返回，记 NULL 而不是 0。
    删除、转私密或地区屏蔽的视频 videos.list 直接不返回，要按请求的 ID 反查缺失项。

    python collectors/youtube.py        # 需要 .env 里的 YOUTUBE_API_KEY；没有时跳过并记为未配置
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    active_games, curated_youtube_entries, get_json, load_youtube_videos, now_iso, polite_sleep, proxy_missing_for,
    run_per_game, save_raw, session, today_local, youtube_api_key, youtube_locale_of_channel,
)
from store import config_sync, db  # noqa: E402

VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
BATCH_SIZE = 50

KEY_HELP = """未设置 YOUTUBE_API_KEY，跳过 YouTube 采集。
申请：Google Cloud Console 新建项目 → 启用 YouTube Data API v3 → 创建 API 密钥，
然后写进仓库根目录的 .env（YOUTUBE_API_KEY=…）。密钥不会进入配置文件或数据库。"""


def _int_or_none(value) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None


def fetch_batch(sess, api_key: str, ids: list[str]) -> tuple[dict[str, dict], str, dict]:
    """返回 ({video_id: 结果}, 整批失败原因, 原始响应)。"""
    payload, status = get_json(sess, VIDEOS_URL, {"part": "statistics,snippet", "id": ",".join(ids),
                                                  "key": api_key, "maxResults": BATCH_SIZE}, timeout=30)
    if status != "ok":
        return {}, status, payload or {}
    found = {}
    for item in payload.get("items", []):
        stats, snippet = item.get("statistics") or {}, item.get("snippet") or {}
        found[item["id"]] = {
            "views": _int_or_none(stats.get("viewCount")), "likes": _int_or_none(stats.get("likeCount")),
            "comments": _int_or_none(stats.get("commentCount")), "channel_id": snippet.get("channelId"),
            "channel": snippet.get("channelTitle"), "title": snippet.get("title"),
            "published_at": snippet.get("publishedAt"),
        }
    return found, "", payload


def verify(entry: dict, got: dict, locale_of: dict[str, str]) -> str:
    """身份核验：返回失败原因，通过时返回空字符串。"""
    actual = locale_of.get(got.get("channel_id"))
    if locale_of and not actual:
        return f"channel_not_official:got={got.get('channel_id')}"
    if actual and entry.get("locale") and actual != entry["locale"]:
        return f"locale_mismatch:got={actual},declared={entry['locale']}"
    if got.get("views") is None:
        return "no_view_count"
    return ""


def collect_one(conn, game: dict, date_local: str, api_key: str, curated_only: bool = True) -> tuple[int, int, str]:
    entries = curated_youtube_entries(game["game_id"]) if curated_only else load_youtube_videos(game["game_id"])
    if not entries:
        return 0, 0, "no_registered_videos"
    sess = session()
    locale_of = youtube_locale_of_channel(game["game_id"])
    by_id = {e["video_id"]: e for e in entries}
    ids = list(by_id)
    rows, meta, raws, errors = [], [], {}, []
    observed_at = now_iso()
    for start in range(0, len(ids), BATCH_SIZE):
        chunk = ids[start:start + BATCH_SIZE]
        found, err, raw = fetch_batch(sess, api_key, chunk)
        raws[f"batch_{start // BATCH_SIZE}"] = raw
        if err:
            hint = ";no_proxy_configured" if proxy_missing_for(VIDEOS_URL) else ""
            errors.append(f"batch_{start // BATCH_SIZE}:{err}{hint}")
            continue
        for vid in chunk:
            got = found.get(vid)
            problem = "not_returned_deleted_or_private" if got is None else verify(by_id[vid], got, locale_of)
            if problem:
                errors.append(f"{vid}:{problem}")
                continue
            rows.append({"platform": "youtube", "video_id": vid, "date": date_local, "views": got["views"],
                         "likes": got["likes"], "comments": got["comments"], "coins": None, "favorites": None,
                         "shares": None, "danmaku": None, "observed_at": observed_at})
            meta.append((got["title"], got["channel"], got["published_at"], vid))
        polite_sleep(.5)
    save_raw("youtube", game["game_id"], date_local, raws)
    with db.transaction(conn):
        db.upsert(conn, "video_obs", rows)
        conn.executemany("UPDATE video SET observed_title = ?, observed_channel = ?, published_at = ? "
                         "WHERE platform = 'youtube' AND video_id = ?", meta)
    print(f"  {game['display_name']}: {len(rows)}/{len(ids)} 个视频采集成功，"
          f"配额约 {(len(ids) + BATCH_SIZE - 1) // BATCH_SIZE} units")
    return len(ids), len(rows), "; ".join(errors[:5])


def run(conn, games: list[dict], date_local: str, curated_only: bool = True) -> bool:
    api_key = youtube_api_key()
    if not api_key:
        print(KEY_HELP)
        return run_per_game(conn, "youtube", games, date_local, lambda c, g, d: (0, 0, "not_configured"))
    return run_per_game(conn, "youtube", games, date_local,
                        lambda c, g, d: collect_one(c, g, d, api_key, curated_only))


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 YouTube 官方频道视频的公开计数")
    parser.add_argument("--game")
    parser.add_argument("--date", default=today_local())
    parser.add_argument("--all-registered", action="store_true",
                        help="采集注册表全部 active 视频，默认只采 video_pairs.yml 精选范围")
    args = parser.parse_args()
    conn = db.connect()
    try:
        config_sync.sync(conn)
        return int(run(conn, active_games(args.game), args.date, curated_only=not args.all_registered))
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
