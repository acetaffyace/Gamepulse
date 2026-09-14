"""每日采集入口：Steam → B 站 → 生成快照。

设计为幂等：同一天重复运行会覆盖当天记录，不会产生重复数据点，
因此可以安全地放进计划任务，也可以手动补跑。

用法：
    python collect.py                      # 采集所有 active 游戏
    python collect.py --game zenless_zone_zero
    python collect.py --skip-bilibili      # 只跑 Steam
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(script: str, args: list[str]) -> int:
    cmd = [sys.executable, str(ROOT / script)] + args
    print(f"\n{'=' * 62}\n$ {script} {' '.join(args)}\n{'=' * 62}")
    return subprocess.run(cmd, cwd=ROOT).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="每日采集并生成快照")
    parser.add_argument("--game")
    parser.add_argument("--skip-steam", action="store_true")
    parser.add_argument("--skip-bilibili", action="store_true")
    args = parser.parse_args()

    scope = ["--game", args.game] if args.game else []
    failures = []

    if not args.skip_steam:
        if run("collectors/steam.py", scope) != 0:
            failures.append("steam")
    if not args.skip_bilibili:
        if run("collectors/bilibili.py", scope) != 0:
            failures.append("bilibili")

    # 即使某个采集器失败也要重建快照：已有数据仍应可视化，
    # 缺失会由 quality 检查标记出来，而不是让整个看板不可用。
    if run("pipeline/build_snapshot.py", scope) != 0:
        failures.append("build_snapshot")

    # 对比集始终按全部 active 游戏重建，不受 --game 影响：
    # 只更新其中一款会让对比视图里的其余游戏停留在旧数据。
    if run("pipeline/build_compare.py", []) != 0:
        failures.append("build_compare")

    print()
    if failures:
        print(f"完成，但以下步骤失败：{', '.join(failures)}")
        print("已有数据仍已写入快照，缺口会在看板的数据质量提示中显示。")
        return 1
    print("全部完成。运行 python -m http.server 8770 后访问")
    print("  http://127.0.0.1:8770/dashboard/index.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
