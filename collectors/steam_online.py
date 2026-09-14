"""Steam 同时在线人数的小时级采样器。

为什么要小时级
--------------
每天只采一个点，拿到的是「某一时刻的在线数」。这个数同时受两件事影响：
盘子本身的大小，和采样时刻离当天活跃高峰有多远。两者混在一起，
日间波动会被误读成趋势变化。

按小时采样之后可以分出来：
  日峰值      当天最热闹的时候有多少人
  日谷值      基本盘
  峰谷比      作息集中度 —— 接近 1 说明玩家分散在多个时区，
              明显大于 1 说明被单一时区主导
  峰值时刻    反过来佐证玩家的地域构成

成本很低：每款游戏每天 24 次轻量 JSON 请求，且 Steam 官方接口无需 Key。

幂等性：按 (date_local, hour_local) 去重，同一小时内重复运行覆盖而不追加，
因此可以安全地放进每小时计划任务，也可以手动补跑。

用法：
    python collectors/steam_online.py
    python collectors/steam_online.py --game zenless_zone_zero
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    OBSERVED,
    UNAVAILABLE,
    get_game,
    get_json,
    load_games,
    log_collection,
    now_iso,
    polite_sleep,
    session,
    upsert_series_keyed,
)

PLAYERS_URL = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/"


def sample_game(sess, game: dict) -> dict | None:
    game_id = game["game_id"]
    appid = game.get("steam_app_id")
    if not appid:
        return None

    now = datetime.now()
    date_local = now.strftime("%Y-%m-%d")
    hour_local = now.hour

    payload, status = get_json(sess, PLAYERS_URL, {"appid": appid})
    resp = (payload or {}).get("response") or {}
    players = resp.get("player_count") if resp.get("result") == 1 else None

    record = {
        "date_local": date_local,
        "hour_local": hour_local,
        "sampled_at": now_iso(),
        "game_id": game_id,
        "steam_app_id": appid,
        "players": players,
        "status": OBSERVED if players is not None else UNAVAILABLE,
        "note": "" if players is not None else status,
    }

    action = upsert_series_keyed(game_id, "steam_online", record,
                                 keys=("date_local", "hour_local"))
    log_collection("steam_online", game_id, date_local, action,
                   f"hour={hour_local};players={players}")

    shown = f"{players:,}" if players is not None else f"不可用({status})"
    print(f"  [{action}] {game['display_name']:<8} {date_local} "
          f"{hour_local:02d}时  在线 {shown}")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="按小时采样 Steam 同时在线人数")
    parser.add_argument("--game", help="game_id；省略则采集所有 active 游戏")
    args = parser.parse_args()

    games = [get_game(args.game)] if args.game else [
        g for g in load_games() if g.get("active")]
    if not games:
        print("没有可采集的游戏")
        return 1

    sess = session()
    failures = 0
    for game in games:
        record = sample_game(sess, game)
        if record is None or record["status"] != OBSERVED:
            failures += 1
        polite_sleep(0.8)

    return 1 if failures == len(games) else 0


if __name__ == "__main__":
    raise SystemExit(main())
