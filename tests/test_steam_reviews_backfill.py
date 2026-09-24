"""Review recovery must keep complete history and preserve empty dates."""

from __future__ import annotations

import time
import unittest
from datetime import datetime
from unittest.mock import patch

from collectors import steam_reviews_backfill as backfill
from collectors.steam_reviews_backfill import aggregate_by_date, complete_backfill


class TestReviewBackfillRecovery(unittest.TestCase):
    def test_zero_review_days_keep_cumulative_rate(self):
        reviews = [
            {"timestamp_created": int(time.mktime(datetime(2026, 9, 16, 12).timetuple())),
             "voted_up": True, "language": "english"},
            {"timestamp_created": int(time.mktime(datetime(2026, 9, 19, 12).timetuple())),
             "voted_up": False, "language": "english"},
        ]
        rows = aggregate_by_date(reviews, through_date="2026-09-20")
        by_date = {row["date_local"]: row for row in rows}

        self.assertEqual(list(by_date), [
            "2026-09-16", "2026-09-17", "2026-09-18",
            "2026-09-19", "2026-09-20",
        ])
        self.assertEqual(by_date["2026-09-18"]["new_reviews"], 0)
        self.assertIsNone(by_date["2026-09-18"]["daily_review_rate"])
        self.assertEqual(by_date["2026-09-18"]["cumulative_review_rate"], 100)
        self.assertEqual(by_date["2026-09-20"]["cumulative_review_rate"], 50)

    def test_failed_walk_cannot_replace_history_even_with_high_coverage(self):
        self.assertFalse(complete_backfill({
            "stop_reason": "request_failed:ConnectTimeout", "collected": 99,
            "total_expected": 100,
        }))
        self.assertFalse(complete_backfill({
            "stop_reason": "max_pages", "collected": 99,
            "total_expected": 100,
        }))
        self.assertFalse(complete_backfill({
            "stop_reason": "empty_page", "collected": 90,
            "total_expected": 100,
        }))
        self.assertTrue(complete_backfill({
            "stop_reason": "empty_page", "collected": 99,
            "total_expected": 100,
        }))
        self.assertFalse(complete_backfill({
            "stop_reason": "cursor_exhausted", "collected": 100,
            "total_expected": None,
        }, previous_total=1000))

    def test_incremental_fetch_stops_after_full_old_page(self):
        def row(day, rid):
            stamp = int(time.mktime(datetime.strptime(
                day + " 12:00", "%Y-%m-%d %H:%M").timetuple()))
            return {"recommendationid": rid, "timestamp_created": stamp,
                    "voted_up": True, "language": "english"}

        pages = [
            ({"success": 1, "query_summary": {"total_reviews": 1000},
              "reviews": [row("2026-09-23", "a"), row("2026-09-19", "b")],
              "cursor": "next"}, "ok"),
            ({"success": 1, "reviews": [row("2026-09-18", "c")],
              "cursor": "unused"}, "ok"),
        ]
        with patch.object(backfill, "session"), \
             patch.object(backfill, "get_json", side_effect=pages), \
             patch.object(backfill.time, "sleep"):
            reviews, meta = backfill.fetch_recent_reviews(
                123, "2026-09-19", sleep=0)

        self.assertEqual([r["recommendationid"] for r in reviews], ["a", "b"])
        self.assertEqual(meta["stop_reason"], "cutoff_reached")
        self.assertEqual(meta["pages"], 2)


if __name__ == "__main__":
    unittest.main()
