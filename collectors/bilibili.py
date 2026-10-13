"""B 站登记视频的公开计数（官方 view 接口，无需登录/Cookie，不调用有风控的搜索接口）。

默认只采 config/video_pairs.yml 精选范围内的视频（--all-registered 采注册表全部 active 视频）。
采集时复核 owner.mid 是否属于登记的官方账号：不一致的（搬运号冒充）不写入，只记在采集记录里。
B 站请求始终直连（见 common.PROXY_HOSTS / DIRECT_HOSTS 的说明）。

    python collectors/bilibili.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    active_games, business_date, get_json, load_curated_video_pairs, load_videos, now_iso, official_mids,
    polite_sleep, run_per_game, save_raw, session, today_local,
)
from store import config_sync, db  # noqa: E402

VIEW_URL = "https://api.bilibili.com/x/web-interface/view"
HEADERS = {"Referer": "https://www.bilibili.com/"}


def fetch_video(sess, bvid: str, official: set[int]) -> tuple[dict | None, str, dict]:
    """返回 (计数与元数据, 失败原因, 原始响应)。身份不符也算失败。"""
    payload, status = get_json(sess, VIEW_URL, {"bvid": bvid}, headers=HEADERS)
    if status != "ok":
        return None, status, payload or {}
    if payload.get("code") != 0:
        return None, f"code={payload.get('code')}:{payload.get('message')}", payload
    data = payload.get("data") or {}
    stat = data.get("stat") or {}
    owner = data.get("owner") or {}
    if official and owner.get("mid") not in official:
        return None, f"owner_mismatch:got={owner.get('mid')}", payload
    if stat.get("view") is None:
        return None, "no_view_count", payload
    return {
        "views": stat.get("view"), "likes": stat.get("like"), "comments": stat.get("reply"),
        "coins": stat.get("coin"), "favorites": stat.get("favorite"), "shares": stat.get("share"),
        "danmaku": stat.get("danmaku"),
        "title": data.get("title"), "channel": owner.get("name"), "pubdate": business_date(data.get("pubdate")),
    }, "", payload


def targets(game_id: str, curated_only: bool) -> list[str]:
    if curated_only:
        return [p["bvid"] for p in load_curated_video_pairs(game_id) if p.get("bvid")]
    return [v["bvid"] for v in load_videos(game_id)]


def collect_one(conn, game: dict, date_local: str, curated_only: bool = True) -> tuple[int, int, str]:
    bvids = targets(game["game_id"], curated_only and game.get("bilibili_curated_only", True))
    if not bvids:
        return 0, 0, "no_registered_videos"
    sess = session()
    official = official_mids(game["game_id"])
    rows, meta, raws, errors = [], [], {}, []
    observed_at = now_iso()
    for bvid in bvids:
        got, err, raw = fetch_video(sess, bvid, official)
        raws[bvid] = raw
        if got is None:
            errors.append(f"{bvid}:{err}")
        else:
            rows.append({"platform": "bilibili", "video_id": bvid, "date": date_local, "observed_at": observed_at,
                         **{k: got[k] for k in ("views", "likes", "comments", "coins", "favorites", "shares", "danmaku")}})
            meta.append((got["title"], got["channel"], bvid))
        polite_sleep()
    save_raw("bilibili", game["game_id"], date_local, raws)
    with db.transaction(conn):
        db.upsert(conn, "video_obs", rows)
        conn.executemany("UPDATE video SET observed_title = ?, observed_channel = ? "
                         "WHERE platform = 'bilibili' AND video_id = ?", meta)
    print(f"  {game['display_name']}: {len(rows)}/{len(bvids)} 个视频采集成功")
    return len(bvids), len(rows), "; ".join(errors[:5])


def run(conn, games: list[dict], date_local: str, curated_only: bool = True) -> bool:
    return run_per_game(conn, "bilibili", games, date_local,
                        lambda c, g, d: collect_one(c, g, d, curated_only))


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 B 站登记视频的公开计数")
    parser.add_argument("--game")
    parser.add_argument("--date", default=today_local())
    parser.add_argument("--all-registered", action="store_true",
                        help="采集注册表全部 active 视频，默认只采 video_pairs.yml 精选范围")
    args = parser.parse_args()
    conn = db.connect()
    try:
        config_sync.sync(conn)   # 视频观测引用视频维表，先确保登记表已同步
        return int(run(conn, active_games(args.game), args.date, curated_only=not args.all_registered))
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
