"""数据质量检查：缺天、过期、字段不可用、异常倒退。

检查结果分三级：
  error  数据不可信，dashboard 应显示告警
  warn   可用但需说明，如跨天差值、字段缺失
  info   正常但值得记录，如覆盖天数不足以做趋势判断
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MIN_TREND_DAYS = 30  # 低于此天数不宜做趋势复盘


def _parse(d: str):
    return datetime.strptime(d, "%Y-%m-%d").date()


def check(steam_records: list[dict], bili_records: list[dict],
          today: str | None = None) -> list[dict]:
    today_d = _parse(today) if today else datetime.now().date()
    issues: list[dict] = []

    def add(level, code, message, **extra):
        issues.append({"level": level, "code": code, "message": message, **extra})

    if not steam_records:
        add("error", "no_steam_data", "没有任何 Steam 快照记录")
        return issues

    dates = sorted(r["date_local"] for r in steam_records)
    start, end = _parse(dates[0]), _parse(dates[-1])

    # 数据新鲜度
    stale_days = (today_d - end).days
    if stale_days >= 2:
        add("error", "stale_data",
            f"最新快照是 {dates[-1]}，距今 {stale_days} 天，采集可能已中断",
            stale_days=stale_days)
    elif stale_days == 1:
        add("warn", "stale_data", f"今天尚未采集，最新快照为 {dates[-1]}",
            stale_days=stale_days)

    # 缺天
    have = set(dates)
    missing = []
    cursor = start
    while cursor <= end:
        iso = cursor.isoformat()
        if iso not in have:
            missing.append(iso)
        cursor += timedelta(days=1)
    if missing:
        add("warn", "missing_days",
            f"区间内缺少 {len(missing)} 天快照，相邻差值会跨天",
            missing_days=missing[:10], missing_count=len(missing))

    # 覆盖天数
    if len(dates) < MIN_TREND_DAYS:
        add("info", "short_coverage",
            f"当前仅 {len(dates)} 天数据，不足 {MIN_TREND_DAYS} 天，"
            f"图表可展示但不宜作为趋势结论",
            valid_days=len(dates))

    # 字段可用性
    for field, label in (("current_players", "在线人数"),
                         ("total_reviews", "评测总数"),
                         ("price_final", "价格")):
        missing_field = [r["date_local"] for r in steam_records if r.get(field) is None]
        if missing_field and len(missing_field) == len(steam_records):
            add("warn", f"field_always_unavailable:{field}",
                f"{label} 在全部 {len(steam_records)} 天均不可用",
                field=field)
        elif missing_field:
            add("warn", f"field_partially_unavailable:{field}",
                f"{label} 有 {len(missing_field)} 天不可用", field=field,
                dates=missing_field[:10])

    # 评测总数倒退（Steam 会删评，小幅下降正常；大幅下降需排查）
    prev = None
    for rec in sorted(steam_records, key=lambda r: r["date_local"]):
        cur = rec.get("total_reviews")
        if cur is not None and prev is not None and cur < prev:
            drop = prev - cur
            level = "error" if drop > max(50, prev * 0.01) else "info"
            add(level, "review_total_regression",
                f"{rec['date_local']} 评测总数由 {prev:,} 降至 {cur:,}（-{drop:,}）",
                date_local=rec["date_local"], drop=drop)
        if cur is not None:
            prev = cur

    # B 站：owner 不匹配 / 播放量倒退
    for rec in bili_records:
        for v in rec.get("videos", []):
            if v.get("note", "").startswith("owner_mismatch"):
                add("error", "bilibili_owner_mismatch",
                    f"{v['bvid']} 的 UP 主与登记的官方账号不一致：{v['note']}",
                    bvid=v["bvid"])

    prev_views: dict[str, int] = {}
    for rec in sorted(bili_records, key=lambda r: r["date_local"]):
        for v in rec.get("videos", []):
            cur = v.get("view")
            bvid = v["bvid"]
            if cur is not None and bvid in prev_views and cur < prev_views[bvid]:
                add("warn", "bilibili_view_regression",
                    f"{bvid} 播放量在 {rec['date_local']} 下降："
                    f"{prev_views[bvid]:,} → {cur:,}", bvid=bvid)
            if cur is not None:
                prev_views[bvid] = cur

    return issues


def summarize(issues: list[dict]) -> dict:
    return {
        "error": sum(1 for i in issues if i["level"] == "error"),
        "warn": sum(1 for i in issues if i["level"] == "warn"),
        "info": sum(1 for i in issues if i["level"] == "info"),
    }
