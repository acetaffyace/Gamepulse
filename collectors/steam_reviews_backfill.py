"""Steam 评测明细回填（appreviews 游标翻页，每条评测带创建时间）。

两种模式：
  全量（每周）   枚举当时仍存在的全部评测，在一个事务里整体替换该游戏的评测集合。
                 删评、改评在这时更新；翻页没有完整结束时不替换，保留上一次的完整集合。
  增量（每日）   从上次全量日期往前 3 天开始重新拉取近期评测，新增或更新到评测表。
                 全量之后被删除的旧评测会暂时保留，等下一次全量校准。

口径（必须随图表一起说明）：只能看到当时仍存在的评测，所以某日的评测数不是当日的原始精确新增；
好评率按创建日统计，与商店显示的累计好评率口径不同。fact_source 里登记为 reconstructed。

翻页进度逐页落盘（collectors/review_checkpoint.py），中断后 48 小时内可以接着翻。

    python collectors/steam_reviews_backfill.py --game wuthering_waves
    python collectors/steam_reviews_backfill.py --game wuthering_waves --incremental
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import (  # noqa: E402
    RAW_DIR, active_games, business_date, file_lock, get_game, get_json, now_iso, polite_sleep, run_per_game,
    session, today_local,
)
from collectors.review_checkpoint import ReviewCheckpoint  # noqa: E402
from store import config_sync, db  # noqa: E402

REVIEWS_URL = "https://store.steampowered.com/appreviews/{appid}"
PAGE_SIZE = 100
INCREMENTAL_OVERLAP_DAYS = 3
COMPLETE_STOPS = {"empty_page", "cursor_exhausted", "no_new_reviews"}
# 翻页进度文件里存的是接口原样的评测；v2 存的是拍平后的行（时长不在 author 下）。
# 查询条件带上格式版本，切换到 v3 后不会误续 v2 留下的进度。
CHECKPOINT_FORMAT = 3


def review_row(review: dict, game_id: str, seen_at: str) -> dict | None:
    if not review.get("recommendationid") or not review.get("timestamp_created"):
        return None
    author = review.get("author") or review   # 兼容拍平格式：时长字段直接在顶层
    flag = lambda v: int(v) if isinstance(v, bool) else None   # noqa: E731 —— 缺失记 NULL，不能当作差评
    return {
        "review_id": int(review["recommendationid"]), "game_id": game_id,
        "created_at": int(review["timestamp_created"]), "created_date": business_date(review["timestamp_created"]),
        "voted_up": flag(review.get("voted_up")), "language": review.get("language"),
        "playtime_at_review": author.get("playtime_at_review"), "playtime_forever": author.get("playtime_forever"),
        "steam_purchase": flag(review.get("steam_purchase")), "received_for_free": flag(review.get("received_for_free")),
        "last_seen_at": seen_at,
    }


def _page(sess, appid: int, cursor: str) -> tuple[dict | None, str]:
    payload, status = get_json(sess, REVIEWS_URL.format(appid=appid), {
        "json": 1, "num_per_page": PAGE_SIZE, "language": "all", "purchase_type": "all",
        "filter": "recent", "cursor": cursor,
    }, timeout=30)
    if status != "ok" or payload.get("success") != 1:
        return None, f"request_failed:{status}"
    return payload, ""


def fetch_all_reviews(appid: int, max_pages: int | None = None, sleep: float = 1.0,
                      checkpoint: Path | None = None) -> tuple[list[dict], dict]:
    """按 filter=recent 游标翻页枚举全部评测。

    max_pages 省略时按接口声明的总数推算并留 30% 余量。固定上限会在评测多的游戏上静默截断：
    鸣潮 55,783 条需要 558 页，早先的 400 页上限只覆盖 71.7%，而且没有任何提示。
    """
    sess = session()
    if max_pages is None:
        probe, _ = get_json(sess, REVIEWS_URL.format(appid=appid),
                            {"json": 1, "num_per_page": 0, "language": "all", "purchase_type": "all"}, timeout=30)
        total = ((probe or {}).get("query_summary") or {}).get("total_reviews")
        max_pages = int(total / PAGE_SIZE * 1.3) + 20 if total else 500
        polite_sleep(.8)
    saved = ReviewCheckpoint(checkpoint, {"appid": appid, "mode": "full", "filter": "recent",
                                          "page_size": PAGE_SIZE, "format": CHECKPOINT_FORMAT})
    cursor, reviews = saved.state["cursor"], saved.rows
    seen_ids = {r["recommendationid"] for r in reviews}
    seen_cursors = set(saved.state["seen_cursors"])
    total_expected, pages = saved.state["total_expected"], saved.state["pages"]
    stop_reason = "max_pages"
    while pages < max_pages:
        payload, err = _page(sess, appid, cursor)
        pages += 1
        if payload is None:
            stop_reason = err
            break
        if total_expected is None:
            total_expected = (payload.get("query_summary") or {}).get("total_reviews")
        batch = payload.get("reviews") or []
        if not batch:
            stop_reason = "empty_page"
            break
        fresh = [r for r in batch if r.get("recommendationid") and r["recommendationid"] not in seen_ids]
        seen_ids.update(r["recommendationid"] for r in fresh)
        reviews.extend(fresh)
        next_cursor = payload.get("cursor")
        if not next_cursor or next_cursor in seen_cursors:
            stop_reason = "cursor_exhausted"
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
        saved.commit(fresh, cursor, seen_cursors, pages, total_expected)
        if not fresh:
            stop_reason = "no_new_reviews"
            break
        if pages % 20 == 0:
            print(f"  已翻 {pages} 页，累计 {len(reviews):,} 条")
        time.sleep(sleep)
    # started_at 是这次翻页真正开始的时刻（续翻时是最初那次的开始时刻），只有它之前创建的评测才一定翻到过
    return reviews, {"pages": pages, "fetched": len(reviews), "total_expected": total_expected,
                     "stop_reason": stop_reason, "started_at": saved.state["created_at"]}


def fetch_recent_reviews(appid: int, cutoff: str, sleep: float = 1.0, max_pages: int = 300,
                         checkpoint: Path | None = None) -> tuple[list[dict], dict]:
    """拉取创建日不早于 cutoff 的评测，翻到整页都早于 cutoff 为止。"""
    sess = session()
    saved = ReviewCheckpoint(checkpoint, {"appid": appid, "mode": "recent", "cutoff": cutoff,
                                          "page_size": PAGE_SIZE, "format": CHECKPOINT_FORMAT})
    cursor, reviews = saved.state["cursor"], saved.rows
    seen_ids = {r["recommendationid"] for r in reviews}
    seen_cursors = set(saved.state["seen_cursors"])
    expected, pages = saved.state["total_expected"], saved.state["pages"]
    stop_reason = "max_pages"
    while pages < max_pages:
        payload, err = _page(sess, appid, cursor)
        pages += 1
        if payload is None:
            stop_reason = err
            break
        if expected is None:
            expected = (payload.get("query_summary") or {}).get("total_reviews")
        batch = payload.get("reviews") or []
        if not batch:
            stop_reason = "empty_page"
            break
        fresh = [r for r in batch if r.get("recommendationid") and r["recommendationid"] not in seen_ids
                 and r.get("timestamp_created") and business_date(r["timestamp_created"]) >= cutoff]
        seen_ids.update(r["recommendationid"] for r in fresh)
        reviews.extend(fresh)
        stamps = [r.get("timestamp_created") for r in batch]
        if stamps and all(stamps) and business_date(max(stamps)) < cutoff:
            stop_reason = "cutoff_reached"
            break
        next_cursor = payload.get("cursor")
        if not next_cursor or next_cursor in seen_cursors:
            stop_reason = "cursor_exhausted"
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
        saved.commit(fresh, cursor, seen_cursors, pages, expected)
        if pages % 20 == 0:
            print(f"  已翻 {pages} 页，窗口内 {len(reviews):,} 条", flush=True)
        time.sleep(sleep)
    return reviews, {"pages": pages, "fetched": len(reviews), "total_expected": expected,
                     "stop_reason": stop_reason, "cutoff": cutoff, "started_at": saved.state["created_at"]}


def complete_full(meta: dict, previous_total: int) -> str:
    """全量是否可以替换旧集合。返回不能替换的原因，可以时返回空字符串。"""
    if meta["stop_reason"] not in COMPLETE_STOPS:
        return f"incomplete:{meta['stop_reason']}"
    expected = meta.get("total_expected")
    if expected and meta["fetched"] / expected < 0.95:
        return f"coverage:{meta['fetched']}/{expected}"
    # 总数探测本身也可能失败：看似正常结束却突然少了很多旧评测时，保留上一次的完整集合
    if previous_total and meta["fetched"] < previous_total * 0.98:
        return f"shrank:{meta['fetched']}<{previous_total}"
    return ""


def _started(meta: dict) -> tuple[int, str]:
    """(开始时刻的 Unix 秒, 开始时刻所在的业务日)。缺失时按现在处理。"""
    started = datetime.fromisoformat(meta.get("started_at") or now_iso())
    return int(started.timestamp()), business_date(started.isoformat())


def run_full(conn, game: dict, max_pages: int | None, sleep: float) -> tuple[int, int, str]:
    """全量回填：替换该游戏在"这次翻页开始之前"创建的评测。

    翻页可能从 48 小时内的旧进度续上，开始之后才出现的评测它看不到；这些评测（通常是增量回填存进来的）
    必须保留，否则会被当成已删除。覆盖范围也只到开始那一天，那一天本身不算完整日。
    """
    gid = game["game_id"]
    checkpoint = RAW_DIR / "backfill" / "checkpoints" / gid / "full.json"
    raw, meta = fetch_all_reviews(game["steam_app_id"], max_pages, sleep, checkpoint)
    start_ts, start_day = _started(meta)
    previous = conn.execute("SELECT COUNT(*) FROM review WHERE game_id = ? AND created_at < ?", (gid, start_ts)).fetchone()[0]
    problem = complete_full(meta, previous)
    print(f"  {game['display_name']}: 翻页 {meta['pages']} 页，取到 {meta['fetched']:,} 条"
          f"（接口声明 {meta['total_expected']}），停止原因 {meta['stop_reason']}")
    if problem:
        print(f"  全量未完整结束（{problem}），保留原有评测集合，下次自动重试")
        return 1, 0, problem
    seen_at = now_iso()
    rows = [r for r in (review_row(x, gid, seen_at) for x in raw) if r]
    with db.transaction(conn):
        conn.execute("DELETE FROM review WHERE game_id = ? AND created_at < ?", (gid, start_ts))
        db.upsert(conn, "review", rows)
        db.insert(conn, "review_run", [{"game_id": gid, "mode": "full", "finished_at": seen_at,
                                        "covered_through": start_day, "cutoff": None, "pages": meta["pages"],
                                        "fetched": meta["fetched"], "total_expected": meta["total_expected"],
                                        "stop_reason": meta["stop_reason"]}])
    ReviewCheckpoint.finish(checkpoint)
    return 1, 1, ""


def run_incremental(conn, game: dict, sleep: float) -> tuple[int, int, str] | None:
    """没有全量基底时返回 None，由调用方改做全量。"""
    gid = game["game_id"]
    last_full = conn.execute("SELECT covered_through FROM review_run WHERE game_id = ? AND mode = 'full' "
                             "ORDER BY finished_at DESC LIMIT 1", (gid,)).fetchone()
    if not last_full:
        return None
    cutoff = (date.fromisoformat(last_full[0]) - timedelta(days=INCREMENTAL_OVERLAP_DAYS)).isoformat()
    checkpoint = RAW_DIR / "backfill" / "checkpoints" / gid / "recent.json"
    raw, meta = fetch_recent_reviews(game["steam_app_id"], cutoff, sleep, checkpoint=checkpoint)
    earliest = conn.execute("SELECT MIN(created_date) FROM review WHERE game_id = ?", (gid,)).fetchone()[0]
    reached = meta["stop_reason"] == "cutoff_reached" or (
        meta["stop_reason"] == "empty_page" and (earliest is None or earliest >= cutoff))
    if not reached:
        print(f"  增量未到达重叠边界 {cutoff}（{meta['stop_reason']}），不写入")
        return 1, 0, f"incomplete:{meta['stop_reason']}"
    seen_at = now_iso()
    rows = [r for r in (review_row(x, gid, seen_at) for x in raw) if r]
    ids = [r["review_id"] for r in rows]
    known = set()
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        known.update(r[0] for r in conn.execute(
            f"SELECT review_id FROM review WHERE review_id IN ({','.join('?' * len(chunk))})", chunk))
    total_after = conn.execute("SELECT COUNT(*) FROM review WHERE game_id = ?", (gid,)).fetchone()[0] + \
        len(set(ids) - known)
    expected = meta.get("total_expected")
    if expected and total_after / expected < 0.95:
        print(f"  合并后只覆盖接口总量 {total_after}/{expected}，不写入")
        return 1, 0, f"coverage:{total_after}/{expected}"
    with db.transaction(conn):
        db.upsert(conn, "review", rows)
        db.insert(conn, "review_run", [{"game_id": gid, "mode": "incremental", "finished_at": seen_at,
                                        "covered_through": _started(meta)[1], "cutoff": cutoff, "pages": meta["pages"],
                                        "fetched": meta["fetched"], "total_expected": expected,
                                        "stop_reason": meta["stop_reason"]}])
    ReviewCheckpoint.finish(checkpoint)
    print(f"  {game['display_name']}: 增量 {meta['pages']} 页，近期 {len(rows)} 条（新增 {len(set(ids) - known)}）")
    return 1, 1, ""


def run(conn, games: list[dict], date_local: str, *, incremental: bool, max_pages: int | None = None,
        sleep: float = 1.0, since: str | None = None) -> bool:
    def one(c, game, _day):
        if not game.get("steam_app_id"):
            return 0, 0, "no_steam_app_id"
        # 同一游戏的回填不能并发：翻页进度文件是按游戏存的
        with file_lock(RAW_DIR / "backfill" / f"{game['game_id']}.operation", timeout=1):
            if since:
                return run_window(c, game, since, sleep, max_pages or 1000)
            if incremental:
                result = run_incremental(c, game, sleep)
                if result is not None:
                    return result
                print(f"  {game['display_name']}: 还没有全量基底，改做全量")
            return run_full(c, game, max_pages, sleep)

    source = "reviews_window" if since else "reviews_incremental" if incremental else "reviews_full"
    return run_per_game(conn, source, games, date_local, one)


def run_window(conn, game: dict, cutoff: str, sleep: float, max_pages: int) -> tuple[int, int, str]:
    """只回填指定日期之后的评测，独立记录覆盖区间；失败不写入。"""
    date.fromisoformat(cutoff)
    gid = game["game_id"]
    checkpoint = RAW_DIR / "backfill" / "checkpoints" / gid / "window.json"
    raw, meta = fetch_recent_reviews(game["steam_app_id"], cutoff, sleep, max_pages, checkpoint)
    print(f"  {game['display_name']}: 窗口回填 {meta['pages']} 页，{meta['fetched']:,} 条，{meta['stop_reason']}")
    if meta["stop_reason"] not in {"cutoff_reached", "empty_page"}:
        return 1, 0, f"incomplete:{meta['stop_reason']}"
    if meta["stop_reason"] == "empty_page" and meta.get("total_expected") and not raw:
        return 1, 0, "unexpected_empty_page"
    if any(review_row(r, gid, "x") is None for r in raw):
        return 1, 0, "invalid_review_rows"
    start_ts, start_day = _started(meta)
    if cutoff > start_day:
        return 1, 0, "cutoff_after_collection_start"
    seen_at = now_iso()
    rows = [review_row(r, gid, seen_at) for r in raw]
    # 防止异常空响应/异常缩减把已知窗口删空。
    previous = conn.execute("SELECT COUNT(*) FROM review WHERE game_id=? AND created_date>=? AND created_at<?",
                            (gid, cutoff, start_ts)).fetchone()[0]
    if previous and len(rows) < previous * .98:
        return 1, 0, f"shrank:{len(rows)}<{previous}"
    with db.transaction(conn):
        conn.execute("DELETE FROM review WHERE game_id=? AND created_date>=? AND created_at<?", (gid, cutoff, start_ts))
        db.upsert(conn, "review", rows)
        db.insert(conn, "review_window_run", [{"game_id": gid, "cutoff": cutoff, "covered_through": start_day,
            "finished_at": seen_at, "pages": meta["pages"], "fetched": len(rows), "stop_reason": meta["stop_reason"]}])
    ReviewCheckpoint.finish(checkpoint)
    return 1, 1, f"covered:{cutoff}:{start_day}"


def main() -> int:
    parser = argparse.ArgumentParser(description="回填 Steam 评测明细")
    parser.add_argument("--game", help="省略则回填全部 active 游戏")
    parser.add_argument("--incremental", action="store_true", help="只刷新近期评测；没有全量基底时改做全量")
    parser.add_argument("--since", help="只回填此业务日之后的评测，记录窗口覆盖，不要求全历史基底")
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--sleep", type=float, default=1.0, help="翻页间隔秒数")
    args = parser.parse_args()
    conn = db.connect()
    try:
        config_sync.sync(conn)
        games = [get_game(args.game)] if args.game else active_games()
        return int(run(conn, games, today_local(), incremental=args.incremental,
                       max_pages=args.max_pages, sleep=args.sleep, since=args.since))
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
