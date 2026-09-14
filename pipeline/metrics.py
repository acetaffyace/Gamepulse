"""派生指标计算。

全部为纯函数，便于单元测试。核心原则：
- 相邻快照缺天时，差值跨越多天，必须标注 span_days，不假装是单日增量；
- 分母为 0 或字段缺失时返回 None，不返回 0；
- Steam 会删除违规评测，新增评测出现负值是真实现象，保留数值并打标。
"""

from __future__ import annotations

from datetime import date, datetime

OBSERVED = "observed"
DERIVED = "derived"
UNAVAILABLE = "unavailable"


def _parse(d: str) -> date:
    return datetime.strptime(d, "%Y-%m-%d").date()


def review_rate(positive: int | None, total: int | None) -> float | None:
    """好评率，返回 0-100 的百分比。分母缺失或为 0 时返回 None。"""
    if positive is None or total is None or total <= 0:
        return None
    return round(positive / total * 100, 2)


def online_series(steam_records: list[dict]) -> list[dict]:
    out = []
    for rec in steam_records:
        value = rec.get("current_players")
        out.append({
            "date_local": rec["date_local"],
            "value": value,
            "status": OBSERVED if value is not None else UNAVAILABLE,
        })
    return out


def review_rate_series(steam_records: list[dict]) -> list[dict]:
    out = []
    for rec in steam_records:
        rate = review_rate(rec.get("total_positive"), rec.get("total_reviews"))
        out.append({
            "date_local": rec["date_local"],
            "value": rate,
            "total_reviews": rec.get("total_reviews"),
            "status": DERIVED if rate is not None else UNAVAILABLE,
        })
    return out


def new_review_series(steam_records: list[dict]) -> list[dict]:
    """总评测数的相邻差值，作为讨论热度代理。

    第一条记录没有前值，标记 unavailable 而不是写 0。
    """
    out: list[dict] = []
    prev_total = None
    prev_date = None

    for rec in sorted(steam_records, key=lambda r: r["date_local"]):
        cur_total = rec.get("total_reviews")
        cur_date = rec["date_local"]

        if cur_total is None or prev_total is None:
            out.append({
                "date_local": cur_date, "value": None, "span_days": None,
                "status": UNAVAILABLE,
                "note": "no_baseline" if prev_total is None else "total_unavailable",
            })
        else:
            span = (_parse(cur_date) - _parse(prev_date)).days
            delta = cur_total - prev_total
            notes = []
            if span > 1:
                notes.append(f"spans_{span}_days")
            if delta < 0:
                notes.append("negative_delta_reviews_removed")
            out.append({
                "date_local": cur_date, "value": delta, "span_days": span,
                "status": DERIVED, "note": ";".join(notes),
            })

        if cur_total is not None:
            prev_total, prev_date = cur_total, cur_date

    return out


def price_series(steam_records: list[dict]) -> list[dict]:
    out = []
    for rec in steam_records:
        out.append({
            "date_local": rec["date_local"],
            "is_free": rec.get("is_free"),
            "price_final": rec.get("price_final"),
            "discount_percent": rec.get("discount_percent"),
            "status": rec.get("price_status", UNAVAILABLE),
            "note": rec.get("price_note", ""),
        })
    return out


def video_view_series(bili_records: list[dict]) -> dict[str, dict]:
    """按 BV 号聚合播放量时间线与日增量。"""
    by_video: dict[str, dict] = {}

    for rec in sorted(bili_records, key=lambda r: r["date_local"]):
        for v in rec.get("videos", []):
            bvid = v["bvid"]
            slot = by_video.setdefault(bvid, {
                "bvid": bvid,
                "title": v.get("title"),
                "character_id": v.get("character_id"),
                "character_name": v.get("character_name"),
                "version_id": v.get("version_id"),
                "version_confirmed": v.get("version_confirmed", False),
                "content_type": v.get("content_type"),
                "owner_mid": v.get("owner_mid"),
                "pubdate": v.get("pubdate"),
                "points": [],
            })
            slot["points"].append({
                "date_local": rec["date_local"],
                "view": v.get("view"),
                "status": v.get("status", UNAVAILABLE),
            })

    for slot in by_video.values():
        prev_view, prev_date = None, None
        for pt in slot["points"]:
            cur = pt.get("view")
            if cur is None or prev_view is None:
                pt["delta"] = None
                pt["span_days"] = None
                pt["delta_status"] = UNAVAILABLE
            else:
                span = (_parse(pt["date_local"]) - _parse(prev_date)).days
                pt["delta"] = cur - prev_view
                pt["span_days"] = span
                pt["delta_status"] = DERIVED
            if cur is not None:
                prev_view, prev_date = cur, pt["date_local"]
        latest = [p for p in slot["points"] if p.get("view") is not None]
        slot["latest_view"] = latest[-1]["view"] if latest else None
    return by_video


def discount_events(price_points: list[dict]) -> list[dict]:
    """折扣开始/结束事件。仅在价格字段可观测时生成。"""
    events, prev = [], None
    for pt in price_points:
        if pt.get("status") != OBSERVED:
            prev = None
            continue
        cur = pt.get("discount_percent") or 0
        if prev is not None and cur != prev:
            kind = "discount_start" if cur > prev else "discount_end"
            events.append({
                "date_local": pt["date_local"], "type": kind,
                "from_percent": prev, "to_percent": cur, "source": "steam",
            })
        prev = cur
    return events


def coverage(steam_records: list[dict]) -> dict:
    dates = sorted(r["date_local"] for r in steam_records)
    if not dates:
        return {"start": None, "end": None, "valid_days": 0, "expected_days": 0,
                "missing_days": 0}
    expected = (_parse(dates[-1]) - _parse(dates[0])).days + 1
    return {
        "start": dates[0], "end": dates[-1],
        "valid_days": len(dates), "expected_days": expected,
        "missing_days": expected - len(dates),
    }
