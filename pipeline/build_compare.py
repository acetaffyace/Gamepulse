"""生成多游戏对比数据集。

与单游戏快照的区别：
- 颜色跟随「游戏」这个实体，而不是指标。同一款游戏在所有轨道、所有筛选
  状态下颜色固定，筛掉一款不会让其余重新着色。
- 提供两种对齐方式：
    absolute  同一日历轴（与 SteamDB 一致）
    relative  按各自 Steam 上线后第 N 天对齐，用于比较发行曲线形状
- 共同窗口取各游戏评测历史起点的最大值，避免把「某游戏当时还没上线」
  误读成「数据为 0」。

输出 data/compare.json。
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    DATA_DIR,
    load_games,
    load_videos,
    read_series,
    today_local,
    write_json,
)
from pipeline import metrics  # noqa: E402
from pipeline.build_snapshot import build_events  # noqa: E402

# 分类色位 1/2/3（blue / orange / aqua）。该三色组已通过
# validate_palette.js 的相邻对与全对检查，线图与散点均可安全使用。
SLOT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7", "#e87ba4"]


def _parse(d: str):
    return datetime.strptime(d, "%Y-%m-%d").date()


def collect_game(game: dict, slot: int) -> dict | None:
    gid = game["game_id"]
    hist = read_series(gid, "review_history")
    steam = read_series(gid, "steam")
    news = read_series(gid, "steam_news")
    bili = read_series(gid, "bilibili")

    if not hist:
        return None

    videos = metrics.video_view_series(bili)
    price_points = metrics.price_series(steam)
    events = build_events(news, price_points, videos)
    boundaries = [e for e in events if e.get("is_version_boundary")]

    # 评测历史首日即该游戏 Steam 版实际开始产生评测的日期，
    # 比 games.yml 中人工填写的 steam_release 更可靠。
    observed_start = hist[0]["date_local"]

    online = [{"date_local": r["date_local"], "value": r.get("current_players")}
              for r in steam if r.get("current_players") is not None]

    return {
        "game_id": gid,
        "display_name": game.get("display_name"),
        "short_name": game.get("short_name") or game.get("display_name"),
        "developer": game.get("developer"),
        "color": SLOT_COLORS[slot % len(SLOT_COLORS)],
        "steam_app_id": game.get("steam_app_id"),
        "steam_release_declared": game.get("steam_release"),
        "review_start": observed_start,
        "review_end": hist[-1]["date_local"],
        "review_days": len(hist),
        "total_reviews": hist[-1]["cumulative_reviews"],
        "cumulative_review_rate": hist[-1]["cumulative_review_rate"],
        "new_reviews": [{"d": r["date_local"], "v": r["new_reviews"]} for r in hist],
        "daily_rate": [{"d": r["date_local"], "v": r["daily_review_rate"]} for r in hist],
        "cum_rate": [{"d": r["date_local"], "v": r["cumulative_review_rate"]} for r in hist],
        "online": [{"d": r["date_local"], "v": r["value"]} for r in online],
        "boundaries": [{"d": b["date_local"], "version": b.get("version_id"),
                        "title": b.get("title"), "url": b.get("source_url")}
                       for b in boundaries],
        "videos": [{
            "bvid": v["bvid"], "d": v.get("pubdate"), "v": v.get("latest_view"),
            "title": v.get("title"), "character": v.get("character_name"),
            "content_type": v.get("content_type"),
            "version": v.get("version_id"),
        } for v in videos.values() if v.get("pubdate")],
    }


def add_relative_axis(entry: dict) -> None:
    """为每条序列补上「上线后第 N 天」，用于形状对齐。"""
    start = _parse(entry["review_start"])
    for key in ("new_reviews", "daily_rate", "cum_rate", "online", "videos"):
        for pt in entry[key]:
            if pt.get("d"):
                pt["t"] = (_parse(pt["d"]) - start).days
    for b in entry["boundaries"]:
        b["t"] = (_parse(b["d"]) - start).days


def build(game_ids: list[str] | None = None) -> dict:
    games = [g for g in load_games() if g.get("active")]
    if game_ids:
        games = [g for g in games if g["game_id"] in game_ids]

    entries = []
    for i, game in enumerate(games):
        entry = collect_game(game, i)
        if entry:
            add_relative_axis(entry)
            entries.append(entry)

    if not entries:
        raise SystemExit("没有任何游戏具备评测历史，请先运行 steam_reviews_backfill.py")

    # 共同窗口：所有游戏都已有数据的区间
    common_start = max(e["review_start"] for e in entries)
    common_end = min(e["review_end"] for e in entries)
    common_days = (_parse(common_end) - _parse(common_start)).days + 1

    # 相对轴长度取最长者，由前端的时间范围控件决定实际显示到第几天。
    # 取最短者会把鸣潮 444 天的数据截到 69 天，白白丢弃；曲线长度不同
    # 本身就是事实，图上按各自数据结束即可，不必强行对齐终点。
    relative_days = max(e["review_days"] for e in entries)
    relative_common = min(e["review_days"] for e in entries)

    # 共同窗口内的对比摘要
    summary = []
    for e in entries:
        win = [p for p in e["new_reviews"]
               if common_start <= p["d"] <= common_end]
        rate_win = [p for p in e["daily_rate"]
                    if common_start <= p["d"] <= common_end and p["v"] is not None]
        total = sum(p["v"] for p in win)
        summary.append({
            "game_id": e["game_id"],
            "short_name": e["short_name"],
            "color": e["color"],
            "window_reviews": total,
            "window_daily_avg": round(total / len(win), 1) if win else None,
            "window_rate": round(sum(r["v"] for r in rate_win) / len(rate_win), 2)
                           if rate_win else None,
            "latest_online": e["online"][-1]["v"] if e["online"] else None,
            "videos_in_window": len([v for v in e["videos"]
                                     if v.get("d") and v["d"] >= common_start]),
            "versions_in_window": len([b for b in e["boundaries"]
                                       if b["d"] >= common_start]),
        })

    return {
        "generated_at": today_local(),
        "games": entries,
        "common_window": {"start": common_start, "end": common_end,
                          "days": common_days},
        "relative_days": relative_days,
        "relative_common_days": relative_common,
        "summary": summary,
        "caveats": [
            "评测历史为 appreviews 回填重建，只含今天仍存在的评测，"
            "越早的日期越可能低估当日真实值。",
            "Steam 同时在线人数无法回填，仅有逐日采集点，"
            "三款游戏的在线曲线都需要持续积累。",
            "共同窗口起点取三者评测起点的最大值；窗口之前某些游戏尚未上线，"
            "不代表其数值为 0。",
            "B 站播放量为当前累计值，不是当日播放量；各游戏登记视频数量"
            "不同，总播放量不可直接比较，应看单条视频与发布节奏。",
            "三款游戏上线时间不同，绝对日期对比会把「上线热度」与"
            "「同期表现」混在一起，相对天数视图用于分离这两者。",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成多游戏对比数据集")
    parser.add_argument("--games", nargs="*", help="指定 game_id；省略则全部 active")
    args = parser.parse_args()

    data = build(args.games)
    write_json(DATA_DIR / "compare.json", data)

    w = data["common_window"]
    print(f"已生成 compare.json")
    print(f"  共同窗口 : {w['start']} → {w['end']}（{w['days']} 天）")
    print(f"  相对轴   : 0 → {data['relative_days']} 天")
    print()
    print(f"  {'游戏':<8}{'窗口内评测':>10}{'日均':>8}{'窗口好评率':>11}"
          f"{'当前在线':>10}{'版本':>6}{'视频':>6}")
    for s in data["summary"]:
        print(f"  {s['short_name']:<8}{s['window_reviews']:>10,}"
              f"{s['window_daily_avg']:>8}{s['window_rate']:>10}%"
              f"{s['latest_online']:>10,}{s['versions_in_window']:>6}"
              f"{s['videos_in_window']:>6}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
