"""指标与质量检查的单元测试。

重点覆盖「不可用字段不能变成 0」和「缺天差值必须标注跨度」两类错误，
这两类是看板最容易产生误导性结论的地方。

运行：python -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import metrics, quality  # noqa: E402


class TestReviewRate(unittest.TestCase):
    def test_normal(self):
        self.assertEqual(metrics.review_rate(14220, 16207), 87.74)

    def test_zero_denominator_is_none_not_zero(self):
        self.assertIsNone(metrics.review_rate(0, 0))

    def test_missing_field_is_none(self):
        self.assertIsNone(metrics.review_rate(None, 100))
        self.assertIsNone(metrics.review_rate(50, None))


class TestNewReviewSeries(unittest.TestCase):
    def test_first_point_has_no_baseline(self):
        out = metrics.new_review_series([
            {"date_local": "2026-09-01", "total_reviews": 100},
        ])
        self.assertIsNone(out[0]["value"])
        self.assertEqual(out[0]["status"], metrics.UNAVAILABLE)
        self.assertEqual(out[0]["note"], "no_baseline")

    def test_consecutive_days(self):
        out = metrics.new_review_series([
            {"date_local": "2026-09-01", "total_reviews": 100},
            {"date_local": "2026-09-02", "total_reviews": 140},
        ])
        self.assertEqual(out[1]["value"], 40)
        self.assertEqual(out[1]["span_days"], 1)
        self.assertEqual(out[1]["note"], "")

    def test_gap_is_flagged_with_span(self):
        out = metrics.new_review_series([
            {"date_local": "2026-09-01", "total_reviews": 100},
            {"date_local": "2026-09-05", "total_reviews": 200},
        ])
        self.assertEqual(out[1]["value"], 100)
        self.assertEqual(out[1]["span_days"], 4)
        self.assertIn("spans_4_days", out[1]["note"])

    def test_negative_delta_kept_and_flagged(self):
        out = metrics.new_review_series([
            {"date_local": "2026-09-01", "total_reviews": 200},
            {"date_local": "2026-09-02", "total_reviews": 190},
        ])
        self.assertEqual(out[1]["value"], -10)
        self.assertIn("negative_delta", out[1]["note"])

    def test_unavailable_total_does_not_break_baseline(self):
        out = metrics.new_review_series([
            {"date_local": "2026-09-01", "total_reviews": 100},
            {"date_local": "2026-09-02", "total_reviews": None},
            {"date_local": "2026-09-03", "total_reviews": 160},
        ])
        self.assertIsNone(out[1]["value"])
        # 第三天应相对第一天计算，跨度 2 天
        self.assertEqual(out[2]["value"], 60)
        self.assertEqual(out[2]["span_days"], 2)


class TestVideoSeries(unittest.TestCase):
    def _recs(self):
        return [
            {"date_local": "2026-09-01", "videos": [
                {"bvid": "BV1", "view": 1000, "status": "observed",
                 "title": "t", "character_name": "c", "version_id": "3.2",
                 "content_type": "character_demo"}]},
            {"date_local": "2026-09-02", "videos": [
                {"bvid": "BV1", "view": 1500, "status": "observed",
                 "title": "t", "character_name": "c", "version_id": "3.2",
                 "content_type": "character_demo"}]},
        ]

    def test_delta_and_latest(self):
        out = metrics.video_view_series(self._recs())
        slot = out["BV1"]
        self.assertIsNone(slot["points"][0]["delta"])
        self.assertEqual(slot["points"][1]["delta"], 500)
        self.assertEqual(slot["latest_view"], 1500)

    def test_unavailable_point_yields_no_delta(self):
        recs = self._recs()
        recs[1]["videos"][0]["view"] = None
        out = metrics.video_view_series(recs)
        self.assertIsNone(out["BV1"]["points"][1]["delta"])
        self.assertEqual(out["BV1"]["latest_view"], 1000)


class TestDiscountEvents(unittest.TestCase):
    def test_no_events_when_price_unavailable(self):
        pts = [{"date_local": "2026-09-01", "discount_percent": None,
                "status": metrics.UNAVAILABLE},
               {"date_local": "2026-09-02", "discount_percent": None,
                "status": metrics.UNAVAILABLE}]
        self.assertEqual(metrics.discount_events(pts), [])

    def test_start_and_end(self):
        pts = [
            {"date_local": "2026-09-01", "discount_percent": 0, "status": "observed"},
            {"date_local": "2026-09-02", "discount_percent": 30, "status": "observed"},
            {"date_local": "2026-09-03", "discount_percent": 0, "status": "observed"},
        ]
        evs = metrics.discount_events(pts)
        self.assertEqual([e["type"] for e in evs],
                         ["discount_start", "discount_end"])


class TestCoverage(unittest.TestCase):
    def test_detects_missing_days(self):
        cov = metrics.coverage([
            {"date_local": "2026-09-01"},
            {"date_local": "2026-09-04"},
        ])
        self.assertEqual(cov["expected_days"], 4)
        self.assertEqual(cov["valid_days"], 2)
        self.assertEqual(cov["missing_days"], 2)


class TestQuality(unittest.TestCase):
    def test_stale_data_is_error(self):
        issues = quality.check(
            [{"date_local": "2026-09-01", "current_players": 10,
              "total_reviews": 100, "price_final": None}],
            [], today="2026-09-10")
        self.assertTrue(any(i["code"] == "stale_data" and i["level"] == "error"
                            for i in issues))

    def test_owner_mismatch_is_error(self):
        issues = quality.check(
            [{"date_local": "2026-09-14", "current_players": 10,
              "total_reviews": 100, "price_final": 1}],
            [{"date_local": "2026-09-14", "videos": [
                {"bvid": "BV1", "view": 1,
                 "note": "owner_mismatch:got=1,expected=2"}]}],
            today="2026-09-14")
        self.assertTrue(any(i["code"] == "bilibili_owner_mismatch"
                            and i["level"] == "error" for i in issues))

    def test_missing_days_flagged(self):
        issues = quality.check(
            [{"date_local": "2026-09-01", "current_players": 1,
              "total_reviews": 10, "price_final": 1},
             {"date_local": "2026-09-04", "current_players": 1,
              "total_reviews": 20, "price_final": 1}],
            [], today="2026-09-04")
        self.assertTrue(any(i["code"] == "missing_days" for i in issues))


if __name__ == "__main__":
    unittest.main()
