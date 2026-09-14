"""半自动发现官方新视频，用于维护 bilibili_videos.yml。

方法：以注册表中已核验的官方视频为种子，调用公开的 archive/related 接口，
按 owner.mid 过滤出同一官方账号的视频。只读公开接口，不调用搜索接口，
不做登录或风控绕过。

输出候选清单供人工确认；本脚本不会自动改写注册表——版本归属和内容类型
需要人工判断（版本 PV 通常早于版本更新日发布，无法按日期机械归类）。

用法：
    python collectors/bilibili_discover.py --game zenless_zone_zero --since 2026-06-01
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    get_json,
    load_videos,
    official_mid,
    polite_sleep,
    session,
)

RELATED_URL = "https://api.bilibili.com/x/web-interface/archive/related"
HEADERS = {"Referer": "https://www.bilibili.com/"}


def discover(game_id: str, since: str, rounds: int = 2) -> dict[str, dict]:
    mid = official_mid(game_id)
    if mid is None:
        raise SystemExit(f"bilibili_videos.yml 未配置 {game_id} 的 official_accounts.mid")

    registered = {v["bvid"] for v in load_videos(game_id, active_only=False)}
    seeds = list(registered)
    if not seeds:
        raise SystemExit("注册表为空，至少需要一个已核验的官方视频作为种子")

    sess = session()
    found: dict[str, dict] = {}
    visited: set[str] = set()

    for _ in range(rounds):
        next_seeds: list[str] = []
        for bvid in seeds:
            if bvid in visited:
                continue
            visited.add(bvid)
            payload, status = get_json(sess, RELATED_URL, {"bvid": bvid},
                                       headers=HEADERS)
            if status != "ok" or not payload or payload.get("code") != 0:
                print(f"  [warn] {bvid} related 不可用: {status}")
                polite_sleep()
                continue
            for item in payload.get("data") or []:
                if (item.get("owner") or {}).get("mid") != mid:
                    continue
                bv = item.get("bvid")
                pub = time.strftime("%Y-%m-%d",
                                    time.localtime(item.get("pubdate", 0)))
                if pub < since:
                    continue
                if bv not in found:
                    found[bv] = {
                        "bvid": bv, "title": item.get("title"), "pubdate": pub,
                        "view": (item.get("stat") or {}).get("view"),
                        "registered": bv in registered,
                    }
                    next_seeds.append(bv)
            polite_sleep()
        seeds = next_seeds
        if not seeds:
            break

    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="发现官方账号的新视频候选")
    parser.add_argument("--game", required=True)
    parser.add_argument("--since", default="2026-06-01",
                        help="只列出该日期之后发布的视频，默认 2026-06-01")
    parser.add_argument("--rounds", type=int, default=2,
                        help="related 扩散轮数，默认 2")
    args = parser.parse_args()

    found = discover(args.game, args.since, args.rounds)
    new = [v for v in found.values() if not v["registered"]]
    known = [v for v in found.values() if v["registered"]]

    print(f"\n发现同账号视频 {len(found)} 个（{args.since} 之后）："
          f"已登记 {len(known)}，未登记 {len(new)}")

    if new:
        print("\n未登记候选（需人工确认版本归属与内容类型后加入注册表）：")
        for v in sorted(new, key=lambda x: x["pubdate"], reverse=True):
            print(f"  {v['bvid']}  {v['pubdate']}  {v['view']:>10,}  {v['title']}")
    else:
        print("\n没有未登记的新视频。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
