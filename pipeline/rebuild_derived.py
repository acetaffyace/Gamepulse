"""Rebuild business dates from archived evidence; never fetch or invent observations."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from collectors.common import RAW_DIR, load_games, read_series, series_path, file_lock, atomic_write_text, business_date
from collectors.steam_reviews_backfill import aggregate_by_date, write_review_history


def rebuild(game_id: str) -> dict:
    result = {"game_id": game_id, "video_dates_corrected": 0, "review_days": 0}
    with file_lock(RAW_DIR / "backfill" / f"{game_id}.operation"):
        full_path = RAW_DIR / "backfill" / f"steam_reviews_{game_id}.json"
        if full_path.exists():
            full = json.loads(full_path.read_text(encoding="utf-8"))
            rows = {str(r["recommendationid"]): r for r in full.get("reviews", []) if r.get("recommendationid")}
            through = full.get("collected_at")
            incremental_path = RAW_DIR / "backfill" / f"steam_reviews_incremental_{game_id}.json"
            if incremental_path.exists():
                incremental = json.loads(incremental_path.read_text(encoding="utf-8"))
                if incremental.get("base_run_id") == (full.get("collected_at_utc") or through):
                    rows.update({str(r["recommendationid"]): r for r in incremental.get("reviews", []) if r.get("recommendationid")})
                    through = max(through, incremental.get("collected_at") or through)
            previous = read_series(game_id, "review_history")
            if rows and through and (not previous or through >= previous[-1]["date_local"]):
                path = series_path(game_id, "review_history")
                if path.exists():
                    atomic_write_text(path.with_suffix(".jsonl.bak"), path.read_text(encoding="utf-8"))
                daily = aggregate_by_date(list(rows.values()), through_date=through)
                write_review_history(game_id, daily)
                result["review_days"] = len(daily)
            elif rows:
                result["review_note"] = "归档基底比已发布历史旧，保留已有历史"
    timestamps = {}
    for filename in sorted(RAW_DIR.glob(f"20*/youtube_{game_id}.json")):
        payload = json.loads(filename.read_text(encoding="utf-8"))
        for batch in payload.values():
            if not isinstance(batch, dict):
                continue
            for item in batch.get("items", []):
                timestamp = (item.get("snippet") or {}).get("publishedAt")
                if item.get("id") and timestamp:
                    timestamps[item["id"]] = timestamp
    path = series_path(game_id, "youtube")
    if path.exists() and timestamps:
        with file_lock(path):
            records = read_series(game_id, "youtube")
            for record in records:
                for video in record.get("videos", []):
                    timestamp = timestamps.get(video.get("video_id"))
                    if timestamp:
                        day = business_date(timestamp)
                        result["video_dates_corrected"] += int(bool(video.get("pubdate")) and video["pubdate"] != day)
                        video.update(published_at=timestamp, pubdate=day)
            atomic_write_text(path.with_suffix(".jsonl.bak"), path.read_text(encoding="utf-8"))
            atomic_write_text(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))
    return result


if __name__ == "__main__":
    for game in load_games():
        if game.get("active"):
            print(json.dumps(rebuild(game["game_id"]), ensure_ascii=False))
