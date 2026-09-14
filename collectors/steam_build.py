"""Steam 版本构建号采集器（SteamCMD 公开镜像）。

为什么需要它
------------
现有的版本事件全部靠解析官方公告标题，而三家发行商的措辞完全不同
（Update Announcement / New Content in / Patch Notes），漏一种就整家漏掉，
公告延迟发布或标题不含版本号时也会漏。

构建号是另一条独立证据：public 分支的 buildid 一变，说明客户端真的更新了，
这与公告怎么写无关。两条证据对上，版本竖线才可信；对不上，说明有一方漏了，
这本身就是需要在看板上标出来的事情。

实测（2026-09-14）：
    api.steamcmd.net/v1/info/4162040 → buildid 24927009, timeupdated 2026-09-09 06:06
    与公告解析出的绝区零 3.2 版本日 2026-09-09 吻合。

注意：SteamCMD 镜像是第三方站点，不是 Valve 官方源，因此这里产生的事件
统一标 third_party，与来自官方公告的 observed 事件区分开。

用法：
    python collectors/steam_build.py
    python collectors/steam_build.py --game zenless_zone_zero
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
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

INFO_URL = "https://api.steamcmd.net/v1/info/{appid}"
THIRD_PARTY = "third_party"


def fetch_build(sess, appid: int) -> tuple[dict, dict]:
    payload, status = get_json(sess, INFO_URL.format(appid=appid), timeout=30)
    if status != "ok" or not payload or payload.get("status") != "success":
        return {"buildid": None, "build_updated_at": None,
                "build_status": UNAVAILABLE,
                "build_note": status if status != "ok" else
                f"status={(payload or {}).get('status')}"}, payload or {}

    data = (payload.get("data") or {}).get(str(appid)) or {}
    branches = (data.get("depots") or {}).get("branches") or {}
    public = branches.get("public") or {}
    buildid = public.get("buildid")
    updated = public.get("timeupdated")

    if not buildid:
        return {"buildid": None, "build_updated_at": None,
                "build_status": UNAVAILABLE,
                "build_note": "no_public_branch"}, payload

    updated_iso = None
    updated_date = None
    if updated:
        dt = datetime.fromtimestamp(int(updated))
        updated_iso = dt.isoformat(timespec="seconds")
        updated_date = dt.strftime("%Y-%m-%d")

    return {
        "buildid": str(buildid),
        "build_updated_at": updated_iso,
        "build_updated_date": updated_date,
        "build_name": (data.get("common") or {}).get("name"),
        "build_status": THIRD_PARTY,
        "build_note": "",
    }, payload


def collect_game(game: dict, date_local: str) -> dict:
    game_id = game["game_id"]
    appid = game.get("steam_app_id")
    if not appid:
        log_collection("steam_build", game_id, date_local, "skipped", "no_steam_app_id")
        return {}

    sess = session()
    build, raw = fetch_build(sess, appid)
    record = {"date_local": date_local, "game_id": game_id,
              "steam_app_id": appid, **build}

    save_raw("steam_build", game_id, date_local, raw)
    action = upsert_series(game_id, "steam_build", record)
    log_collection("steam_build", game_id, date_local, action,
                   f"buildid={build.get('buildid')};"
                   f"updated={build.get('build_updated_date')}")

    print(f"  [{action}] {game['display_name']:<8} buildid={build.get('buildid')} "
          f"构建更新于 {build.get('build_updated_date') or '不可用'}")
    return record


def build_events(build_records: list[dict]) -> list[dict]:
    """buildid 发生变化即产生一条构建更新事件。

    事件日期用 timeupdated（客户端真正更新的时刻），不是发现变化的采集日 ——
    采集可能晚于更新若干天，用采集日会把竖线画歪。
    """
    events: list[dict] = []
    prev_build = None
    seen_dates: set[str] = set()

    for rec in sorted(build_records, key=lambda r: r["date_local"]):
        buildid = rec.get("buildid")
        if not buildid:
            continue
        updated_date = rec.get("build_updated_date")
        if prev_build is not None and buildid != prev_build and updated_date:
            if updated_date not in seen_dates:
                seen_dates.add(updated_date)
                events.append({
                    "date_local": updated_date,
                    "type": "build_update",
                    "label": f"构建 {buildid}",
                    "title": f"public 分支构建号 {prev_build} → {buildid}",
                    "buildid": buildid,
                    "previous_buildid": prev_build,
                    "source": "steamcmd",
                    "source_url": f"https://api.steamcmd.net/v1/info/{rec['steam_app_id']}",
                    "evidence": THIRD_PARTY,
                })
        prev_build = buildid

    return events


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 Steam public 分支构建号")
    parser.add_argument("--game")
    parser.add_argument("--date", default=today_local())
    args = parser.parse_args()

    games = [get_game(args.game)] if args.game else [
        g for g in load_games() if g.get("active")]

    ok = 0
    for game in games:
        record = collect_game(game, args.date)
        if record.get("buildid"):
            ok += 1
        polite_sleep(1.0)

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
