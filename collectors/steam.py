"""Steam 官方每日汇总：总评测数、全局好评、采集时刻的在线人数、官方公告。

实测可用性（2026-09-14）：
  GetNumberOfCurrentPlayers  可用（采集时刻的瞬时值，只作参考；可比的在线口径是 SteamDB 日均）
  appreviews                 可用（num_per_page=0 只取 query_summary）
  ISteamNews/GetNewsForApp   可用
  appdetails                 三款游戏都返回 success:false，价格永久不可用，v3 不再采集

写入 steam_daily 时只写这次真正取到的字段：某个字段这次失败，就不传这一列，
当天早些时候已采到的值保持不变；拿到了但接口隐藏的值写 NULL。

    python collectors/steam.py
    python collectors/steam.py --game zenless_zone_zero
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    active_games, business_date, get_json, now_iso, polite_sleep, run_per_game, save_raw, session, today_local,
)
from store import db, news  # noqa: E402

PLAYERS_URL = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/"
REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/"


def fetch_players(sess, appid: int) -> tuple[dict | None, str, dict]:
    """返回 (字段, 失败原因, 原始响应)。失败时字段为 None。"""
    payload, status = get_json(sess, PLAYERS_URL, {"appid": appid})
    if status != "ok":
        return None, status, payload or {}
    resp = payload.get("response") or {}
    if resp.get("result") != 1 or "player_count" not in resp:
        return None, f"players_result={resp.get('result')}", payload
    return {"current_players": int(resp["player_count"])}, "", payload


def fetch_reviews(sess, appid: int) -> tuple[dict | None, str, dict]:
    params = {"json": 1, "num_per_page": 0, "language": "all", "purchase_type": "all", "filter": "all"}
    payload, status = get_json(sess, REVIEWS_URL.format(appid=appid), params)
    if status != "ok":
        return None, status, payload or {}
    if payload.get("success") != 1:
        return None, f"reviews_success={payload.get('success')}", payload
    summary = payload.get("query_summary") or {}
    if summary.get("total_reviews") is None:
        return None, "missing_query_summary", payload
    return {"total_reviews": int(summary["total_reviews"]),
            "total_positive": int(summary["total_positive"]) if summary.get("total_positive") is not None else None,
            "review_score_desc": summary.get("review_score_desc")}, "", payload


def fetch_news(sess, appid: int, count: int = 50) -> tuple[list[dict] | None, str, dict]:
    payload, status = get_json(sess, NEWS_URL, {"appid": appid, "count": count, "maxlength": 300})
    if status != "ok":
        return None, status, payload or {}
    items = (payload.get("appnews") or {}).get("newsitems") or []
    return items, "", payload


def news_rows(game_id: str, items: list[dict], observed_at: str) -> list[dict]:
    rows = []
    for item in items:
        if not item.get("gid") or not item.get("date"):
            continue
        rows.append({
            "game_id": game_id, "gid": str(item["gid"]), "date": business_date(item["date"]),
            "published_at": item["date"], "title": item.get("title"), "url": item.get("url"),
            "feed_label": item.get("feedlabel"), "feed_name": item.get("feedname"),
            # 新闻源混有第三方媒体转载，只有官方公告能生成版本事件
            "is_official": int(news.is_official(item.get("feedname"), item.get("feedlabel"))),
            "observed_at": observed_at,
        })
    return rows


def collect_one(conn, game: dict, date_local: str) -> tuple[int, int, str]:
    appid = game.get("steam_app_id")
    if not appid:
        return 0, 0, "no_steam_app_id"
    sess = session()
    players, players_err, raw_players = fetch_players(sess, appid)
    polite_sleep()
    reviews, reviews_err, raw_reviews = fetch_reviews(sess, appid)
    polite_sleep()
    items, news_err, raw_news = fetch_news(sess, appid)
    save_raw("steam", game["game_id"], date_local, {"players": raw_players, "reviews": raw_reviews, "news": raw_news})

    observed_at = now_iso()
    fields = {**(players or {}), **(reviews or {})}
    with db.transaction(conn):
        if fields:
            db.upsert(conn, "steam_daily", [{"game_id": game["game_id"], "date": date_local, **fields,
                                             "observed_at": observed_at}])
        if items:
            db.upsert(conn, "steam_news", news_rows(game["game_id"], items, observed_at))

    succeeded = int(players is not None) + int(reviews is not None)
    detail = ";".join(e for e in (players_err, reviews_err, f"news:{news_err}" if news_err else "") if e)
    print(f"  {game['display_name']}: 在线 {fields.get('current_players', '—')}，"
          f"总评测 {fields.get('total_reviews', '—')}，公告 {len(items) if items is not None else '失败'}")
    return 2, succeeded, detail


def run(conn, games: list[dict], date_local: str) -> bool:
    return run_per_game(conn, "steam", games, date_local, collect_one)


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 Steam 官方每日汇总")
    parser.add_argument("--game")
    parser.add_argument("--date", default=today_local())
    args = parser.parse_args()
    conn = db.connect()
    try:
        return int(run(conn, active_games(args.game), args.date))
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
