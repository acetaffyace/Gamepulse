"""把 config/dashboard.yml 编译成前端可直接 fetch 的 dashboard_config.json。

为什么要有这一步
----------------
看板是零依赖静态页，浏览器里读不了 YAML，也不该在前端做配置校验。
这个脚本承担两件事：

1. 格式转换 —— YAML → JSON；
2. **逐条验证每个轨道的 path/field 能在真实快照里取到值。**

第 2 件是重点。配置驱动最大的风险是：把 field 写成 new_review（少个 s），
页面不会报错，只会渲染出一条空空的轨道，而看图的人会以为「这个指标没数据」。
所以这里对每个 active 游戏的快照做一次干跑，取不到值就构建失败，
并明确说出是哪条轨道的哪个字段、在哪个游戏上取不到。

用法：
    python pipeline/build_dashboard_config.py
    python pipeline/build_dashboard_config.py --strict   # 任一游戏取不到值即失败
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    DATA_DIR,
    load_games,
    load_yaml,
    write_json,
)
import json  # noqa: E402

# adapter 名 → 该 adapter 需要 path 指向什么形状的数据。
# 这张表同时是 dashboard/app.js 里 ADAPTERS 的契约，两边必须一致。
ADAPTER_SHAPES = {
    "series": "list_of_dated_records",
    "video_scatter": "list_of_videos",
    "video_delta": "list_of_videos",
    "video_ramp": "list_of_videos",
    "version_marks": "list_of_events",
    "stacked_share": "language_share_object",
    "share_delta": "language_share_object",
    # path 指向 {locale_code: {videos: [...]}}，不是数组
    "locale_scatter": "locale_map_of_videos",
}

# 视频的 content_type 取值域。写错一个值不会报错，只会让轨道无声地筛空，
# 所以在这里对 lane.content_types 做一次白名单校验。
CONTENT_TYPES = {
    "version_trailer", "character_trailer", "character_demo",
    "character_ep", "season_teaser", "ep", "other",
    # 已存在于注册表的非默认展示类型，保留在 schema 中但不进入
    # important_video_types，避免它们被误删或被误判为未知值。
    "theme_mv", "animation_short", "behind_the_scenes",
}

# 一条轨道声明的纵轴标尺。前端按 id 分支取数，写错就会静默退回默认标尺，
# 所以取值域在这里锁死。
SCALE_IDS = {"abs", "index"}


def resolve(snapshot: dict, path: str):
    """按点分路径取值，任一层缺失返回 None。"""
    node = snapshot
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def lane_fields(lane: dict) -> list[str]:
    """一条轨道要验证的全部字段名。"""
    if lane.get("series"):
        return [s["field"] for s in lane["series"] if s.get("field")]
    return [lane["field"]] if lane.get("field") else []


def verify_locale_lane(lane: dict, node) -> list[str]:
    """语区轨道：path 指向 {locale: {videos: [...]}}，逐个语区验证取数字段。

    这里比普通视频轨道多验一层：lane.locales 里写了一个快照中不存在的语区码
    （比如把 zh-tw 写成 zhtw），页面只会少画一组点，不会报任何错。
    """
    problems: list[str] = []
    if not isinstance(node, dict):
        problems.append(f"path «{lane['path']}» 不是语区字典"
                        f"（adapter=locale_scatter 需要 {{语区: {{videos: [...]}}}}）")
        return problems

    wanted = lane.get("locales") or list(node)
    missing = [code for code in wanted if code not in node]
    if missing:
        problems.append(f"locales 里的 {missing} 在快照的 {lane['path']} 下不存在"
                        f"（有：{', '.join(sorted(node))}）")

    field = lane.get("field")
    container = "rates" if lane.get("from_rates") else "stats"
    for code in wanted:
        videos = (node.get(code) or {}).get("videos") or []
        if not videos:
            continue  # 该语区还没接入，是数据问题不是配置问题
        sample = videos[0]
        if "pubdate" not in sample:
            problems.append(f"语区 {code} 的视频缺少 pubdate")
        latest = sample.get("latest") or {}
        bag = latest.get(container) or {}
        if field and latest and field not in bag:
            problems.append(f"字段 «{field}» 不在语区 {code} 的 latest.{container} 里"
                            f"（有：{', '.join(sorted(bag))}）")
    return problems


def verify_lane(lane: dict, snapshot: dict) -> list[str]:
    """返回该轨道在此快照上的问题列表；空列表表示通过。"""
    problems: list[str] = []
    adapter = lane.get("adapter")
    if adapter not in ADAPTER_SHAPES:
        problems.append(f"未知 adapter «{adapter}»，"
                        f"可用：{', '.join(sorted(ADAPTER_SHAPES))}")
        return problems

    for scale in lane.get("scales") or []:
        if scale.get("id") not in SCALE_IDS:
            problems.append(f"scales 里的 id «{scale.get('id')}» 不在取值域内，"
                            f"可用：{', '.join(sorted(SCALE_IDS))}")
        if not scale.get("label"):
            problems.append(f"scales 里的 «{scale.get('id')}» 缺少 label")

    node = resolve(snapshot, lane["path"])
    if node is None:
        problems.append(f"path «{lane['path']}» 在快照里不存在")
        return problems

    if adapter == "locale_scatter":
        return problems + verify_locale_lane(lane, node)

    if adapter in ("stacked_share", "share_delta"):
        if not isinstance(node, dict) or "buckets" not in node:
            problems.append(f"path «{lane['path']}» 不是语种分桶结构")
        return problems

    if not isinstance(node, list):
        problems.append(f"path «{lane['path']}» 不是数组（adapter={adapter} 需要数组）")
        return problems

    unknown_types = set(lane.get("content_types") or []) - CONTENT_TYPES
    if unknown_types:
        problems.append(f"content_types 含未知取值 {sorted(unknown_types)}，"
                        f"可用：{', '.join(sorted(CONTENT_TYPES))}")

    if adapter == "version_marks":
        if not any(e.get("is_version_boundary") for e in node):
            problems.append(f"«{lane['path']}» 里没有 is_version_boundary 事件")
        return problems

    if not node:
        # 数组为空是「这个游戏还没有这类数据」，不是配置错误 ——
        # 例如尚未接入 YouTube 时 youtube.videos 为空。
        return problems

    if adapter == "series":
        keys = set(node[0].keys())
        if "date_local" not in keys:
            problems.append(f"«{lane['path']}» 的元素缺少 date_local，无法按日期对齐")
        for field in lane_fields(lane):
            if field not in keys:
                problems.append(f"字段 «{field}» 不在 {lane['path']} 的元素里"
                                f"（该元素有：{', '.join(sorted(keys))[:120]}）")

    elif adapter == "video_ramp":
        sample = node[0]
        if "ramp" not in sample:
            problems.append(f"«{lane['path']}» 的元素缺少 ramp（发布后逐日曲线）")
        elif lane.get("field") and sample["ramp"].get("points"):
            pt = sample["ramp"]["points"][0]
            if lane["field"] not in pt:
                problems.append(f"字段 «{lane['field']}» 不在 ramp.points 里"
                                f"（有：{', '.join(sorted(pt))}）")

    elif adapter in ("video_scatter", "video_delta"):
        sample = node[0]
        if "pubdate" not in sample:
            problems.append(f"«{lane['path']}» 的元素缺少 pubdate")
        field = lane.get("field")
        if field:
            container = "rates" if lane.get("from_rates") else "stats"
            latest = sample.get("latest") or {}
            bag = latest.get(container) or {}
            # 视频可能全部采集失败导致 latest 为 None，那是数据问题不是配置问题
            if latest and field not in bag:
                problems.append(f"字段 «{field}» 不在视频的 latest.{container} 里"
                                f"（有：{', '.join(sorted(bag))}）")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="编译并校验看板轨道配置")
    parser.add_argument("--strict", action="store_true",
                        help="任一游戏上取不到值即失败（默认：全部游戏都取不到才失败）")
    args = parser.parse_args()

    config = load_yaml("dashboard.yml")
    lanes = config.get("lanes") or []
    if not lanes:
        print("dashboard.yml 里没有定义任何 lane")
        return 1

    ids = [lane["id"] for lane in lanes]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        print(f"轨道 id 重复：{', '.join(sorted(duplicates))}")
        return 1

    # 预设里引用的轨道必须真实存在，否则切换预设会得到空白页面
    for name, preset in (config.get("presets") or {}).items():
        unknown = [i for i in preset.get("lanes", []) if i not in ids]
        if unknown:
            print(f"预设 «{name}» 引用了不存在的轨道：{', '.join(unknown)}")
            return 1

    snapshots: dict[str, dict] = {}
    for game in load_games():
        if not game.get("active"):
            continue
        path = DATA_DIR / f"snapshot_{game['game_id']}.json"
        if path.exists():
            with path.open("r", encoding="utf-8") as fh:
                snapshots[game["game_id"]] = json.load(fh)

    if not snapshots:
        print("没有任何快照可供校验，请先运行 pipeline/build_snapshot.py")
        return 1

    failed = False
    for lane in lanes:
        per_game = {gid: verify_lane(lane, snap) for gid, snap in snapshots.items()}
        bad = {gid: p for gid, p in per_game.items() if p}
        if not bad:
            continue
        # 默认只有「在所有游戏上都取不到」才算配置错误：
        # 某个游戏缺某类数据是正常的（例如还没接 YouTube）。
        fatal = args.strict or len(bad) == len(snapshots)
        level = "错误" if fatal else "提示"
        for gid, problems in bad.items():
            for problem in problems:
                print(f"[{level}] 轨道 {lane['id']} @ {gid}: {problem}")
        failed = failed or fatal

    if failed:
        print("\n轨道配置校验失败，未写出 dashboard_config.json")
        return 1

    out = {
        "palette": config.get("palette") or {},
        "share_ramp": config.get("share_ramp") or [],
        "share_other": config.get("share_other"),
        "important_video_types": config.get("important_video_types") or [],
        "lanes": lanes,
        "presets": config.get("presets") or {},
        "adapters": sorted(ADAPTER_SHAPES),
    }
    write_json(DATA_DIR / "dashboard_config.json", out)

    enabled = [lane["id"] for lane in lanes if lane.get("enabled")]
    print(f"已生成 dashboard_config.json："
          f"{len(lanes)} 条轨道（默认开启 {len(enabled)} 条），"
          f"{len(config.get('presets') or {})} 个预设")
    print(f"  校验通过的游戏：{', '.join(snapshots)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
