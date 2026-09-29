"""采集入口：同步配置 → 各采集器写数据库 → 构建发布包。

幂等：同一天重复运行，按主键更新当天的记录，不会产生重复数据点，可以放进计划任务，也可以手动补跑。
某个来源失败不影响其他来源，已有数据照常发布，失败会显示在数据来源页。

    python collect.py                                   # 每日：SteamDB 收件箱、Steam、构建号、B 站、YouTube
    python collect.py --game zenless_zone_zero
    python collect.py --only steam,youtube
    python collect.py --only reviews --incremental      # 每日：刷新近期评测
    python collect.py --only reviews                    # 每周：全量校准评测
    python collect.py --no-build                        # 只采集，不生成发布包
"""

from __future__ import annotations

import argparse
import sys

from collectors import bilibili, steam, steam_build, steam_reviews_backfill, steamdb_import, youtube
from collectors.common import active_games, today_local
from store import build, config_sync, db

DAILY_STEPS = ("steamdb", "steam", "build", "bilibili", "youtube")
ALL_STEPS = DAILY_STEPS + ("reviews",)


def main() -> int:
    parser = argparse.ArgumentParser(description="采集数据并生成发布包")
    parser.add_argument("--game")
    parser.add_argument("--only", help=f"逗号分隔：{','.join(ALL_STEPS)}")
    parser.add_argument("--incremental", action="store_true", help="reviews 只刷新近期评测")
    parser.add_argument("--date", default=today_local())
    parser.add_argument("--no-build", action="store_true", help="只采集，不生成发布包")
    for step in ALL_STEPS:
        parser.add_argument(f"--skip-{step}", action="store_true")
    args = parser.parse_args()

    steps = [s.strip() for s in args.only.split(",")] if args.only else list(DAILY_STEPS)
    unknown = set(steps) - set(ALL_STEPS)
    if unknown:
        parser.error(f"未知步骤：{', '.join(sorted(unknown))}")
    steps = [s for s in steps if not getattr(args, f"skip_{s}")]

    conn = db.connect()
    failures: list[str] = []
    try:
        config_sync.sync(conn)
        games = active_games(args.game)
        runners = {
            "steamdb": lambda: steamdb_import.import_inbox(conn),
            "steam": lambda: steam.run(conn, games, args.date),
            "build": lambda: steam_build.run(conn, games, args.date),
            "bilibili": lambda: bilibili.run(conn, games, args.date),
            "youtube": lambda: youtube.run(conn, games, args.date),
            "reviews": lambda: steam_reviews_backfill.run(conn, games, args.date, incremental=args.incremental),
        }
        for step in steps:
            print(f"\n── {step} " + "─" * 50)
            try:
                if runners[step]():
                    failures.append(step)
            except Exception as exc:  # noqa: BLE001 —— 一个来源出错不影响其他来源
                print(f"[failed] {step}: {type(exc).__name__}: {exc}")
                failures.append(step)
    finally:
        conn.close()

    if not args.no_build:
        print("\n── 构建发布包 " + "─" * 44)
        if build.main_quiet() != 0:
            failures.append("build")

    if failures:
        print(f"\n完成，但以下步骤失败或不完整：{', '.join(failures)}。已有数据仍已发布，失败原因见数据来源页。")
        return 1
    print("\n采集与发布包已更新。本机查看：python -m http.server 8770 -d dist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
