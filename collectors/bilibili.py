"""B 站视频公开字段采集器。

只读取 config/bilibili_videos.yml 中人工登记并已核验的 BV 号，
使用官方 view 接口（无需登录/Cookie）。不调用搜索接口，不做全站发现。

采集时复核 owner.mid 是否等于登记的官方账号 mid：
若不一致则标记 owner_mismatch，避免搬运号数据混入官方传播口径。
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
    get_json,
    load_games,
    load_videos,
    log_collection,
    official_mid,
    polite_sleep,
    save_raw,
    session,
    today_local,
    upsert_series,
)

VIEW_URL = "https://api.bilibili.com/x/web-interface/view"
HEADERS = {"Referer": "https://www.bilibili.com/"}


def fetch_video(sess, bvid: str, expected_mid: int | None) -> tuple[dict, dict]:
    payload, status = get_json(sess, VIEW_URL, {"bvid": bvid},
                               headers=HEADERS)
    if status != "ok" or not payload:
        return {"bvid": bvid, "view": None, "status": UNAVAILABLE,
                "note": status}, payload or {}
    if payload.get("code") != 0:
        return {"bvid": bvid, "view": None, "status": UNAVAILABLE,
                "note": f"code={payload.get('code')}:{payload.get('message')}"}, payload

    data = payload.get("data") or {}
    stat = data.get("stat") or {}
    owner = data.get("owner") or {}
    mid = owner.get("mid")

    note = ""
    if expected_mid is not None and mid != expected_mid:
        note = f"owner_mismatch:got={mid},expected={expected_mid}"

    return {
        "bvid": bvid,
        "title": data.get("title"),
        "owner_mid": mid,
        "owner_name": owner.get("name"),
        "pubdate": time.strftime("%Y-%m-%d", time.localtime(data.get("pubdate", 0))),
        "view": stat.get("view"),
        "danmaku": stat.get("danmaku"),
        "reply": stat.get("reply"),
        "like": stat.get("like"),
        "coin": stat.get("coin"),
        "favorite": stat.get("favorite"),
        "share": stat.get("share"),
        "status": OBSERVED,
        "note": note,
    }, payload


def collect_game(game_id: str, date_local: str) -> dict:
    videos = load_videos(game_id)
    if not videos:
        log_collection("bilibili", game_id, date_local, "skipped", "no_active_videos")
        print(f"[skip] {game_id}: bilibili_videos.yml 中没有 active: true 的视频")
        return {}

    sess = session()
    expected_mid = official_mid(game_id)
    results, raws = [], {}

    for entry in videos:
        bvid = entry["bvid"]
        measured, raw = fetch_video(sess, bvid, expected_mid)
        # 合并登记的业务维度（角色、版本、内容类型）
        measured.update({
            "character_id": entry.get("character_id"),
            "character_name": entry.get("character_name"),
            "version_id": entry.get("version_id"),
            "version_confirmed": entry.get("version_confirmed", False),
            "content_type": entry.get("content_type"),
        })
        results.append(measured)
        raws[bvid] = raw

        if measured["status"] == OBSERVED:
            flag = f"  ⚠ {measured['note']}" if measured["note"] else ""
            print(f"  {bvid}  view={measured['view']:>12,}  {measured['title']}{flag}")
        else:
            print(f"  {bvid}  不可用 ({measured['note']})")
        polite_sleep()

    save_raw("bilibili", game_id, date_local, raws)
    record = {"date_local": date_local, "game_id": game_id, "videos": results}
    action = upsert_series(game_id, "bilibili", record)

    ok = sum(1 for r in results if r["status"] == OBSERVED)
    log_collection("bilibili", game_id, date_local, action,
                   f"observed={ok}/{len(results)}")
    print(f"[{action}] {game_id} {date_local}：{ok}/{len(results)} 个视频采集成功")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 B 站登记视频的公开播放数据")
    parser.add_argument("--game", help="game_id；省略则采集所有 active 游戏")
    parser.add_argument("--date", default=today_local(), help="YYYY-MM-DD，默认今天")
    args = parser.parse_args()

    if args.game:
        game_ids = [args.game]
    else:
        game_ids = [g["game_id"] for g in load_games() if g.get("active")]

    for game_id in game_ids:
        collect_game(game_id, args.date)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
