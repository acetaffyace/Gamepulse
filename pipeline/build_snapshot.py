"""把采集到的时间序列组装成 dashboard 可直接读取的快照 JSON。

输出 data/snapshot_{game_id}.json，结构与 data/demo_snapshot.json 一致，
以便同一个页面既能加载示例数据，也能加载真实数据。
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    DATA_DIR,
    get_game,
    load_games,
    load_curated_video_pairs,
    load_yaml,
    read_series,
    today_local,
    write_json,
    youtube_channels,
)
from collectors.steam_build import build_events as build_build_events  # noqa: E402
from pipeline import metrics, quality, review_profile  # noqa: E402

OBSERVED_LABEL = "observed"

# 对比对象的固定配色。看板里颜色代表「对比对象」这个身份，不代表指标，
# 所以色位在这里按游戏分配一次，index.json 带出去给前端直接用，
# 避免前端各自再发明一套。同游戏的不同版本由前端在基色上取深浅。
# 这 5 个色位已通过 validate_palette 的相邻对与全对检查。
SLOT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7", "#e87ba4"]

# 官方公告标题里的版本号，例如 Version 3.2、Ver. 1.3、V2.6
VERSION_PATTERNS = [
    # 覆盖 "Version 1.4"、"Ver. 1.3" 与库洛使用的 "V2.6"
    re.compile(r"\bV(?:er(?:sion)?)?\.?\s*(\d+\.\d+)", re.I),
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
                 videos: dict[str, dict],
                 yt_videos: dict[str, dict] | None = None,
                 build_records: list[dict] | None = None,
                 version_updates: dict[str, dict] | None = None) -> list[dict]:
    events: list[dict] = []
    seen_gids: set[str] = set()
    version_boundaries: dict[str, dict] = {}
    version_updates = version_updates or {}

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
            event = {
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
            }
            if kind == "version_update":
                # 公告发布时间常以 UTC 存储，可能比客户端正式开放日早一天。
                # 对清单中人工核验过的版本，使用该游戏 Steam 区实际更新时间。
                update = version_updates.get(version) or {}
                release_at = update.get("steam_start_at")
                release_date = (release_at[:10] if release_at else
                                update.get("steam_start_date"))
                if release_date:
                    event["announcement_date_local"] = event["date_local"]
                    event["date_local"] = release_date
                    event["source_url"] = (update.get("steam_source_url")
                                           or event["source_url"])
                    event["evidence"] = "manual"
                    if release_at:
                        event["update_at"] = release_at
                # Steam 偶尔会用不同 gid 重复发布同一版本公告；一个版本
                # 只能有一个更新分界线，保留最早的官方日期作为起点。
                previous = version_boundaries.get(version)
                if (previous is None
                        or event["date_local"] < previous["date_local"]):
                    version_boundaries[version] = event
            else:
                events.append(event)

    # 若官方 Steam 新闻流没有收录该公告，仍以清单里的已核验正式开放日
    # 建立边界，避免版本对比窗口因新闻缺项而错位。计划中的未来版本没有
    # Steam 开放日，不会提前成为分界线。
    for version, update in version_updates.items():
        release_at = update.get("steam_start_at")
        release_date = (release_at[:10] if release_at else
                        update.get("steam_start_date"))
        if not release_date or version in version_boundaries:
            continue
        version_boundaries[version] = {
            "date_local": release_date,
            "type": "version_update",
            "label": f"{version} 版本更新",
            "title": f"{version} 版本正式开放（人工核验）",
            "version_id": version,
            "is_version_boundary": True,
            "source": "official_version_schedule",
            "source_url": update.get("steam_source_url"),
            "evidence": "manual",
            **({"update_at": release_at} if release_at else {}),
        }
    events.extend(version_boundaries.values())

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
            "platform": "bilibili",
            "source": "bilibili",
            "source_url": f"https://www.bilibili.com/video/{slot.get('bvid')}/",
            "evidence": "manual",
        })

    # 内容事件：来自 YouTube 官方频道发布日。与 B 站分开标 platform ——
    # 同一支 PV 在两个平台的发布时间常常差几小时到一天，合并会丢掉这个差异。
    #
    # **只取 global 语区。** 同一支 PV 在 4 个语区各发一遍，全部入事件会让
    # 时间轴上每个内容节点重复四次；事件回答的是「什么时候发了这支片子」，
    # 不是「发了几个语言版本」。语区之间的发布节奏差异由按语区分开的
    # video_scatter / video_ramp 轨道回答，那才是能看出差异的地方。
    #
    # 已知取舍：某语区独占的内容（例如日本限定联动）暂不进事件时间轴。
    # 要覆盖它，需要给时间轴加语区筛选，属于前端改动，未在本次范围内。
    for slot in (yt_videos or {}).values():
        if slot.get("locale") not in (None, "global"):
            continue
        label_kind = CONTENT_TYPE_LABEL.get(slot.get("content_type"), "官方视频")
        name = slot.get("character_name") or slot.get("version_id") or ""
        events.append({
            "date_local": slot.get("pubdate"),
            "type": "content",
            "label": f"{name} {label_kind}".strip(),
            "title": slot.get("title"),
            "version_id": slot.get("version_id"),
            "version_confirmed": slot.get("version_confirmed", False),
            "video_id": slot.get("video_id"),
            "locale": slot.get("locale") or "global",
            "platform": "youtube",
            "source": "youtube",
            "source_url": f"https://www.youtube.com/watch?v={slot.get('video_id')}",
            "evidence": "manual",
        })

    # 构建更新事件：来自 SteamCMD 的 public 分支 buildid 变化。
    # 这是独立于公告措辞的第二条版本证据，标 third_party 与官方公告区分。
    events.extend(build_build_events(build_records or []))

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
    youtube = read_series(game_id, "youtube")
    online_hourly = read_series(game_id, "steam_online")
    online_history = read_series(game_id, "steamdb_online")
    builds = read_series(game_id, "steam_build")

    review_history = read_series(game_id, "review_history")
    price_points = metrics.price_series(steam)
    videos = metrics.video_series(bili, platform="bilibili")
    yt_videos = metrics.video_series(youtube, platform="youtube", id_key="video_id")

    # The curated manifest is the source of truth for scope, content type,
    # character, version, and cross-platform pairing. Older collected rows may
    # carry stale or mechanically assigned metadata, so overlay the confirmed
    # mapping before constructing charts and events.
    pairs = load_curated_video_pairs(game_id)
    pair_by_bvid = {p["bvid"]: p for p in pairs}
    pair_by_yt_id = {
        video_id: {**pair, "locale": locale}
        for pair in pairs
        for locale, video_id in (pair.get("youtube") or {}).items()
        if video_id
    }

    def apply_pair_metadata(slot: dict, pair: dict) -> dict:
        return {
            **slot,
            "pair_id": pair.get("pair_id"),
            "character_id": pair.get("character_id"),
            "character_name": pair.get("character_name"),
            "version_id": pair.get("version_id"),
            "version_confirmed": pair.get("version_confirmed", False),
            "content_type": pair.get("content_type"),
        }

    videos = {vid: apply_pair_metadata(slot, pair_by_bvid[vid])
              for vid, slot in videos.items() if vid in pair_by_bvid}
    yt_videos = {
        vid: apply_pair_metadata(slot, pair_by_yt_id[vid])
        for vid, slot in yt_videos.items() if vid in pair_by_yt_id
    }

    # 按语区分组。**刻意不提供跨语区的 videos / totals。**
    # 同一支 PV 在 global/ja/ko/zh-tw 是四个不同的 video_id，合计播放量会把
    # 同一支片子数四遍 —— 那个数不会报错、看着也正常，只是没有任何含义。
    # 跨语区该比的是同一支 PV 在各语区的表现差异（比值与排名），不是求和。
    yt_locales: dict[str, dict] = {}
    for locale, channel in youtube_channels(game_id).items():
        slots = {vid: slot for vid, slot in yt_videos.items()
                 if slot.get("locale") == locale}
        yt_locales[locale] = {
            "channel": channel,
            "videos": list(slots.values()),
            "totals": metrics.video_totals(slots, "youtube"),
        }
    # locale 缺失的视频（注册表漏填）不能静默丢掉 —— 它们不属于任何分组，
    # 按语区取数时会整体消失。把数量摆出来，让它成为一个能被发现的问题。
    yt_unassigned = [s for s in yt_videos.values() if not s.get("locale")]

    issues = quality.check(steam, bili)

    version_updates = ((load_yaml("video_pairs.yml").get("version_updates")
                        or {}).get(game_id) or {})
    events = build_events(news, price_points, videos, yt_videos, builds,
                          version_updates=version_updates)

    # 版本前后对比用官方公告确认的版本更新日做基准。构建号事件不做基准：
    # 一次版本更新会伴随多次热更构建，用它切窗口会把同一个版本切成好几段。
    boundaries = [e for e in events if e.get("is_version_boundary")]
    profile = review_profile.build(game_id, boundaries,
                                   review_history=review_history)

    # SteamDB daily history is a dedicated source: do not append it to
    # steam.jsonl, whose rows also carry review and price snapshots.
    # Keep the project's newer official observation when both sources
    # contain the same date (the CSV can end partway through today).
    online_by_date = {r["date_local"]: r for r in online_history}
    online_by_date.update({r["date_local"]: r for r in steam})

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
            "short_name": game.get("short_name"),
            "developer": game.get("developer"),
            "steam_app_id": game.get("steam_app_id"),
            "steam_status": game.get("steam_status"),
            "region": game.get("region"),
        },
        "coverage": metrics.coverage(steam),
        "online_series": metrics.online_series(
            [online_by_date[d] for d in sorted(online_by_date)]
        ),
        # 小时级采样聚合出的日峰值/谷值/峰谷比。单点日采只能得到
        # 「某一时刻的在线数」，分不出「盘子变大」和「采样撞上高峰」。
        "online_daily": metrics.online_daily(online_hourly),
        "online_hourly": online_hourly[-168:],   # 只带最近 7×24 个采样点进前端
        "review_series": metrics.review_rate_series(steam),
        "new_review_series": metrics.new_review_series(steam),
        # 回填序列：标记 reconstructed
        "review_history": review_history,
        "review_history_coverage": ({
            "start": review_history[0]["date_local"],
            "end": review_history[-1]["date_local"],
            "days": len(review_history),
            "method": "appreviews_backfill",
        } if review_history else None),
        # 玩家结构：评测时长分布、语种构成变化、版本前后对比
        "review_profile": profile,
        "price_series": price_points,
        "build_series": builds,
        "events": events,
        "character_videos": list(videos.values()),
        "bilibili": {
            "videos": list(videos.values()),
            "totals": metrics.video_totals(videos, "bilibili"),
        },
        "youtube": {
            "available": bool(yt_videos),
            # 只有 locales 这一层，没有平级的 videos/totals：
            # 不提供跨语区合计，就不会有人不小心用到它。
            "locales": yt_locales,
            "locale_order": list(yt_locales),
            "unassigned": len(yt_unassigned),
        },
        "quality": {"summary": quality.summarize(issues), "issues": issues},
        "sources": [
            {"name": "Steam 当前在线人数", "label": "observed",
             "url": "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
             "note": "平台同时在线观测值，不是 DAU"},
            {"name": "SteamDB 历史在线人数图表", "label": "third_party",
             "url": f"https://steamdb.info/app/{game.get('steam_app_id')}/charts/",
             "note": "历史日序列来自 SteamDB 图表导出；Players 为日点位，Average Players 保留在原始序列中"},
            {"name": "Steam 评测汇总", "label": "observed",
             "url": f"https://store.steampowered.com/appreviews/{game.get('steam_app_id')}",
             "note": "好评率为派生指标；新增评测为讨论热度代理"},
            {"name": "Steam 官方公告", "label": "observed",
             "url": "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/",
             "note": "版本事件时间节点来源"},
            {"name": "B 站视频公开字段", "label": "observed",
             "url": "https://api.bilibili.com/x/web-interface/view",
             "note": "播放/弹幕/评论/点赞/投币/收藏/分享七项；"
                     "仅登记视频集合，不是全站播放量或独立观众数"},
            {"name": "YouTube 视频公开统计", "label": "observed",
             "url": "https://www.googleapis.com/youtube/v3/videos",
             "note": "观看/点赞/评论三项；点踩数已被平台下线，"
                     "点赞与评论可被创作者隐藏，隐藏时记 null 不记 0"},
            {"name": "Steam 构建号", "label": "third_party",
             "url": "https://api.steamcmd.net/v1/info/",
             "note": "public 分支 buildid 与更新时间；"
                     "第三方镜像，非 Valve 官方源，用作版本公告的旁证"},
            {"name": "Steam 评测明细（玩家结构）", "label": "reconstructed",
             "url": f"https://store.steampowered.com/appreviews/{game.get('steam_app_id')}",
             "note": "评测时游戏时长、评测后游玩时长、语种、购买渠道；"
                     "仅含今天仍存在的评测，且评测者不是玩家的随机样本"},
        ],
    }
    return snapshot


def version_catalog(snapshot: dict) -> list[dict]:
    """版本更新日 → 可作为「对比对象」的版本窗口列表。

    窗口是 [本次更新日, 下次更新日的前一天]，最后一个版本延伸到快照日。
    这样每个版本各占一段互不重叠的区间，用它自己的更新日做 day0 对齐时，
    「3.1 的第 7 天」和「3.2 的第 7 天」才是同一件事。

    同一版本的重复官方公告已在 build_events 中合并，因此这里的唯一键仍取
    更新日期；版本号本身只用于展示，不假设跨游戏唯一。
    """
    bounds = [e for e in snapshot.get("events", [])
              if e.get("is_version_boundary") and e.get("date_local")]
    bounds.sort(key=lambda e: e["date_local"])

    out = []
    for i, ev in enumerate(bounds):
        start = ev["date_local"]
        if i + 1 < len(bounds):
            nxt = bounds[i + 1]["date_local"]
            end = _shift_day(nxt, -1)
            next_version = bounds[i + 1].get("version_id")
        else:
            nxt, next_version = None, None
            end = snapshot["snapshot_date"]
        if end < start:
            # 同一天或相邻天的两条更新公告，窗口会退化成空区间，跳过
            continue
        out.append({
            "key": start,
            "version_id": ev.get("version_id"),
            "date_local": start,
            "end_local": end,
            "days": _days_between(start, end) + 1,
            "next_version": next_version,
            "open_ended": nxt is None,
        })
    return out


def _shift_day(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def _days_between(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 dashboard 快照 JSON")
    parser.add_argument("--game", help="game_id；省略则处理所有 active 游戏")
    args = parser.parse_args()

    game_ids = [args.game] if args.game else [
        g["game_id"] for g in load_games() if g.get("active")]

    index = []
    for slot, game_id in enumerate(game_ids):
        snapshot = build(game_id)
        out = DATA_DIR / f"snapshot_{game_id}.json"
        write_json(out, snapshot)
        cov = snapshot["coverage"]
        summary = snapshot["quality"]["summary"]
        index.append({
            "game_id": game_id,
            "display_name": snapshot["game"]["display_name"],
            "short_name": snapshot["game"].get("short_name")
                          or snapshot["game"]["display_name"],
            "developer": snapshot["game"].get("developer"),
            "color": SLOT_COLORS[slot % len(SLOT_COLORS)],
            "file": out.name,
            "valid_days": cov["valid_days"],
            "review_start": (snapshot.get("review_history_coverage") or {}).get("start"),
            "review_days": (snapshot.get("review_history_coverage") or {}).get("days"),
            "snapshot_date": snapshot["snapshot_date"],
            "versions": version_catalog(snapshot),
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
