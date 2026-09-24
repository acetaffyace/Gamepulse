"""回填 Steam 评测历史。

Steam 的 appreviews 接口支持游标翻页，每条评测带 timestamp_created。
每周全量枚举仍可见评测，每日仅补近期评测，按创建日重建历史曲线。

口径限制（必须随图表一起说明）：
  1. 全量运行只能看到当时仍存在的评测。日常增量会暂时保留全量之后被删除的
     旧评测，等每周全量校准；回填出的某日评测数不是当日原始精确新增。
  2. 好评率按创建日累计计算，与 Steam 商店当日显示的好评率不完全等价
     （商店口径含删除评测、且有「最近评测」独立分段）。
  3. 因此回填序列标记为 reconstructed，与逐日采集的 observed 分开存放，
     dashboard 上用不同样式区分。

用法：
    python collectors/steam_reviews_backfill.py --game zenless_zone_zero
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    RAW_DIR,
    get_game,
    get_json,
    log_collection,
    now_iso,
    polite_sleep,
    read_series,
    session,
    today_local,
    write_json,
    series_path,
)

REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
PAGE_SIZE = 100
RECONSTRUCTED = "reconstructed"
INCREMENTAL_OVERLAP_DAYS = 3


def review_row(review: dict) -> dict:
    author = review.get("author") or {}
    return {
        "recommendationid": review.get("recommendationid"),
        "timestamp_created": review.get("timestamp_created"),
        "voted_up": bool(review.get("voted_up")),
        "language": review.get("language"),
        "playtime_forever": author.get("playtime_forever"),
        "playtime_at_review": author.get("playtime_at_review"),
        "steam_purchase": review.get("steam_purchase"),
        "received_for_free": review.get("received_for_free"),
    }


def fetch_all_reviews(appid: int, max_pages: int | None = None,
                      sleep: float = 1.0) -> tuple[list[dict], dict]:
    """按 filter=recent 游标翻页枚举全部评测。

    max_pages 为 None 时，先读一次 query_summary 按总评测数推算所需页数
    并留 30% 余量。固定上限（早先为 400）会在评测量大的游戏上静默截断：
    鸣潮 55,783 条需要 558 页，400 页只能覆盖 71.7%，且失败得毫无提示。
    """
    sess = session()

    if max_pages is None:
        probe, status = get_json(sess, REVIEWS_URL.format(appid=appid),
                                 {"json": 1, "num_per_page": 0, "language": "all",
                                  "purchase_type": "all"}, timeout=30)
        total = ((probe or {}).get("query_summary") or {}).get("total_reviews")
        max_pages = int(total / PAGE_SIZE * 1.3) + 20 if total else 500
        print(f"  接口声明 {total:,} 条，自动设定翻页上限 {max_pages} 页"
              if total else "  无法读取总数，使用默认上限 500 页")
        polite_sleep(0.8)

    cursor = "*"
    seen_ids: set[str] = set()
    reviews: list[dict] = []
    seen_cursors: set[str] = set()
    total_expected = None
    pages = 0
    stop_reason = "max_pages"

    while pages < max_pages:
        params = {
            "json": 1, "num_per_page": PAGE_SIZE, "language": "all",
            "purchase_type": "all", "filter": "recent", "cursor": cursor,
        }
        payload, status = get_json(sess, REVIEWS_URL.format(appid=appid), params,
                                   timeout=30)
        pages += 1
        if status != "ok" or not payload or payload.get("success") != 1:
            stop_reason = f"request_failed:{status}"
            break

        if total_expected is None:
            total_expected = (payload.get("query_summary") or {}).get("total_reviews")

        batch = payload.get("reviews") or []
        if not batch:
            stop_reason = "empty_page"
            break

        new_in_batch = 0
        for r in batch:
            rid = r.get("recommendationid")
            if rid in seen_ids:
                continue
            seen_ids.add(rid)
            new_in_batch += 1
            reviews.append(review_row(r))

        next_cursor = payload.get("cursor")
        if not next_cursor or next_cursor in seen_cursors:
            stop_reason = "cursor_exhausted"
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor

        if new_in_batch == 0:
            stop_reason = "no_new_reviews"
            break

        if pages % 20 == 0:
            print(f"  已翻 {pages} 页，累计 {len(reviews):,} 条")
        time.sleep(sleep)

    meta = {
        "pages": pages, "collected": len(reviews),
        "total_expected": total_expected, "stop_reason": stop_reason,
    }
    return reviews, meta


def fetch_recent_reviews(appid: int, cutoff: str, sleep: float = 1.0,
                         max_pages: int = 300) -> tuple[list[dict], dict]:
    """Fetch recent created reviews until the full-backfill overlap is reached."""
    sess = session()
    cursor = "*"
    seen_ids: set[str] = set()
    seen_cursors: set[str] = set()
    reviews: list[dict] = []
    expected = None
    pages = 0
    stop_reason = "max_pages"
    while pages < max_pages:
        payload, status = get_json(sess, REVIEWS_URL.format(appid=appid), {
            "json": 1, "num_per_page": PAGE_SIZE, "language": "all",
            "purchase_type": "all", "filter": "recent", "cursor": cursor,
        }, timeout=30)
        pages += 1
        if status != "ok" or not payload or payload.get("success") != 1:
            stop_reason = f"request_failed:{status}"
            break
        if expected is None:
            expected = (payload.get("query_summary") or {}).get("total_reviews")
        batch = payload.get("reviews") or []
        if not batch:
            stop_reason = "empty_page"
            break
        for row in batch:
            rid = row.get("recommendationid")
            if rid is None or rid in seen_ids:
                continue
            seen_ids.add(rid)
            timestamp = row.get("timestamp_created")
            if timestamp and time.strftime("%Y-%m-%d", time.localtime(timestamp)) >= cutoff:
                reviews.append(review_row(row))
        timestamps = [r.get("timestamp_created") for r in batch]
        if timestamps and all(timestamps) and (
            time.strftime("%Y-%m-%d", time.localtime(max(timestamps))) < cutoff
        ):
            stop_reason = "cutoff_reached"
            break
        next_cursor = payload.get("cursor")
        if not next_cursor or next_cursor in seen_cursors:
            stop_reason = "cursor_exhausted"
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
        time.sleep(sleep)
    return reviews, {
        "pages": pages, "fetched": len(reviews), "total_expected": expected,
        "stop_reason": stop_reason, "cutoff": cutoff,
    }


def aggregate_by_date(reviews: list[dict],
                      through_date: str | None = None) -> list[dict]:
    """按创建日聚合；已覆盖区间内没有存活评测的日期明确记为零。"""
    daily = defaultdict(lambda: {"new_reviews": 0, "new_positive": 0,
                                 "new_negative": 0,
                                 "languages": defaultdict(int)})
    for r in reviews:
        ts = r.get("timestamp_created")
        if not ts:
            continue
        date_local = time.strftime("%Y-%m-%d", time.localtime(ts))
        slot = daily[date_local]
        slot["new_reviews"] += 1
        if r["voted_up"]:
            slot["new_positive"] += 1
        else:
            slot["new_negative"] += 1
        if r.get("language"):
            slot["languages"][r["language"]] += 1

    if not daily:
        return []

    first = date.fromisoformat(min(daily))
    last = date.fromisoformat(max(daily))
    if through_date:
        last = max(last, date.fromisoformat(through_date))

    out = []
    cum_total = cum_pos = 0
    cursor = first
    while cursor <= last:
        date_local = cursor.isoformat()
        slot = daily[date_local]
        cum_total += slot["new_reviews"]
        cum_pos += slot["new_positive"]
        out.append({
            "date_local": date_local,
            "new_reviews": slot["new_reviews"],
            "new_positive": slot["new_positive"],
            "new_negative": slot["new_negative"],
            "cumulative_reviews": cum_total,
            "cumulative_positive": cum_pos,
            "cumulative_review_rate": round(cum_pos / cum_total * 100, 2),
            "daily_review_rate": (
                round(slot["new_positive"] / slot["new_reviews"] * 100, 2)
                if slot["new_reviews"] else None
            ),
            "top_languages": dict(sorted(slot["languages"].items(),
                                         key=lambda kv: -kv[1])[:5]),
            "status": RECONSTRUCTED,
        })
        cursor += timedelta(days=1)
    return out


def complete_backfill(meta: dict, previous_total: int = 0) -> bool:
    """A partial API walk must never replace the last complete history."""
    if meta.get("truncated"):
        return False
    if meta.get("stop_reason") not in {
        "empty_page", "cursor_exhausted", "no_new_reviews",
    }:
        return False
    collected = meta.get("collected", 0)
    expected = meta.get("total_expected")
    if expected and collected / expected < 0.95:
        return False
    # Summary probes can themselves fail. Keep the previous full history if a
    # seemingly normal cursor stop would suddenly discard many old reviews.
    return not previous_total or collected >= previous_total * 0.98


def write_review_history(game_id: str, daily: list[dict]) -> None:
    path = series_path(game_id, "review_history")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for row in daily:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def incremental_backfill(game_id: str, appid: int,
                         sleep: float) -> int | None:
    """Refresh recent review counts without pretending old profile data is new.

    The full raw file stays intact for playtime/language analysis. Only the
    review-history daily series uses the merged recent review IDs; a weekly
    full walk reconciles deletions and refreshes profile fields.
    """
    full_path = RAW_DIR / "backfill" / f"steam_reviews_{game_id}.json"
    if not full_path.exists():
        return None
    with full_path.open("r", encoding="utf-8") as fh:
        full = json.load(fh)
    full_reviews = full.get("reviews") or []
    full_date = full.get("collected_at")
    if not full_reviews or not full_date:
        return None
    base_run_id = full.get("collected_at_utc") or full_date
    cutoff = (date.fromisoformat(full_date)
              - timedelta(days=INCREMENTAL_OVERLAP_DAYS)).isoformat()
    recent, meta = fetch_recent_reviews(appid, cutoff, sleep=sleep)
    earliest = min(time.strftime("%Y-%m-%d", time.localtime(r["timestamp_created"]))
                   for r in full_reviews if r.get("timestamp_created"))
    complete = (meta["stop_reason"] == "cutoff_reached" or
                (meta["stop_reason"] == "empty_page" and earliest >= cutoff))
    if not complete:
        print(f"增量回填未到达重叠边界 {cutoff}：{meta['stop_reason']}；保留旧历史")
        return 1

    incremental_path = (RAW_DIR / "backfill" /
                        f"steam_reviews_incremental_{game_id}.json")
    incremental = {}
    if incremental_path.exists():
        with incremental_path.open("r", encoding="utf-8") as fh:
            saved = json.load(fh)
        if saved.get("base_run_id") == base_run_id:
            incremental = {
                str(r["recommendationid"]): r
                for r in saved.get("reviews", []) if r.get("recommendationid")
            }
    incremental.update({
        str(r["recommendationid"]): r
        for r in recent if r.get("recommendationid")
    })
    merged = {
        str(r["recommendationid"]): r
        for r in full_reviews if r.get("recommendationid")
    }
    merged.update(incremental)
    expected = meta.get("total_expected")
    if expected and len(merged) / expected < 0.95:
        print(f"增量合并仅覆盖接口总量 {len(merged)}/{expected}；保留旧历史")
        return 1
    daily = aggregate_by_date(list(merged.values()), through_date=today_local())
    if not daily:
        print("增量合并后没有可聚合评测；保留旧历史")
        return 1

    write_json(incremental_path, {
        "base_run_id": base_run_id, "base_collected_at": full_date,
        "collected_at": today_local(), "meta": meta,
        "reviews": list(incremental.values()),
    })
    write_review_history(game_id, daily)
    log_collection("steam_reviews_incremental", game_id, today_local(),
                   "backfill", f"pages={meta['pages']};recent={len(recent)}"
                   f";merged={len(merged)};cutoff={cutoff}")
    print(f"增量回填成功：{meta['pages']} 页、近期 {len(recent)} 条，"
          f"合并后 {len(merged)} 条；历史覆盖至 {daily[-1]['date_local']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="回填 Steam 评测历史")
    parser.add_argument("--game", required=True)
    parser.add_argument("--max-pages", type=int, default=None,
                        help="翻页上限；省略则按接口声明的总评测数自动推算")
    parser.add_argument("--sleep", type=float, default=1.0,
                        help="翻页间隔秒数，默认 1.0")
    parser.add_argument("--incremental", action="store_true",
                        help="基于上次完整回填只刷新近期评测；无完整基底时回退全量")
    args = parser.parse_args()

    game = get_game(args.game)
    appid = game.get("steam_app_id")
    if not appid:
        print(f"{args.game} 未配置 steam_app_id")
        return 1

    if args.incremental:
        result = incremental_backfill(args.game, appid, args.sleep)
        if result is not None:
            return result
        print("尚无完整回填基底，执行全量回填")

    print(f"开始回填 {game.get('display_name')} (appid={appid}) 的评测历史…")
    reviews, meta = fetch_all_reviews(appid, args.max_pages, args.sleep)

    print(f"\n翻页结束：{meta['pages']} 页，采集 {meta['collected']:,} 条，"
          f"接口声明总数 {meta['total_expected']:,}，停止原因 {meta['stop_reason']}")
    if meta["total_expected"]:
        ratio = meta["collected"] / meta["total_expected"] * 100
        print(f"覆盖率：{ratio:.1f}%")
    previous_rows = read_series(args.game, "review_history")
    previous_total = (previous_rows[-1].get("cumulative_reviews") or 0
                      if previous_rows else 0)
    if not complete_backfill(meta, previous_total):
        print("回填未完整结束；保留原有 review_history.jsonl，等待下次自动重试。")
        return 1

    daily = aggregate_by_date(reviews, through_date=today_local())
    if not daily:
        print("没有可聚合的评测")
        return 1

    write_json(RAW_DIR / "backfill" / f"steam_reviews_{args.game}.json",
               {"meta": meta, "collected_at": today_local(),
                "collected_at_utc": now_iso(), "reviews": reviews})
    write_review_history(args.game, daily)

    log_collection("steam_reviews_backfill", args.game, today_local(),
                   "backfill", f"days={len(daily)};reviews={meta['collected']}")

    print(f"\n重建出 {len(daily)} 天评测历史：{daily[0]['date_local']} → "
          f"{daily[-1]['date_local']}")
    print(f"最终累计好评率：{daily[-1]['cumulative_review_rate']}%")
    print("\n最近 10 天：")
    print(f"  {'日期':<12}{'新增':>7}{'好评':>7}{'差评':>7}{'当日好评率':>11}")
    for row in daily[-10:]:
        daily_rate = (f"{row['daily_review_rate']:.1f}%"
                      if row["daily_review_rate"] is not None else "—")
        print(f"  {row['date_local']:<12}{row['new_reviews']:>7}"
              f"{row['new_positive']:>7}{row['new_negative']:>7}"
              f"{daily_rate:>11}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
