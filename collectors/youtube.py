"""YouTube 视频公开统计采集器（Data API v3，免费层）。

为什么要接 YouTube
------------------
三款游戏的 Steam 评测里简体中文只占 0.2%–1.4%，Steam 侧基本是海外盘；
而 B 站是纯国内盘。只有 Steam + B 站时，传播端与玩家端说的不是同一批人，
任何「视频播放涨了所以在线涨了」的联想都没有人群基础。
YouTube 观众与 Steam 玩家高度同源，接上之后海外盘才有完整的
「传播 → 关注 → 留存」链条。

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
    get_json,
    load_games,
    load_youtube_videos,
    log_collection,
    polite_sleep,
    save_raw,
    session,
    today_local,
    upsert_series,
    youtube_api_key,
    youtube_channel,
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


def collect_game(game_id: str, api_key: str, date_local: str) -> dict:
    videos = load_youtube_videos(game_id)
    if not videos:
        log_collection("youtube", game_id, date_local, "skipped", "no_active_videos")
        print(f"[skip] {game_id}: youtube_videos.yml 中没有 active 视频")
        return {}

    sess = session()
    channel = youtube_channel(game_id)
    expected_channel = channel.get("channel_id")

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

            # 与 B 站的 owner.mid 复核同理：防止登记表指向了搬运频道
            if (expected_channel and measured.get("channel_id")
                    and measured["channel_id"] != expected_channel):
                measured["note"] = (f"channel_mismatch:got={measured['channel_id']},"
                                    f"expected={expected_channel}")

            measured.update({
                "character_id": entry.get("character_id"),
                "character_name": entry.get("character_name"),
                "version_id": entry.get("version_id"),
                "version_confirmed": entry.get("version_confirmed", False),
                "content_type": entry.get("content_type"),
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
    action = upsert_series(game_id, "youtube", record)

    ok = sum(1 for r in results if r["status"] == OBSERVED)
    units = (len(ids) + BATCH_SIZE - 1) // BATCH_SIZE
    log_collection("youtube", game_id, date_local, action,
                   f"observed={ok}/{len(results)};quota_units={units}")
    print(f"[{action}] {game_id} {date_local}：{ok}/{len(results)} 个视频，"
          f"消耗配额 {units} units")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 YouTube 登记视频的公开统计")
    parser.add_argument("--game", help="game_id；省略则采集所有 active 游戏")
    parser.add_argument("--date", default=today_local())
    args = parser.parse_args()

    api_key = youtube_api_key()
    if not api_key:
        print(KEY_HELP)
        return 0  # 可选数据源缺失不应让每日链路失败

    game_ids = [args.game] if args.game else [
        g["game_id"] for g in load_games() if g.get("active")]

    for game_id in game_ids:
        collect_game(game_id, api_key, args.date)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
