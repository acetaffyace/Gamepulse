"""采集入口：采集器 → 快照 → 看板配置。

设计为幂等：同一天重复运行会覆盖当天记录，不会产生重复数据点，
因此可以安全地放进计划任务，也可以手动补跑。

小时级在线采样不在这里 —— 它由 collectors/steam_online.py 单独按小时跑，
见 scripts/register-tasks.ps1。把两者混在一起会让每小时的轻量采样
拖上评测、公告、视频等一整套重请求。

用法：
    python collect.py                      # 采集所有 active 游戏
    python collect.py --game zenless_zone_zero
    python collect.py --skip-bilibili      # 只跑 Steam
    python collect.py --only steam,youtube # 指定步骤
    python collect.py --only review_backfill --incremental-review-backfill
                                           # 每日近期明细恢复并重建看板
    python collect.py --only review_backfill # 每周全量校准
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from collectors.common import load_games

ROOT = Path(__file__).resolve().parent

# (步骤名, 脚本路径, 失败是否影响退出码)
# YouTube 未配置 API Key 时脚本自身返回 0 并打印申请指引，
# 因此这里不需要为「没配 key」做特殊处理。
STEPS = [
    ("steam", "collectors/steam.py", True),
    ("build", "collectors/steam_build.py", False),
    ("bilibili", "collectors/bilibili.py", True),
    ("youtube", "collectors/youtube.py", False),
    # 全量翻页成本高，只由每日评测恢复任务显式调用。
    ("review_backfill", "collectors/steam_reviews_backfill.py", True),
]
DAILY_STEPS = {"steam", "build", "bilibili", "youtube"}


def run(script: str, args: list[str]) -> int:
    cmd = [sys.executable, str(ROOT / script)] + args
    print(f"\n{'=' * 62}\n$ {script} {' '.join(args)}\n{'=' * 62}")
    return subprocess.run(cmd, cwd=ROOT).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="采集数据并构建看板文件")
    parser.add_argument("--game")
    parser.add_argument("--only", help="逗号分隔的步骤名：steam,build,bilibili,youtube,review_backfill")
    parser.add_argument("--incremental-review-backfill", action="store_true",
                        help="review_backfill 使用近期增量模式")
    for name, _, _ in STEPS:
        parser.add_argument(f"--skip-{name.replace('_', '-')}",
                            dest=f"skip_{name}", action="store_true")
    args = parser.parse_args()

    scope = ["--game", args.game] if args.game else []
    only = {s.strip() for s in args.only.split(",")} if args.only else None
    known_steps = {name for name, _, _ in STEPS}
    unknown_steps = (only or set()) - known_steps
    if unknown_steps:
        parser.error(f"未知步骤：{', '.join(sorted(unknown_steps))}")

    failures: list[str] = []
    critical = False

    for name, script, is_critical in STEPS:
        if only is None and name not in DAILY_STEPS:
            continue
        if only is not None and name not in only:
            continue
        if getattr(args, f"skip_{name}"):
            continue
        if name == "review_backfill" and not args.game:
            targets = [g for g in load_games() if g.get("active")]
            extra = ["--incremental"] if args.incremental_review_backfill else []
            results = [run(script, ["--game", g["game_id"]] + extra)
                       for g in targets]
            step_failed = not results or any(code != 0 for code in results)
        else:
            extra = (["--incremental"] if name == "review_backfill" and
                     args.incremental_review_backfill else [])
            step_failed = run(script, scope + extra) != 0
        if step_failed:
            failures.append(name)
            critical = critical or is_critical

    # 即使某个采集器失败也要重建快照：已有数据仍应可视化，
    # 缺失会由 quality 检查标记出来，而不是让整个看板不可用。
    if run("pipeline/build_snapshot.py", scope) != 0:
        failures.append("build_snapshot")
        critical = True
    if run("pipeline/build_dashboard_config.py", []) != 0:
        failures.append("build_dashboard_config")
        critical = True

    print()
    if failures:
        print(f"完成，但以下步骤失败：{', '.join(failures)}")
        print("已有数据仍已写入快照，缺口会在看板的数据质量提示中显示。")
        return 1 if critical else 0
    print("采集、快照与看板配置已更新。运行 python -m http.server 8770 后访问")
    print("  http://127.0.0.1:8770/dashboard/index.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
