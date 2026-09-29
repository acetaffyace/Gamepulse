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


def source_health(records_by_source: dict[str, list[dict]], profile: dict | None,
                  today: str, attempts: list[dict] | None = None) -> dict:
    """Build time is not observation time. Expose the latest attempt AND usable data."""
    result = {}
    latest_attempts = {}
    for row in sorted(attempts or [], key=lambda r: r.get("attempted_at", "")):
        latest_attempts[row["source"]] = row
    for source, rows in records_by_source.items():
        ordered = sorted(rows, key=lambda r: (r.get("date_local", ""), r.get("hour_local", 0)))
        last = ordered[-1] if ordered else {}
        def counts(row):
            if source in ("bilibili", "youtube"):
                videos = row.get("videos", [])
                return len(videos), sum(v.get("view") is not None and v.get("identity_verified") is not False
                    and not any(t in v.get("note", "") for t in ("owner_mismatch", "channel_not_official", "locale_mismatch")) for v in videos)
            fields = {"steam": ("total_reviews", "current_players"), "steam_online": ("players",), "steam_build": ("buildid",)}[source]
            return len(fields), sum(row.get(field) is not None for field in fields)
        expected, success = counts(last) if last else (0, 0)
        through = max((r["date_local"] for r in ordered if counts(r)[1]), default=None)
        attempt = latest_attempts.get(source)
        failed_retained = last.get("last_attempt", {}).get("status") in ("failed", "partial") or any(
            v.get("last_attempt", {}).get("status") in ("failed", "partial") for v in last.get("videos", []))
        if attempt and attempt.get("date_local", "") >= last.get("date_local", ""):
            expected, success = attempt.get("expected", 0), attempt.get("succeeded", 0)
        age = (_parse(today) - _parse(through)).days if through else None
        status = "skipped" if not expected else "failed" if not success else "partial" if success < expected or failed_retained else "stale" if age is not None and age >= 2 else "healthy"
        if attempt and attempt.get("status") == "disabled":
            status = "disabled"
        result[source] = {"status": status, "last_attempt_at": (attempt or {}).get("attempted_at") or last.get("sampled_at") or last.get("date_local"),
                          "data_through": through, "last_success_at": through,
                          "expected": expected, "succeeded": success, "age_days": age}
    if profile:
        through = profile.get("collected_at")
        age = (_parse(today) - _parse(through[:10])).days if through else None
        attempt = latest_attempts.get("steam_reviews_backfill") or {}
        failed = attempt.get("status") == "failed" and attempt.get("date_local", "") >= (through or "")
        result["review_profile"] = {"status": "failed" if failed else "stale" if age is None or age >= 8 else "healthy",
                                     "data_through": through, "last_success_at": through,
                                     "last_attempt_at": attempt.get("attempted_at") or through, "age_days": age,
                                     "schedule": "weekly", "expected": None, "succeeded": profile.get("total_reviews")}
    return result


def _version_key(version: str) -> tuple[int, int] | None:
    try:
        major, minor = version.split(".")[:2]
        return int(major), int(minor)
    except (AttributeError, ValueError):
        return None


def version_table_issues(events: list[dict], table: dict) -> list[dict]:
    """核对版本分界线与 config/versions.yml。

    两类问题会让版本窗口悄悄出错：官方公告里有、版本表里没有的版本
    （窗口来源未经核对）；同一大版本内编号跳跃（上一个窗口很可能并入了
    漏掉的版本，鸣潮 3.3 曾因此被算进 3.2 的 81 天窗口）。
    """
    issues = []
    bounds = sorted((e for e in events if e.get("is_version_boundary")),
                    key=lambda e: e["date_local"])
    unlisted = [e["version_id"] for e in bounds if e.get("version_id") not in table]
    if unlisted:
        issues.append({"level": "warn", "code": "version_not_in_table",
                       "message": f"版本 {'、'.join(unlisted)} 来自公告识别，尚未登记到版本表",
                       "versions": unlisted})
    for prev, cur in zip(bounds, bounds[1:]):
        a, b = _version_key(prev.get("version_id")), _version_key(cur.get("version_id"))
        if a and b and a[0] == b[0] and b[1] - a[1] > 1:
            issues.append({"level": "warn", "code": "version_gap",
                           "message": f"{prev['version_id']} 之后直接是 {cur['version_id']}，"
                                      f"{prev['version_id']} 的窗口可能包含未登记的版本",
                           "versions": [prev["version_id"], cur["version_id"]]})
    return issues


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
