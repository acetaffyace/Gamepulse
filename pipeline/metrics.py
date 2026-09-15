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

# B 站 view 接口返回的全部公开计数字段。
# 七项全采（collectors/bilibili.py），因此派生指标不需要新增任何请求。
BILI_STATS = ("view", "danmaku", "reply", "like", "coin", "favorite", "share")

# YouTube videos.list 的公开统计字段。
# 点踩数已被 YouTube 于 2021 年下线，拿不到；favoriteCount 早已废弃恒为 0，
# 因此两者都不进字段表 —— 留一个永远为 0 的字段比没有这个字段更容易误导。
# likeCount 可被创作者隐藏，隐藏时为 None 而不是 0。
YT_STATS = ("view", "like", "comment")

# 互动率的分子构成，按平台分别定义。
# B 站：投币成本最高（要消耗硬币），三项合计即「三连」。
# YouTube：只有点赞一项可用，因此它的 engagement 与 B 站的不可直接比较 ——
#          分子构成不同，跨平台比的是各自的时间趋势，不是绝对高低。
INTERACTION_NUMERATORS = {
    "bilibili": ("like", "coin", "favorite"),
    "youtube": ("like",),
}


def _parse(d: str) -> date:
    return datetime.strptime(d, "%Y-%m-%d").date()


def _days_between(a: str, b: str) -> int | None:
    if not a or not b:
        return None
    try:
        return (_parse(a) - _parse(b)).days
    except ValueError:
        return None


def _rate(numerator: int | None, denominator: int | None) -> float | None:
    """百分比，分母缺失或为 0 时返回 None（不返回 0）。"""
    if numerator is None or denominator is None or denominator <= 0:
        return None
    return round(numerator / denominator * 100, 4)


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


def online_daily(hourly_records: list[dict], min_samples: int = 6) -> list[dict]:
    """把小时级采样聚合成日峰值 / 日谷值 / 日均值。

    单点日采只能得到「某一时刻的在线数」，无法区分「整体盘子变大」和
    「采样时刻恰好撞上活跃高峰」。小时级采样后，峰谷比与峰值出现时刻
    才有意义 —— 后者还能反过来佐证玩家的地域构成。

    采样数不足 min_samples 的日期标 partial：半天的样本算不出真实日峰值。
    """
    by_date: dict[str, list[dict]] = {}
    for rec in hourly_records:
        value = rec.get("players")
        if value is None:
            continue
        by_date.setdefault(rec["date_local"], []).append(rec)

    out: list[dict] = []
    for date_local in sorted(by_date):
        samples = by_date[date_local]
        values = [s["players"] for s in samples]
        peak_sample = max(samples, key=lambda s: s["players"])
        trough_sample = min(samples, key=lambda s: s["players"])
        peak, trough = peak_sample["players"], trough_sample["players"]
        out.append({
            "date_local": date_local,
            "peak": peak,
            "trough": trough,
            "mean": round(sum(values) / len(values)),
            "peak_hour": peak_sample.get("hour_local"),
            "trough_hour": trough_sample.get("hour_local"),
            # 峰谷比反映作息集中度：接近 1 说明全天平铺（多时区分散），
            # 明显大于 1 说明用户集中在某几个小时（单一时区主导）。
            "peak_trough_ratio": round(peak / trough, 2) if trough else None,
            "samples": len(samples),
            "status": OBSERVED if len(samples) >= min_samples else "partial",
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


def interaction_rates(stats: dict, platform: str = "bilibili") -> dict:
    """由一组计数字段派生互动率（百分比）。

    全部以播放量为分母 —— 这是唯一能让不同量级视频横向比较的口径。
    分母缺失时全部返回 None，不用 0 代替。
    """
    view = stats.get("view")
    numerators = INTERACTION_NUMERATORS.get(platform, ())
    total = None
    if view:
        parts = [stats.get(k) for k in numerators]
        if parts and all(p is not None for p in parts):
            total = sum(parts)

    rates = {"engagement": _rate(total, view)}
    for key, value in stats.items():
        if key == "view":
            continue
        rates[key] = _rate(value, view)
    return rates


def video_series(records: list[dict], platform: str = "bilibili",
                 stats_keys: tuple[str, ...] | None = None,
                 id_key: str = "bvid") -> dict[str, dict]:
    """按视频 ID 聚合公开计数的时间线、日增量与互动率。

    B 站与 YouTube 共用这一套：两边的字段名在采集器里已经统一成
    view/like/comment 这类平台无关的名字，差异只在字段集合与互动率分子。

    ramp 是「发布后第 N 天的累计播放」曲线，用于把不同时间发布的视频
    按各自的发布日对齐后比较 —— 拿当前累计播放直接比，等于拿上线一年的
    游戏和上线一周的游戏比总流水。

    曲线从首次采集到该视频那天开始，一直长到今天。发布当天就进采集表的
    视频 ramp.available=True，曲线含起跑段；事后补登记的视频首次采集拿到的
    已经是积累若干天的累计值，available=False，看板把这类曲线画成虚线并
    标出缺口 —— 缺起跑段不等于这条曲线没有价值，但不能假装它是完整的。
    """
    stats_keys = stats_keys or (BILI_STATS if platform == "bilibili" else YT_STATS)
    by_video: dict[str, dict] = {}

    for rec in sorted(records, key=lambda r: r["date_local"]):
        for v in rec.get("videos", []):
            bvid = v[id_key]
            slot = by_video.setdefault(bvid, {
                id_key: bvid,
                "title": v.get("title"),
                "character_id": v.get("character_id"),
                "character_name": v.get("character_name"),
                "version_id": v.get("version_id"),
                "version_confirmed": v.get("version_confirmed", False),
                "content_type": v.get("content_type"),
                "owner_mid": v.get("owner_mid"),
                "channel_id": v.get("channel_id"),
                # YouTube 的语区。B 站没有这个维度，留 None。
                # 不带下来的话，build_snapshot 就没法按语区分组。
                "locale": v.get("locale"),
                "platform": platform,
                "pubdate": v.get("pubdate"),
                "points": [],
            })
            # pubdate 以采集到的最新值为准（登记表可能填错，接口是事实）
            if v.get("pubdate"):
                slot["pubdate"] = v["pubdate"]
            slot["points"].append({
                "date_local": rec["date_local"],
                "days_since_pub": _days_between(rec["date_local"], v.get("pubdate")),
                "stats": {k: v.get(k) for k in stats_keys},
                "status": v.get("status", UNAVAILABLE),
            })

    for slot in by_video.values():
        prev_stats: dict[str, int] = {}
        prev_date = None

        for pt in slot["points"]:
            stats = pt["stats"]
            deltas: dict[str, int | None] = {}
            span = _days_between(pt["date_local"], prev_date) if prev_date else None

            for key in stats_keys:
                cur, prev = stats.get(key), prev_stats.get(key)
                deltas[key] = (cur - prev) if (cur is not None and prev is not None) else None

            pt["deltas"] = deltas
            pt["span_days"] = span
            pt["delta_status"] = DERIVED if deltas.get("view") is not None else UNAVAILABLE
            pt["rates"] = interaction_rates(stats, platform)

            if stats.get("view") is not None:
                prev_stats = {k: stats.get(k) for k in stats_keys
                              if stats.get(k) is not None}
                prev_date = pt["date_local"]

        observed = [p for p in slot["points"] if p["stats"].get("view") is not None]
        if observed:
            last = observed[-1]
            slot["latest"] = {
                "date_local": last["date_local"],
                "days_since_pub": last["days_since_pub"],
                "stats": last["stats"],
                "rates": last["rates"],
            }
            slot["latest_view"] = last["stats"]["view"]
            first_gap = observed[0]["days_since_pub"]
            # available 只描述「有没有拍到起跑段」，不再决定收多少个点：
            # 曲线要一直往后长，看板才能把同类视频按发布后天数叠在一起比。
            # 事后补登记的视频曲线从第 N 天才开始，缺口由 available=False
            # 标出来（看板画成虚线），而不是把整条曲线丢掉。
            # 允许 1 天误差：当天发布、次日首采仍能还原 D1 起的爬坡。
            slot["ramp"] = {
                "available": first_gap is not None and first_gap <= 1,
                "first_capture_days_since_pub": first_gap,
                "points": [{"day": p["days_since_pub"],
                            "view": p["stats"]["view"],
                            "view_delta": p["deltas"].get("view")}
                           for p in observed if p["days_since_pub"] is not None],
            }
        else:
            slot["latest"] = None
            slot["latest_view"] = None
            slot["ramp"] = {"available": False,
                            "first_capture_days_since_pub": None, "points": []}

    return by_video


# 旧名保留：MVP 期间的调用方与测试仍在使用
video_view_series = video_series


def video_totals(videos: dict[str, dict], platform: str = "bilibili") -> dict:
    """登记视频集合的合计与加权互动率。

    合计播放量不等于独立观众数 —— 同一个人看多个视频会被重复计入。
    加权互动率用合计分子 / 合计分母，避免小视频的极端比率拉偏均值。
    """
    stats_keys = BILI_STATS if platform == "bilibili" else YT_STATS
    totals = {k: 0 for k in stats_keys}
    counted = 0
    for slot in videos.values():
        latest = slot.get("latest")
        if not latest:
            continue
        counted += 1
        for key in stats_keys:
            value = latest["stats"].get(key)
            if value is not None:
                totals[key] += value
    if not counted:
        return {"videos": 0, "totals": None, "rates": None}
    return {"videos": counted, "totals": totals,
            "rates": interaction_rates(totals, platform)}


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


def indexed(points: list[dict], value_key: str = "value",
            base: float = 100.0) -> list[dict]:
    """首个有效值 = base 的指数化序列，用于不同量级游戏的趋势对比。

    绝对在线人数相差一个数量级的游戏放同一张图会互相压扁，
    指数化后比较的是「相对自己的变化」，这才是长线运营关心的东西。
    """
    out: list[dict] = []
    baseline = None
    for pt in points:
        value = pt.get(value_key)
        if value is None:
            out.append({**pt, "indexed": None, "index_status": UNAVAILABLE})
            continue
        if baseline is None:
            baseline = value
        if not baseline:
            out.append({**pt, "indexed": None, "index_status": UNAVAILABLE})
            continue
        out.append({**pt, "indexed": round(value / baseline * base, 2),
                    "index_status": DERIVED})
    return out


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
