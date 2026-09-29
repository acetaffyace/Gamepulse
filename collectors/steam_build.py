"""Steam public 分支构建号（SteamCMD 公开镜像 api.steamcmd.net）。

构建号是版本更新的独立证据：public 分支的 buildid 一变，说明客户端真的更新了，
与公告怎么写无关。它和版本表、官方公告对照，能发现漏登记的版本。
SteamCMD 镜像是第三方站点，不是 Valve 官方源（fact_source 里登记为 third_party）。

实测（2026-09-14）：api.steamcmd.net/v1/info/4162040 → buildid 24927009，
timeupdated 2026-09-09 06:06，与绝区零 3.2 的版本日吻合。

    python collectors/steam_build.py
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    BUSINESS_TZ, active_games, get_json, now_iso, polite_sleep, run_per_game, save_raw, session, today_local,
)
from store import db  # noqa: E402

INFO_URL = "https://api.steamcmd.net/v1/info/{appid}"


def fetch_build(sess, appid: int) -> tuple[dict | None, str, dict]:
    payload, status = get_json(sess, INFO_URL.format(appid=appid), timeout=30)
    if status != "ok":
        return None, status, payload or {}
    if payload.get("status") != "success":
        return None, f"status={payload.get('status')}", payload
    data = (payload.get("data") or {}).get(str(appid)) or {}
    public = ((data.get("depots") or {}).get("branches") or {}).get("public") or {}
    if not public.get("buildid"):
        return None, "no_public_branch", payload
    updated = public.get("timeupdated")
    at = datetime.fromtimestamp(int(updated), BUSINESS_TZ) if updated else None
    return {"buildid": str(public["buildid"]),
            "build_updated_at": at.isoformat(timespec="seconds") if at else None,
            "build_updated_date": at.date().isoformat() if at else None}, "", payload


def collect_one(conn, game: dict, date_local: str) -> tuple[int, int, str]:
    appid = game.get("steam_app_id")
    if not appid:
        return 0, 0, "no_steam_app_id"
    build, err, raw = fetch_build(session(), appid)
    save_raw("steam_build", game["game_id"], date_local, raw)
    if build:
        db.upsert(conn, "steam_build", [{"game_id": game["game_id"], "date": date_local, **build,
                                         "observed_at": now_iso()}])
    print(f"  {game['display_name']}: buildid {build['buildid'] if build else '失败'}"
          f"{'，构建更新于 ' + build['build_updated_date'] if build and build['build_updated_date'] else ''}")
    polite_sleep(.8)
    return 1, int(build is not None), err


def run(conn, games: list[dict], date_local: str) -> bool:
    return run_per_game(conn, "steam_build", games, date_local, collect_one)


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 Steam public 分支构建号")
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
