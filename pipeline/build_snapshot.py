"""把采集到的时间序列组装成 dashboard 可直接读取的快照 JSON。

输出 data/snapshot_{game_id}.json，结构与 data/demo_snapshot.json 一致，
以便同一个页面既能加载示例数据，也能加载真实数据。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    DATA_DIR,
    get_game,
    load_games,
    read_series,
    today_local,
    write_json,
)
from pipeline import metrics, quality  # noqa: E402

OBSERVED_LABEL = "observed"

# 官方公告标题里的版本号，例如 Version 3.2 "Their Secret Histories"
VERSION_PATTERNS = [
    # 覆盖 "Version 1.4" 与完美世界使用的缩写 "Ver. 1.3"
    re.compile(r"\bVer(?:sion)?\.?\s+(\d+\.\d+)", re.I),
    re.compile(r"(\d+\.\d+)\s*版本"),
]

# 同一个版本号会出现在多类公告里，日期相差可达半个月：
#   Special Program Announcement = 前瞻节目预告（绝区零 3.2 为 08-24）
#   Update Announcement          = 版本正式更新（绝区零 3.2 为 09-09）
# 只有后者可以作为版本更新时间标记。
#
# 各发行商措辞不同，需要分别覆盖：
#   米哈游   Version 3.2 "..." Update Announcement
#   库洛     New Content in Wuthering Waves Version 3.6: ...
#   完美世界 Ver. 1.3 "Rising from the Moonlit Fog" Patch Notes
PREVIEW_PATTERNS = [
    re.compile(r"Special\s+Program", re.I),
    re.compile(r"Preview", re.I),
    re.compile(r"前瞻"),
]
UPDATE_PATTERNS = [
    re.compile(r"Update\s+Announcement", re.I),
    re.compile(r"New\s+Content\s+in\b", re.I),
    re.compile(r"Patch\s+Notes", re.I),
    re.compile(r"版本更新"),
    re.compile(r"版本现已|正式上线"),
]

# 只有 Steam 官方社区公告可以生成版本事件。新闻源同时包含第三方媒体
# （CGMagazine、GamingOnLinux 等），其标题同样含版本号，
# 例如「CGMagazine: Wuthering Waves 3.0 Hands-On」——
# 若不过滤会在 2025-12-21 造出一条并不存在的版本竖线。
OFFICIAL_FEEDS = {"steam_community_announcements"}


def is_official_news(item: dict) -> bool:
    feedname = (item.get("feedname") or "").lower()
    if feedname:
        return feedname in OFFICIAL_FEEDS
    # 旧快照没有 feedname 字段，退回按 feedlabel 判断
    return (item.get("feedlabel") or "").lower().startswith("community announce")


def classify_news(title: str) -> tuple[str, str]:
    """返回 (事件类型, 中文标签后缀)。

    前瞻判定必须先于更新判定：「Version 1.4 Preview Special Program」
    同时含 Preview，若先匹配更新规则会把前瞻误标成版本分界线。
    """
    for pattern in PREVIEW_PATTERNS:
        if pattern.search(title or ""):
            return "version_preview", "前瞻节目"
    for pattern in UPDATE_PATTERNS:
        if pattern.search(title or ""):
            return "version_update", "版本更新"
    return "version_news", "官方公告"

CONTENT_TYPE_LABEL = {
    "character_trailer": "角色PV",
    "character_demo": "角色演示",
    "character_ep": "角色EP",
    "version_trailer": "版本PV",
    "season_teaser": "先导PV",
}


def extract_version(title: str) -> str | None:
    for pattern in VERSION_PATTERNS:
        m = pattern.search(title or "")
        if m:
            return m.group(1)
    return None


def build_events(news_records: list[dict], price_points: list[dict],
                 videos: dict[str, dict]) -> list[dict]:
    events: list[dict] = []
    seen_gids: set[str] = set()

    # 版本事件：来自 Steam 官方公告
    for rec in news_records:
        for item in rec.get("items", []):
            gid = item.get("gid")
            if gid in seen_gids:
                continue
            seen_gids.add(gid)
            if not is_official_news(item):
                continue
            title = item.get("title", "")
            version = extract_version(title)
            if not version:
                continue
            kind, suffix = classify_news(title)
            events.append({
                "date_local": item["date_local"],
                "type": kind,
                "label": f"{version} {suffix}",
                "title": title,
                "version_id": version,
                # 只有 version_update 可作为版本分界线，前瞻仅作参考标记
                "is_version_boundary": kind == "version_update",
                "source": "steam_news",
                "source_url": item.get("url"),
                "evidence": OBSERVED_LABEL,
            })

    # 内容事件：来自 B 站官方视频发布日
    for slot in videos.values():
        label_kind = CONTENT_TYPE_LABEL.get(slot.get("content_type"), "官方视频")
        name = slot.get("character_name") or slot.get("version_id") or ""
        events.append({
            "date_local": slot.get("pubdate"),
            "type": "content",
            "label": f"{name} {label_kind}".strip(),
            "title": slot.get("title"),
            "version_id": slot.get("version_id"),
            "version_confirmed": slot.get("version_confirmed", False),
            "bvid": slot.get("bvid"),
            "source": "bilibili",
            "source_url": f"https://www.bilibili.com/video/{slot.get('bvid')}/",
            "evidence": "manual",
        })

    # 折扣事件
    for ev in metrics.discount_events(price_points):
        ev["evidence"] = OBSERVED_LABEL
        ev["label"] = ("折扣开始 " if ev["type"] == "discount_start" else "折扣结束 ") \
            + f"{ev['to_percent']}%"
        events.append(ev)

    events = [e for e in events if e.get("date_local")]
    events.sort(key=lambda e: e["date_local"])
    return events


def build(game_id: str) -> dict:
    game = get_game(game_id)
    steam = read_series(game_id, "steam")
    news = read_series(game_id, "steam_news")
    bili = read_series(game_id, "bilibili")

    review_history = read_series(game_id, "review_history")
    price_points = metrics.price_series(steam)
    videos = metrics.video_view_series(bili)
    issues = quality.check(steam, bili)

    # 回填的评测历史与逐日采集分开存放：前者是 reconstructed（只含今天仍存在
    # 的评测，早期日期偏低），后者是 observed。两者不可混成一条线。
    if review_history:
        issues.append({
            "level": "info", "code": "reconstructed_review_history",
            "message": (f"评测历史由 appreviews 回填重建，覆盖 "
                        f"{review_history[0]['date_local']} → "
                        f"{review_history[-1]['date_local']}（{len(review_history)} 天）。"
                        f"仅含今天仍存在的评测，越早的日期越可能低估。"),
        })

    snapshot = {
        "snapshot_date": today_local(),
        "freshness_status": "live",
        "is_demo": False,
        "game": {
            "game_id": game_id,
            "display_name": game.get("display_name"),
            "steam_app_id": game.get("steam_app_id"),
            "steam_status": game.get("steam_status"),
            "region": game.get("region"),
        },
        "coverage": metrics.coverage(steam),
        "online_series": metrics.online_series(steam),
        "review_series": metrics.review_rate_series(steam),
        "new_review_series": metrics.new_review_series(steam),
        # 回填序列：90 天历史，标记 reconstructed
        "review_history": review_history,
        "review_history_coverage": ({
            "start": review_history[0]["date_local"],
            "end": review_history[-1]["date_local"],
            "days": len(review_history),
            "method": "appreviews_backfill",
        } if review_history else None),
        "price_series": price_points,
        "events": build_events(news, price_points, videos),
        "character_videos": list(videos.values()),
        "quality": {"summary": quality.summarize(issues), "issues": issues},
        "sources": [
            {"name": "Steam 当前在线人数", "label": "observed",
             "url": "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
             "note": "平台同时在线观测值，不是 DAU"},
            {"name": "Steam 评测汇总", "label": "observed",
             "url": f"https://store.steampowered.com/appreviews/{game.get('steam_app_id')}",
             "note": "好评率为派生指标；新增评测为讨论热度代理"},
            {"name": "Steam 官方公告", "label": "observed",
             "url": "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/",
             "note": "版本事件时间节点来源"},
            {"name": "B 站视频公开字段", "label": "observed",
             "url": "https://api.bilibili.com/x/web-interface/view",
             "note": "仅登记视频的播放量，不是全站播放量或独立观众数"},
        ],
    }
    return snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 dashboard 快照 JSON")
    parser.add_argument("--game", help="game_id；省略则处理所有 active 游戏")
    args = parser.parse_args()

    game_ids = [args.game] if args.game else [
        g["game_id"] for g in load_games() if g.get("active")]

    index = []
    for game_id in game_ids:
        snapshot = build(game_id)
        out = DATA_DIR / f"snapshot_{game_id}.json"
        write_json(out, snapshot)
        cov = snapshot["coverage"]
        summary = snapshot["quality"]["summary"]
        index.append({
            "game_id": game_id,
            "display_name": snapshot["game"]["display_name"],
            "file": out.name,
            "valid_days": cov["valid_days"],
        })
        print(f"已生成 {out.name}")
        print(f"  覆盖 : {cov['start']} → {cov['end']}，"
              f"{cov['valid_days']} 天（缺 {cov['missing_days']} 天）")
        print(f"  事件 : {len(snapshot['events'])} 条")
        print(f"  视频 : {len(snapshot['character_videos'])} 个")
        print(f"  质量 : error={summary['error']} warn={summary['warn']} "
              f"info={summary['info']}")
        for issue in snapshot["quality"]["issues"]:
            if issue["level"] in ("error", "warn"):
                print(f"    [{issue['level']}] {issue['message']}")

    write_json(DATA_DIR / "index.json", {"games": index,
                                         "generated_at": today_local()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
