"""Steam 公开数据采集器。

实测可用性（2026-09-14，appid 4162040 绝区零）：
  GetNumberOfCurrentPlayers  可用
  appreviews                 可用（num_per_page=0 只取 query_summary）
  ISteamNews/GetNewsForApp   可用
  appdetails                 返回 {"success": false}，价格字段拿不到
  storesearch                可用，作为名称/是否免费的兜底判断

价格不可用时写 null + unavailable，不用 0 代替。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    OBSERVED,
    UNAVAILABLE,
    get_game,
    get_json,
    load_games,
    log_collection,
    polite_sleep,
    save_raw,
    session,
    today_local,
    upsert_series,
)

PLAYERS_URL = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/"
REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
DETAILS_URL = "https://store.steampowered.com/api/appdetails"
SEARCH_URL = "https://store.steampowered.com/api/storesearch/"
NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/"


def fetch_players(sess, appid: int) -> tuple[dict, dict]:
    payload, status = get_json(sess, PLAYERS_URL, {"appid": appid})
    if status != "ok" or not payload:
        return {"current_players": None, "current_players_status": UNAVAILABLE,
                "current_players_note": status}, {}
    resp = payload.get("response") or {}
    if resp.get("result") != 1 or "player_count" not in resp:
        return {"current_players": None, "current_players_status": UNAVAILABLE,
                "current_players_note": f"result={resp.get('result')}"}, payload
    return {"current_players": int(resp["player_count"]),
            "current_players_status": OBSERVED,
            "current_players_note": ""}, payload


def fetch_reviews(sess, appid: int) -> tuple[dict, dict]:
    params = {"json": 1, "num_per_page": 0, "language": "all",
              "purchase_type": "all", "filter": "all"}
    payload, status = get_json(sess, REVIEWS_URL.format(appid=appid), params)
    if status != "ok" or not payload or payload.get("success") != 1:
        return {"total_reviews": None, "total_positive": None, "total_negative": None,
                "review_score_desc": None, "reviews_status": UNAVAILABLE,
                "reviews_note": status}, payload or {}
    summary = payload.get("query_summary") or {}
    total = summary.get("total_reviews")
    if total is None:
        return {"total_reviews": None, "total_positive": None, "total_negative": None,
                "review_score_desc": None, "reviews_status": UNAVAILABLE,
                "reviews_note": "missing_query_summary"}, payload
    return {"total_reviews": int(total),
            "total_positive": int(summary.get("total_positive", 0)),
            "total_negative": int(summary.get("total_negative", 0)),
            "review_score_desc": summary.get("review_score_desc"),
            "reviews_status": OBSERVED,
            "reviews_note": ""}, payload


def fetch_price(sess, appid: int, cc: str, lang: str) -> tuple[dict, dict]:
    """appdetails 优先；失败时用 storesearch 判断是否免费。

    storesearch 条目缺少 price 字段通常代表免费游戏，但这是推断而非直接读数，
    因此标记为 unavailable + note，不写成确定价格。
    """
    payload, status = get_json(sess, DETAILS_URL,
                               {"appids": appid, "cc": cc, "l": lang})
    entry = (payload or {}).get(str(appid)) or {}
    if status == "ok" and entry.get("success"):
        data = entry.get("data") or {}
        if data.get("is_free"):
            return {"is_free": True, "price_final": None, "price_initial": None,
                    "discount_percent": None, "price_status": OBSERVED,
                    "price_note": "is_free"}, payload
        po = data.get("price_overview") or {}
        if po:
            return {"is_free": False,
                    "price_final": po.get("final"),
                    "price_initial": po.get("initial"),
                    "discount_percent": po.get("discount_percent"),
                    "price_status": OBSERVED,
                    "price_note": po.get("currency", "")}, payload
        return {"is_free": None, "price_final": None, "price_initial": None,
                "discount_percent": None, "price_status": UNAVAILABLE,
                "price_note": "no_price_overview"}, payload

    # appdetails 不可用，退回 storesearch
    polite_sleep(0.8)
    search, s_status = get_json(sess, SEARCH_URL, {"term": appid, "cc": cc, "l": lang})
    if s_status == "ok" and search:
        for item in search.get("items", []):
            if item.get("id") == appid:
                if "price" not in item:
                    return {"is_free": None, "price_final": None, "price_initial": None,
                            "discount_percent": None, "price_status": UNAVAILABLE,
                            "price_note": "appdetails_unavailable;storesearch_no_price_field"}, \
                           {"appdetails": payload, "storesearch": search}
                price = item["price"]
                return {"is_free": False,
                        "price_final": price.get("final"),
                        "price_initial": price.get("initial"),
                        "discount_percent": None,
                        "price_status": OBSERVED,
                        "price_note": "from_storesearch"}, \
                       {"appdetails": payload, "storesearch": search}
    return {"is_free": None, "price_final": None, "price_initial": None,
            "discount_percent": None, "price_status": UNAVAILABLE,
            "price_note": f"appdetails={status};storesearch={s_status}"}, \
           {"appdetails": payload, "storesearch": search}


def fetch_news(sess, appid: int, count: int = 50) -> tuple[list[dict], dict]:
    payload, status = get_json(sess, NEWS_URL,
                               {"appid": appid, "count": count, "maxlength": 300})
    if status != "ok" or not payload:
        return [], payload or {}
    items = ((payload.get("appnews") or {}).get("newsitems")) or []
    news = []
    for item in items:
        news.append({
            "gid": item.get("gid"),
            "title": item.get("title"),
            "url": item.get("url"),
            "author": item.get("author"),
            "feedlabel": item.get("feedlabel"),
            # feedname 用于区分官方公告与第三方媒体转载。新闻源里混有
            # CGMagazine、GamingOnLinux 等外部条目，它们的标题同样含版本号，
            # 若不过滤会生成错误的版本事件。
            "feedname": item.get("feedname"),
            "date_local": time.strftime("%Y-%m-%d", time.localtime(item.get("date", 0))),
            "timestamp": item.get("date"),
        })
    return news, payload


def collect_game(game: dict, date_local: str) -> dict:
    game_id = game["game_id"]
    appid = game.get("steam_app_id")
    if not appid:
        log_collection("steam", game_id, date_local, "skipped", "no_steam_app_id")
        print(f"[skip] {game_id}: games.yml 未配置 steam_app_id")
        return {}

    sess = session()
    record: dict = {"date_local": date_local, "game_id": game_id, "steam_app_id": appid}

    players, raw_players = fetch_players(sess, appid)
    record.update(players)
    polite_sleep()

    reviews, raw_reviews = fetch_reviews(sess, appid)
    record.update(reviews)
    polite_sleep()

    price, raw_price = fetch_price(sess, appid,
                                   game.get("region", "cn").lower(),
                                   "schinese")
    record.update(price)
    polite_sleep()

    news, raw_news = fetch_news(sess, appid)
    record["news_count"] = len(news)
    record["news_status"] = OBSERVED if news else UNAVAILABLE

    save_raw("steam", game_id, date_local, {
        "players": raw_players, "reviews": raw_reviews,
        "price": raw_price, "news": raw_news,
    })

    action = upsert_series(game_id, "steam", record)
    upsert_series(game_id, "steam_news", {"date_local": date_local, "items": news})

    ok_fields = sum(1 for k in ("current_players_status", "reviews_status", "price_status")
                    if record.get(k) == OBSERVED)
    log_collection("steam", game_id, date_local, action,
                   f"observed_fields={ok_fields}/3;news={len(news)}")

    print(f"[{action}] {game_id} {date_local}")
    print(f"  在线      : {record['current_players']} ({record['current_players_status']})")
    if record["total_reviews"]:
        rate = record["total_positive"] / record["total_reviews"] * 100
        print(f"  评测      : {record['total_reviews']:,} 条，好评率 {rate:.2f}% "
              f"({record['review_score_desc']})")
    else:
        print(f"  评测      : 不可用 ({record['reviews_note']})")
    print(f"  价格      : {record['price_status']} — {record['price_note']}")
    print(f"  公告      : {len(news)} 条")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 Steam 公开数据快照")
    parser.add_argument("--game", help="game_id；省略则采集所有 active 游戏")
    parser.add_argument("--date", default=today_local(), help="YYYY-MM-DD，默认今天")
    args = parser.parse_args()

    if args.game:
        games = [get_game(args.game)]
    else:
        games = [g for g in load_games() if g.get("active")]

    if not games:
        print("没有可采集的游戏：games.yml 中没有 active: true 的条目")
        return 1

    for game in games:
        collect_game(game, args.date)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
