"""从回填的评测明细里派生玩家结构指标。

数据来源是 collectors/steam_reviews_backfill.py 落盘的原始评测明细，
每条带 playtime_at_review / playtime_forever / steam_purchase / language。
这些字段一直躺在 data/raw/backfill/ 里没被用过，而它们能回答的问题
比「新增评测数」有价值得多：

  写评测时玩了多久   → 区分「首日冲动评测」与「长线玩家评测」
  评测后还玩不玩     → 公开数据能拿到的最接近留存的代理信号
  语种结构怎么变     → 版本/联动是否真的带来了新地区的玩家
  是不是 Steam 购买  → 非 Steam 渠道激活（外部发码、赠送）的比例

三个必须随图一起说明的口径限制
--------------------------------
1. **只能看到今天仍然存在的评测。** 被删除、隐藏或改为不公开的不会出现，
   越早的日期低估越多。整个模块的输出都标 reconstructed。
2. **playtime_forever 是「今天」的累计值，不是评测当天的值。**
   因此 playtime_forever - playtime_at_review = 评测之后到今天的游玩时长，
   它的观测窗口对老评测更长。直接比较不同日期的该值会得到
   「越老的评测玩得越多」这种纯粹由窗口长度造成的假结论。
   本模块因此同时输出按天归一化的 post_review_minutes_per_day，
   并把 observation_days 一并写出，让图表能说明自己在比什么。
3. **评测者不是玩家的随机样本。** 写评测的人本身就偏向重度或极端体验，
   这里的任何分布都只代表「评测者」，不代表玩家总体。
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import RAW_DIR  # noqa: E402

RECONSTRUCTED = "reconstructed"

# 分桶阈值（分钟）。2 小时是 Steam 自己的退款时长线，
# 用它切「还没玩明白就来评测」是有现实依据的，不是随便取的数。
SHORT_PLAY_MINUTES = 120
HEAVY_PLAY_MINUTES = 6000        # 100 小时
STILL_PLAYING_MINUTES = 60       # 评测后又玩了 1 小时以上才算「还在玩」

# 「评测后仍在玩」的观测窗口下限。窗口不足这个天数时该指标返回 None，
# 因为它必然接近 0 —— 今天写的评测，观测窗口是 0 天，谁也来不及「继续玩」。
# 实测未加这个闸门时，绝区零最后一天的 still_playing_share 是 21%，
# 而 90 天前那天是 90%，二者的差异 100% 由窗口长度造成，与留存无关。
MIN_OBSERVATION_DAYS = 14

# 语种结构里单独列出的语言数，其余归入 other
TOP_LANGUAGES = 8


def backfill_path(game_id: str) -> Path:
    return RAW_DIR / "backfill" / f"steam_reviews_{game_id}.json"


def load_reviews(game_id: str) -> tuple[list[dict], str | None]:
    """返回 (评测明细, 回填采集时间)。文件不存在时返回空列表。"""
    path = backfill_path(game_id)
    if not path.exists():
        return [], None
    with path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    return payload.get("reviews") or [], payload.get("collected_at")


def _date_of(review: dict) -> str | None:
    ts = review.get("timestamp_created")
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")


def _quantile(values: list[int], q: float) -> int | None:
    """朴素分位数：排序后取位置。样本量小，不做插值。"""
    if not values:
        return None
    ordered = sorted(values)
    idx = min(int(q * (len(ordered) - 1) + 0.5), len(ordered) - 1)
    return ordered[idx]


def _share(count: int, total: int) -> float | None:
    if total <= 0:
        return None
    return round(count / total * 100, 2)


def _observable(observation_days: int | None) -> bool:
    return bool(observation_days and observation_days >= MIN_OBSERVATION_DAYS)


def daily_profile(reviews: list[dict], collected_at: str | None = None) -> list[dict]:
    """按评测创建日聚合玩家结构。"""
    collected_date = None
    if collected_at:
        try:
            collected_date = datetime.fromisoformat(collected_at).date()
        except ValueError:
            collected_date = None

    by_date: dict[str, list[dict]] = defaultdict(list)
    for review in reviews:
        date_local = _date_of(review)
        if date_local:
            by_date[date_local].append(review)

    out: list[dict] = []
    for date_local in sorted(by_date):
        group = by_date[date_local]
        total = len(group)

        at_review = [r["playtime_at_review"] for r in group
                     if r.get("playtime_at_review") is not None]
        post_review = []
        post_per_day = []
        observation_days = None
        if collected_date:
            try:
                observation_days = (collected_date
                                    - datetime.strptime(date_local, "%Y-%m-%d").date()).days
            except ValueError:
                observation_days = None

        for r in group:
            forever = r.get("playtime_forever")
            at = r.get("playtime_at_review")
            if forever is None or at is None:
                continue
            # 极少数情况下 forever < at（Steam 侧统计修正），截到 0 而不是留负数
            delta = max(forever - at, 0)
            post_review.append(delta)
            if observation_days and observation_days > 0:
                post_per_day.append(delta / observation_days)

        languages = Counter(r.get("language") for r in group if r.get("language"))
        positive = sum(1 for r in group if r.get("voted_up"))
        purchased = sum(1 for r in group if r.get("steam_purchase"))
        free = sum(1 for r in group if r.get("received_for_free"))

        out.append({
            "date_local": date_local,
            "reviews": total,
            "positive": positive,
            "negative": total - positive,
            "review_rate": _share(positive, total),

            # 评测时点的游戏时长分布（分钟）
            "playtime_at_review_median": _quantile(at_review, 0.5),
            "playtime_at_review_p25": _quantile(at_review, 0.25),
            "playtime_at_review_p75": _quantile(at_review, 0.75),
            "short_play_share": _share(
                sum(1 for v in at_review if v < SHORT_PLAY_MINUTES), len(at_review)),
            "heavy_play_share": _share(
                sum(1 for v in at_review if v >= HEAVY_PLAY_MINUTES), len(at_review)),

            # 评测之后的游玩（留存代理），必须配合 observation_days 解读。
            # 窗口不足 MIN_OBSERVATION_DAYS 时一律返回 None：宁可留空，
            # 也不给出一个注定接近 0、会被误读成「留存崩了」的数字。
            "observation_days": observation_days,
            "observation_sufficient": bool(
                observation_days and observation_days >= MIN_OBSERVATION_DAYS),
            "post_review_minutes_median": (
                _quantile(post_review, 0.5) if _observable(observation_days) else None),
            "post_review_minutes_per_day": (
                round(median(post_per_day), 2)
                if post_per_day and _observable(observation_days) else None),
            "still_playing_share": (
                _share(sum(1 for v in post_review if v >= STILL_PLAYING_MINUTES),
                       len(post_review))
                if _observable(observation_days) else None),

            "steam_purchase_share": _share(purchased, total),
            "received_for_free_share": _share(free, total),

            "languages": dict(languages),
            "status": RECONSTRUCTED,
        })
    return out


def language_share_series(daily: list[dict], bucket_days: int = 7) -> dict:
    """语种构成随时间的变化。

    日粒度的语种分布在低评测量的日期噪声极大（一天十几条评测算不出占比），
    因此按 bucket_days 聚合。整体 top 语种由全区间决定，各桶用同一组语种，
    否则每个桶的图例都不一样，没法看出「谁在涨」。
    """
    if not daily:
        return {"bucket_days": bucket_days, "languages": [], "buckets": []}

    overall: Counter = Counter()
    for day in daily:
        overall.update(day.get("languages") or {})
    top = [lang for lang, _ in overall.most_common(TOP_LANGUAGES)]

    # 按日历窗口分桶，不按列表下标。没有评测的日期不会出现在 daily 里，
    # 按下标切会让「第 N 桶」的实际跨度随空洞漂移 —— 评测稀疏的游戏会
    # 得到一个跨越几个月、却标着 7 天的桶。
    from datetime import timedelta
    first_day = datetime.strptime(daily[0]["date_local"], "%Y-%m-%d").date()
    last_day = datetime.strptime(daily[-1]["date_local"], "%Y-%m-%d").date()
    by_date = {d["date_local"]: d for d in daily}

    buckets: list[dict] = []
    window_start = first_day
    while window_start <= last_day:
        window_end = window_start + timedelta(days=bucket_days - 1)
        chunk = [by_date[key] for key in (
            (window_start + timedelta(days=i)).isoformat()
            for i in range(bucket_days)) if key in by_date]
        counts: Counter = Counter()
        for day in chunk:
            counts.update(day.get("languages") or {})
        total = sum(counts.values())
        if not total:
            window_start = window_end + timedelta(days=1)
            continue
        shares = {lang: _share(counts.get(lang, 0), total) for lang in top}
        other = total - sum(counts.get(lang, 0) for lang in top)
        shares["other"] = _share(other, total)
        buckets.append({
            # 桶的边界是日历边界，不是「恰好有评测的那两天」，
            # 否则相邻桶的跨度不一致，占比变化没法比。
            "start": window_start.isoformat(),
            "end": min(window_end, last_day).isoformat(),
            "days_with_reviews": len(chunk),
            "reviews": total,
            "shares": shares,
            "counts": {lang: counts.get(lang, 0) for lang in top},
            "status": RECONSTRUCTED,
        })
        window_start = window_end + timedelta(days=1)

    return {
        "bucket_days": bucket_days,
        "languages": top + ["other"],
        "overall": {lang: overall[lang] for lang in top},
        "overall_total": sum(overall.values()),
        "buckets": buckets,
    }


# 参与版本前后对比的字段：既要有量（评测数），也要有质（好评率），
# 还要有玩家结构（时长分布），否则只能看出「热度变了」，
# 看不出「来的是什么人」。
#
# 这里**故意不包含** still_playing_share / post_review_* 这类留存代理。
# 它们依赖 playtime_forever 这个「今天的快照」，而版本更新日之后的窗口
# 必然比之前的窗口离今天更近、观测时间更短，所以前后对比一定会出现
# 一个向下的差值 —— 那是窗口长度的差，不是留存的差。把它放进对比表，
# 等于系统性地造出「每次版本更新后留存都下降」的假结论。
# 这类指标只在 daily 序列里按 observation_days 分组呈现。
WINDOW_FIELDS = (
    ("reviews", "日均新增评测", "sum_per_day"),
    ("review_rate", "区间好评率", "weighted_rate"),
    ("playtime_at_review_median", "评测时中位时长", "median_of_median"),
    ("short_play_share", "2 小时内评测占比", "weighted_share"),
    ("heavy_play_share", "100 小时以上评测占比", "weighted_share"),
)

# 受观测窗口长度影响、不可做跨时间对比的字段。
# version_windows 会拒绝计算它们的 change，即使有人把它们加进 WINDOW_FIELDS。
OBSERVATION_SENSITIVE = frozenset({
    "still_playing_share",
    "post_review_minutes_median",
    "post_review_minutes_per_day",
})


def _aggregate_window(days: list[dict], field: str, how: str) -> float | None:
    if not days:
        return None
    if how == "sum_per_day":
        total = sum(d.get(field) or 0 for d in days)
        return round(total / len(days), 2)
    if how == "weighted_rate":
        pos = sum(d.get("positive") or 0 for d in days)
        total = sum(d.get("reviews") or 0 for d in days)
        return round(pos / total * 100, 2) if total else None
    if how == "weighted_share":
        # 用评测数加权，避免「只有 3 条评测的那天」和「有 300 条的那天」等权
        num = sum((d.get(field) or 0) / 100 * (d.get("reviews") or 0) for d in days)
        total = sum(d.get("reviews") or 0 for d in days if d.get(field) is not None)
        return round(num / total * 100, 2) if total else None
    if how == "median_of_median":
        values = [d.get(field) for d in days if d.get(field) is not None]
        return round(median(values), 1) if values else None
    return None


def version_windows(daily: list[dict], boundaries: list[dict],
                    window: int = 7) -> list[dict]:
    """版本更新日前后各 window 天的玩家结构对比。

    只有前后窗口都完整的版本才纳入 —— 半个窗口的「变化」没有意义。
    输出的是并列的前后两组数字，不写因果判断：版本更新与数值变化
    在时间上相邻，不等于前者导致后者。
    """
    by_date = {d["date_local"]: d for d in daily}
    dates = sorted(by_date)
    if not dates:
        return []
    first, last = dates[0], dates[-1]

    results: list[dict] = []
    for boundary in boundaries:
        pivot = boundary.get("date_local")
        if not pivot:
            continue
        pivot_d = datetime.strptime(pivot, "%Y-%m-%d").date()
        before_dates = [d for d in dates
                        if 0 < (pivot_d - datetime.strptime(d, "%Y-%m-%d").date()).days <= window]
        after_dates = [d for d in dates
                       if 0 <= (datetime.strptime(d, "%Y-%m-%d").date() - pivot_d).days < window]

        complete = len(before_dates) == window and len(after_dates) == window
        before = [by_date[d] for d in before_dates]
        after = [by_date[d] for d in after_dates]

        comparisons = []
        for field, label, how in WINDOW_FIELDS:
            b = _aggregate_window(before, field, how)
            a = _aggregate_window(after, field, how)
            change = None
            change_kind = None
            confounded = field in OBSERVATION_SENSITIVE
            if b is not None and a is not None and not confounded:
                if how in ("weighted_rate", "weighted_share"):
                    change = round(a - b, 2)      # 百分点
                    change_kind = "pp"
                elif b:
                    change = round((a - b) / b * 100, 1)   # 相对百分比
                    change_kind = "pct"
            entry = {
                "field": field, "label": label,
                "before": b, "after": a,
                "change": change, "change_kind": change_kind,
            }
            if confounded:
                entry["confounded"] = "observation_window"
                entry["note"] = ("该指标依赖今天的累计游玩时长快照，"
                                 "更新日之后的窗口观测时间必然更短，前后差值不可解读")
            comparisons.append(entry)

        results.append({
            "version_id": boundary.get("version_id"),
            "date_local": pivot,
            "title": boundary.get("title"),
            "source_url": boundary.get("source_url"),
            "window": window,
            "complete": complete,
            "before_days": len(before_dates),
            "after_days": len(after_dates),
            "coverage_note": (
                "" if complete else
                f"前后窗口不完整（前 {len(before_dates)}/{window} 天，"
                f"后 {len(after_dates)}/{window} 天），"
                f"评测历史仅覆盖 {first} → {last}"),
            "comparisons": comparisons,
            "status": RECONSTRUCTED,
        })

    results.sort(key=lambda r: r["date_local"])
    return results


def build(game_id: str, boundaries: list[dict] | None = None,
          window: int = 7) -> dict | None:
    """组装一个游戏的完整玩家结构档案。回填文件不存在时返回 None。"""
    reviews, collected_at = load_reviews(game_id)
    if not reviews:
        return None

    daily = daily_profile(reviews, collected_at)
    return {
        "method": "appreviews_backfill",
        "status": RECONSTRUCTED,
        "collected_at": collected_at,
        "total_reviews": len(reviews),
        "coverage": {"start": daily[0]["date_local"],
                     "end": daily[-1]["date_local"],
                     "days": len(daily)} if daily else None,
        "daily": daily,
        "language_share": language_share_series(daily),
        "version_windows": version_windows(daily, boundaries or [], window),
        "caveats": [
            "仅含今天仍然存在的评测，越早的日期越可能低估当日真实值",
            "playtime_forever 为今天的累计值，评测后时长需按 observation_days 归一化后比较",
            "评测者不是玩家的随机样本，分布只代表评测者",
        ],
    }
