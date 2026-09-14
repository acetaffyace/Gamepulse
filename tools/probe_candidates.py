"""候选游戏 Steam 可用性实测。

不靠记忆断言某款游戏有没有 Steam 版 —— 用 storesearch 查名字拿 appid，
再逐个验证三个必需接口是否真的返回数据：
    GetNumberOfCurrentPlayers  在线人数
    appreviews                 评测汇总（评测量决定回填出的历史长度）
    ISteamNews                 官方公告（版本事件来源）

只有三项都可用、且评测量足够支撑趋势的游戏，才值得加进 games.yml。

用法：
    python tools/probe_candidates.py
    python tools/probe_candidates.py --term "NIKKE"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import get_json, polite_sleep, session  # noqa: E402

SEARCH_URL = "https://store.steampowered.com/api/storesearch/"
PLAYERS_URL = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/"
REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/"

# 候选：长线运营（持续版本更新）的二次元/都市题材游戏。
# 是否真有 Steam 版一律由接口回答，这里只提供搜索词。
CANDIDATES = [
    "NIKKE",
    "Snowbreak",
    "Girls Frontline 2 Exilium",
    "Reverse 1999",
    "Path to Nowhere",
    "Blue Archive",
    "Arknights",
    "Honkai Star Rail",
    "Genshin Impact",
    "Tower of Fantasy",
    "Punishing Gray Raven",
    "Azur Lane",
    "Aether Gazer",
    "Wuthering Waves",
    "Zenless Zone Zero",
    "Neverness to Everness",
]


def search(sess, term: str) -> list[dict]:
    payload, status = get_json(sess, SEARCH_URL,
                               {"term": term, "cc": "cn", "l": "schinese"})
    if status != "ok" or not payload:
        return []
    return payload.get("items", []) or []


def probe_app(sess, appid: int) -> dict:
    out = {"appid": appid}

    payload, status = get_json(sess, PLAYERS_URL, {"appid": appid})
    resp = (payload or {}).get("response") or {}
    out["players"] = resp.get("player_count") if resp.get("result") == 1 else None
    out["players_status"] = "ok" if out["players"] is not None else status
    polite_sleep(0.6)

    payload, status = get_json(sess, REVIEWS_URL.format(appid=appid),
                               {"json": 1, "num_per_page": 0, "language": "all",
                                "purchase_type": "all", "filter": "all"})
    summary = (payload or {}).get("query_summary") or {}
    out["reviews"] = summary.get("total_reviews")
    out["positive"] = summary.get("total_positive")
    out["reviews_status"] = "ok" if out["reviews"] is not None else status
    polite_sleep(0.6)

    payload, status = get_json(sess, NEWS_URL,
                               {"appid": appid, "count": 5, "maxlength": 1})
    items = ((payload or {}).get("appnews") or {}).get("newsitems") or []
    out["news"] = len(items)
    out["news_status"] = "ok" if items else status
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="实测候选游戏的 Steam 接口可用性")
    parser.add_argument("--term", action="append", help="自定义搜索词，可重复")
    args = parser.parse_args()

    terms = args.term or CANDIDATES
    sess = session()

    print(f"{'搜索词':<26} {'appid':>8} {'名称':<34} {'在线':>8} {'评测':>9} "
          f"{'好评率':>7} {'公告':>4}")
    print("-" * 104)

    for term in terms:
        items = search(sess, term)
        polite_sleep(0.8)
        if not items:
            print(f"{term:<26} {'—':>8} {'storesearch 无结果':<34}")
            continue

        item = items[0]
        appid = item.get("id")
        name = (item.get("name") or "")[:32]
        info = probe_app(sess, appid)

        rate = ""
        if info["reviews"] and info["positive"] is not None and info["reviews"] > 0:
            rate = f"{info['positive'] / info['reviews'] * 100:.1f}%"

        players = f"{info['players']:,}" if info["players"] is not None else "×"
        reviews = f"{info['reviews']:,}" if info["reviews"] is not None else "×"
        news = str(info["news"]) if info["news"] else "×"

        print(f"{term:<26} {appid:>8} {name:<34} {players:>8} {reviews:>9} "
              f"{rate:>7} {news:>4}")
        polite_sleep(0.8)

    print()
    print("判读标准：三项都要有值；评测数决定回填出的历史长度，"
          "低于约 2000 条的游戏日粒度曲线会很稀疏。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
