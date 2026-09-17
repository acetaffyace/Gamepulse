"""YouTube 视频公开统计采集器（Data API v3，免费层）。

为什么要接 YouTube
------------------
三款游戏的 Steam 评测里简体中文只占 0.2%–1.4%，Steam 侧基本是海外盘；
而 B 站是纯国内盘。只有 Steam + B 站时，传播端与玩家端说的不是同一批人，
任何「视频播放涨了所以在线涨了」的联想都没有人群基础。
YouTube 观众与 Steam 玩家高度同源，接上之后海外盘才有完整的
「传播 → 关注 → 留存」链条。

语区（locale）
--------------
每款游戏有 global/ja/ko/zh-tw 四个官方频道。同一支 PV 在四个频道各发一遍，
是四个不同的 video_id。因此每条记录都带 locale，统计一律按语区分开 ——
把四个语区的播放量相加等于把同一支片子数四遍，得到的数看着正常，但无意义。
跨语区要比的是同一支 PV 的表现差异（比值），不是求和。

配额
----
免费层每天 10,000 units，本采集器的用法：
    videos.list?part=statistics,snippet  1 unit / 次，一次最多 50 个视频 ID
因此 200 个视频 = 4 次调用 = 4 units。**不使用 search.list**（100 units/次），
视频发现走频道的 uploads 播放列表（同样 1 unit），见 youtube_discover.py。

字段口径
--------
- viewCount    观看次数，不是独立观众数；
- likeCount    创作者可以隐藏，隐藏时字段缺失 —— 记 None 而不是 0；
- commentCount 关闭评论时字段缺失，同样记 None；
- 点踩数已于 2021 年被 YouTube 下线，任何声称有该数据的来源都是估算，不采。

删除、转私密或被地区屏蔽的视频，videos.list 会**直接不返回该条目**而不是报错，
因此必须按请求的 ID 集合反查缺失项并标记 unavailable，否则会静默漏采。

用法：
    set YOUTUBE_API_KEY=...        (PowerShell: $env:YOUTUBE_API_KEY="...")
    python collectors/youtube.py
    python collectors/youtube.py --game zenless_zone_zero
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    OBSERVED,
    UNAVAILABLE,
    curated_youtube_entries,
    get_json,
    load_games,
    load_youtube_videos,
    log_collection,
    polite_sleep,
    save_raw,
    session,
    today_local,
    upsert_series,
    upsert_video_subset_series,
    youtube_api_key,
    youtube_locale_of_channel,
)

VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
BATCH_SIZE = 50  # API 硬上限：一次 videos.list 最多 50 个 ID

KEY_HELP = """未设置 YOUTUBE_API_KEY，跳过 YouTube 采集。

申请步骤（免费，无需绑卡）：
  1. https://console.cloud.google.com/ 新建项目
  2. 「API 和服务」→ 启用「YouTube Data API v3」
  3. 「凭据」→ 创建 API 密钥
  4. 设置环境变量后重新运行：
       PowerShell   $env:YOUTUBE_API_KEY="你的密钥"
       永久生效      setx YOUTUBE_API_KEY "你的密钥"

密钥只从环境变量读取，不会写进配置文件或数据文件。"""


def _int_or_none(value) -> int | None:
    """统计字段在 API 里是字符串；字段缺失时返回 None 而不是 0。

    likeCount / commentCount 被创作者关闭时接口直接不返回该键，
    用 0 代替会让「关闭了点赞」看起来像「没有人点赞」。
    """
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def fetch_batch(sess, api_key: str, video_ids: list[str]) -> tuple[dict, dict]:
    """返回 ({video_id: 统计字段}, raw)。"""
    payload, status = get_json(sess, VIDEOS_URL, {
        "part": "statistics,snippet",
        "id": ",".join(video_ids),
        "key": api_key,
        "maxResults": BATCH_SIZE,
    }, timeout=30)

    if status != "ok" or not payload:
        return {vid: {"status": UNAVAILABLE, "note": status} for vid in video_ids}, \
               payload or {}

    if "error" in payload:
        err = payload["error"]
        note = f"api_error:{err.get('code')}:{(err.get('errors') or [{}])[0].get('reason')}"
        return {vid: {"status": UNAVAILABLE, "note": note} for vid in video_ids}, payload

    found: dict[str, dict] = {}
    for item in payload.get("items", []):
        stats = item.get("statistics") or {}
        snippet = item.get("snippet") or {}
        found[item["id"]] = {
            "title": snippet.get("title"),
            "channel_id": snippet.get("channelId"),
            "channel_title": snippet.get("channelTitle"),
            "pubdate": (snippet.get("publishedAt") or "")[:10] or None,
            "view": _int_or_none(stats.get("viewCount")),
            "like": _int_or_none(stats.get("likeCount")),
            "comment": _int_or_none(stats.get("commentCount")),
            "status": OBSERVED,
            "note": "",
        }

    # 请求了但没返回的 = 已删除 / 转私密 / 地区屏蔽
    for vid in video_ids:
        if vid not in found:
            found[vid] = {"status": UNAVAILABLE,
                          "note": "not_returned_deleted_or_private"}
    return found, payload


def collect_game(game_id: str, api_key: str, date_local: str,
                 curated_only: bool = True) -> dict:
    videos = (curated_youtube_entries(game_id) if curated_only
              else load_youtube_videos(game_id))
    if not videos:
        reason = "no_curated_videos" if curated_only else "no_active_videos"
        log_collection("youtube", game_id, date_local, "skipped", reason)
        print(f"[skip] {game_id}: 没有可采集的 YouTube 视频")
        return {}

    sess = session()
    # channel_id → locale。比「是不是本游戏的频道」更严一层：
    # 日语频道的视频被误标成 global 时，两个 channel_id 都在本游戏白名单里，
    # 单纯的归属校验发现不了，但语区归属校验能。
    locale_of = youtube_locale_of_channel(game_id)

    results: list[dict] = []
    raws: dict[str, dict] = {}
    ids = [v["video_id"] for v in videos]
    by_id = {v["video_id"]: v for v in videos}

    for start in range(0, len(ids), BATCH_SIZE):
        chunk = ids[start:start + BATCH_SIZE]
        fetched, raw = fetch_batch(sess, api_key, chunk)
        raws[f"batch_{start // BATCH_SIZE}"] = raw

        for vid in chunk:
            measured = {"video_id": vid, **fetched[vid]}
            entry = by_id[vid]

            # 与 B 站的 owner.mid 复核同理：防止登记表指向了搬运频道。
            # 多语区下分两种错法，必须分开报，因为处理方式不同：
            #   channel_not_official —— 采到的频道根本不属于本游戏（配错 handle）
            #   locale_mismatch      —— 频道属于本游戏，但不是登记的那个语区
            #                           （多为 --append 时 locale 落错）
            declared = entry.get("locale")
            actual_cid = measured.get("channel_id")
            actual_locale = locale_of.get(actual_cid) if actual_cid else None

            if actual_cid and locale_of and not actual_locale:
                measured["note"] = f"channel_not_official:got={actual_cid}"
            elif actual_locale and declared and actual_locale != declared:
                measured["note"] = (f"locale_mismatch:got={actual_locale},"
                                    f"declared={declared}")

            measured.update({
                # 以登记值为准，缺失时用接口反查出的语区兜底 ——
                # 留空会让这条视频在按语区分组时掉出所有分组，静默消失。
                "locale": declared or actual_locale,
                "character_id": entry.get("character_id"),
                "character_name": entry.get("character_name"),
                "version_id": entry.get("version_id"),
                "version_confirmed": entry.get("version_confirmed", False),
                "content_type": entry.get("content_type"),
                "pair_id": entry.get("pair_id"),
            })
            results.append(measured)

            if measured["status"] == OBSERVED:
                flag = f"  ⚠ {measured['note']}" if measured["note"] else ""
                print(f"  {vid}  view={measured['view'] or 0:>12,}  "
                      f"{(measured['title'] or '')[:40]}{flag}")
            else:
                print(f"  {vid}  不可用 ({measured['note']})")
        polite_sleep(0.5)

    save_raw("youtube", game_id, date_local, raws)
    record = {"date_local": date_local, "game_id": game_id, "videos": results}
    action = (upsert_video_subset_series(game_id, "youtube", record, "video_id")
              if curated_only else upsert_series(game_id, "youtube", record))

    ok = sum(1 for r in results if r["status"] == OBSERVED)
    units = (len(ids) + BATCH_SIZE - 1) // BATCH_SIZE

    # 按语区分别计数。合计数字掩盖不了的问题它掩盖得了：某个语区整体采空
    # （频道改名、handle 失效）在总数里只是「少了几十条」，按语区看才是
    # 「ja 这一栏是 0」。
    by_locale: dict[str, list[int]] = {}
    for r in results:
        bucket = by_locale.setdefault(r.get("locale") or "?", [0, 0])
        bucket[1] += 1
        if r["status"] == OBSERVED:
            bucket[0] += 1
    locale_detail = " ".join(f"{loc}={n[0]}/{n[1]}"
                             for loc, n in sorted(by_locale.items()))
    flagged = sum(1 for r in results if r.get("note", "").startswith(
        ("channel_not_official", "locale_mismatch")))

    log_collection("youtube", game_id, date_local, action,
                   f"observed={ok}/{len(results)};by_locale={locale_detail};"
                   f"flagged={flagged};quota_units={units};"
                   f"curated_only={curated_only}")
    print(f"[{action}] {game_id} {date_local}：{ok}/{len(results)} 个视频"
          f"（{locale_detail}），消耗配额 {units} units")
    if flagged:
        print(f"  ⚠ {flagged} 条存在频道/语区归属问题，见上方标注")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 YouTube 登记视频的公开统计")
    parser.add_argument("--game", help="game_id；省略则采集所有 active 游戏")
    parser.add_argument("--date", default=today_local())
    parser.add_argument("--all-registered", action="store_true",
                        help="采集注册表全部 active 视频，默认只采 video_pairs.yml 白名单")
    args = parser.parse_args()

    api_key = youtube_api_key()
    if not api_key:
        print(KEY_HELP)
        return 0  # 可选数据源缺失不应让每日链路失败

    game_ids = [args.game] if args.game else [
        g["game_id"] for g in load_games() if g.get("active")]

    for game_id in game_ids:
        collect_game(game_id, api_key, args.date,
                     curated_only=not args.all_registered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
