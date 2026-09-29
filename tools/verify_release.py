"""Validate the currently published files and population statistics without HTTP."""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from collectors.common import DATA_DIR, business_date
from pipeline.publication import load_published
from pipeline.review_profile import load_reviews
from pipeline.metrics import interaction_rates


def verify(data_dir=DATA_DIR) -> dict:
    index, snapshots = load_published(data_dir)
    config = json.loads((data_dir / index["config_file"]).read_text(encoding="utf-8"))
    assert config["build_id"] == index["build_id"]
    assert len(snapshots) == len(index["games"])
    checked_medians = checked_videos = 0
    games = []
    for entry in index["games"]:
        gid = entry["game_id"]; snap = snapshots[gid]
        assert snap["build_id"] == index["build_id"]
        assert snap["game"]["game_id"] == gid
        assert snap["timezone"] == "Asia/Shanghai"
        json.dumps(snap, allow_nan=False)
        profile = snap.get("review_profile") or {}
        assert all("_playtime_samples" not in r for r in profile.get("daily", []))
        reviews, _ = load_reviews(gid)
        dated = [(business_date(r.get("timestamp_created")), r.get("playtime_at_review")) for r in reviews]
        for window in profile.get("version_windows", []):
            comparison = next(c for c in window["comparisons"] if c["field"] == "playtime_at_review_median")
            pivot = date.fromisoformat(window["date_local"])
            for side, start, end in [("before", pivot-timedelta(days=window["window"]), pivot-timedelta(days=1)), ("after", pivot, pivot+timedelta(days=window["window"]-1))]:
                values = sorted(v for d, v in dated if d and start.isoformat() <= d <= end.isoformat() and v is not None)
                expected = values[min(int(.5 * (len(values)-1) + .5), len(values)-1)] if values else None
                assert comparison[side] == expected, (gid, window["version_id"], side, comparison[side], expected)
                checked_medians += 1
        groups = [("bilibili", snap["bilibili"]["videos"])] + [("youtube", group["videos"]) for group in snap["youtube"]["locales"].values()]
        for platform, videos in groups:
            for video in videos:
                latest = video.get("latest")
                if latest:
                    assert latest["rates"]["engagement"] == interaction_rates(latest["stats"], platform)["engagement"]
                    checked_videos += 1
        games.append({"game_id": gid, "snapshot_date": snap["snapshot_date"], "freshness": snap["freshness_status"],
                      "source_health": {name: item["status"] for name, item in snap["source_health"].items()}})
    return {"build_id": index["build_id"], "games": games, "population_medians_checked": checked_medians, "video_metrics_checked": checked_videos, "status": "passed"}


if __name__ == "__main__":
    print(json.dumps(verify(), ensure_ascii=False, indent=2))
