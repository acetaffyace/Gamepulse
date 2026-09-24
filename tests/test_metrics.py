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

    def test_daily_series_uses_steam_store_summary(self):
        out = metrics.review_rate_series([
            {"date_local": "2026-09-21", "total_reviews": 56053,
             "total_positive": 49114},
            {"date_local": "2026-09-22", "total_reviews": 56111,
             "total_positive": 49154},
        ])
        self.assertEqual(out[-1]["value"], 87.6)
        self.assertEqual(out[-1]["total_reviews"], 56111)


class TestOnlineFallback(unittest.TestCase):
    def test_unavailable_official_point_keeps_observed_fallback(self):
        steam = [
            {"date_local": "2026-09-17", "current_players": None},
            {"date_local": "2026-09-18", "current_players": 300},
            {"date_local": "2026-09-20", "current_players": None},
        ]
        steamdb = [
            {"date_local": "2026-09-17", "current_players": 200,
             "source": "steamdb_chart"},
            {"date_local": "2026-09-18", "current_players": 250,
             "source": "steamdb_chart"},
        ]
        hourly = [
            {"date_local": "2026-09-17", "hour_local": 12, "players": 180},
            {"date_local": "2026-09-19", "hour_local": 11, "players": 100},
            {"date_local": "2026-09-19", "hour_local": 12, "players": None},
            {"date_local": "2026-09-19", "hour_local": 13, "players": 110},
        ]
        merged = metrics.merge_online_observations(steam, steamdb, hourly)
        by_date = {r["date_local"]: r for r in metrics.online_series(merged)}

        self.assertEqual(by_date["2026-09-17"]["value"], 200)
        self.assertEqual(by_date["2026-09-17"]["source"], "steamdb_chart")
        self.assertEqual(by_date["2026-09-18"]["value"], 300)
        self.assertEqual(by_date["2026-09-18"]["source"], "steam_official")
        self.assertEqual(by_date["2026-09-19"]["value"], 110)
        self.assertEqual(by_date["2026-09-19"]["hour_local"], 13)
        self.assertIsNone(by_date["2026-09-20"]["value"])


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


class TestReviewChartSeries(unittest.TestCase):
    def test_unified_chart_fields_keep_measurement_basis_at_cutover(self):
        history = [
            {"date_local": "2026-09-01", "new_reviews": 3,
             "daily_review_rate": 66.67, "cumulative_review_rate": 80.0},
            {"date_local": "2026-09-02", "new_reviews": 4,
             "daily_review_rate": 75.0, "cumulative_review_rate": 78.0},
        ]
        steam = [
            {"date_local": "2026-09-02", "total_reviews": 100,
             "total_positive": 80},
            {"date_local": "2026-09-03", "total_reviews": 110,
             "total_positive": 90},
            {"date_local": "2026-09-05", "total_reviews": 130,
             "total_positive": 105},
        ]

        out = metrics.review_chart_series(history, steam)
        by_date = {row["date_local"]: row for row in out}

        self.assertEqual(list(by_date), sorted(by_date))
        self.assertEqual(by_date["2026-09-01"]["backfill_new_reviews"], 3)
        self.assertEqual(by_date["2026-09-01"]["backfill_daily_review_rate"], 66.67)
        self.assertEqual(by_date["2026-09-01"]["chart_review_count"], 3)
        self.assertEqual(by_date["2026-09-01"]["chart_review_count_basis"],
                         "surviving_review_backfill")
        self.assertIsNone(by_date["2026-09-02"]["steam_net_change"])
        self.assertIsNone(by_date["2026-09-02"]["steam_cumulative_review_rate"])
        self.assertEqual(by_date["2026-09-02"]["chart_review_count"], 4)
        self.assertEqual(by_date["2026-09-02"]["display_cumulative_review_rate"], 78.0)
        self.assertEqual(by_date["2026-09-03"]["steam_net_change"], 10)
        self.assertEqual(by_date["2026-09-03"]["steam_net_span_days"], 1)
        self.assertEqual(by_date["2026-09-03"]["steam_cumulative_review_rate"], 81.82)
        self.assertEqual(by_date["2026-09-03"]["chart_review_count"], 10)
        self.assertEqual(by_date["2026-09-03"]["chart_review_count_basis"],
                         "steam_net_change")
        self.assertEqual(by_date["2026-09-03"]["display_cumulative_review_rate"], 81.82)
        self.assertEqual(by_date["2026-09-03"]["display_cumulative_review_rate_basis"],
                         "steam_global")
        self.assertEqual(by_date["2026-09-05"]["steam_net_change"], 20)
        self.assertEqual(by_date["2026-09-05"]["steam_net_span_days"], 2)
        self.assertIsNone(by_date["2026-09-05"]["chart_review_count"])
        self.assertEqual(by_date["2026-09-05"]["chart_review_count_span_days"], 2)
        self.assertIsNone(by_date["2026-09-05"]["backfill_new_reviews"])


class TestVideoSeries(unittest.TestCase):
    def _recs(self):
        base = {"bvid": "BV1", "status": "observed", "title": "t",
                "character_name": "c", "version_id": "3.2",
                "content_type": "character_demo", "pubdate": "2026-09-01"}
        return [
            {"date_local": "2026-09-01", "videos": [
                {**base, "view": 1000, "like": 100, "coin": 40, "favorite": 20,
                 "reply": 8, "danmaku": 5, "share": 3}]},
            {"date_local": "2026-09-02", "videos": [
                {**base, "view": 1500, "like": 160, "coin": 60, "favorite": 30,
                 "reply": 12, "danmaku": 9, "share": 5}]},
        ]

    def test_delta_and_latest(self):
        out = metrics.video_series(self._recs())
        slot = out["BV1"]
        self.assertIsNone(slot["points"][0]["deltas"]["view"])
        self.assertEqual(slot["points"][1]["deltas"]["view"], 500)
        self.assertEqual(slot["points"][1]["deltas"]["coin"], 20)
        self.assertEqual(slot["latest_view"], 1500)

    def test_all_seven_stats_are_tracked(self):
        """七项字段早就采到了，任何一项被漏掉都应该让测试失败。"""
        out = metrics.video_series(self._recs())
        stats = out["BV1"]["latest"]["stats"]
        for key in metrics.BILI_STATS:
            self.assertIn(key, stats, f"{key} 未进入快照")
            self.assertIsNotNone(stats[key])

    def test_unavailable_point_yields_no_delta(self):
        recs = self._recs()
        recs[1]["videos"][0]["view"] = None
        out = metrics.video_series(recs)
        self.assertIsNone(out["BV1"]["points"][1]["deltas"]["view"])
        self.assertEqual(out["BV1"]["latest_view"], 1000)

    def test_ramp_available_only_when_captured_at_publish(self):
        # 发布当天就入表 → 爬坡曲线成立
        out = metrics.video_series(self._recs())
        self.assertTrue(out["BV1"]["ramp"]["available"])

        # 事后 17 天才登记 → 首次采集拿到的是已积累的累计值，不能做爬坡对比
        late = self._recs()
        for rec in late:
            rec["videos"][0]["pubdate"] = "2026-08-15"
        out = metrics.video_series(late)
        self.assertFalse(out["BV1"]["ramp"]["available"])
        self.assertEqual(out["BV1"]["ramp"]["first_capture_days_since_pub"], 17)

    def test_youtube_uses_its_own_stat_set(self):
        recs = [{"date_local": "2026-09-02", "videos": [
            {"video_id": "abc", "view": 2000, "like": 100, "comment": 30,
             "status": "observed", "pubdate": "2026-09-01"}]}]
        out = metrics.video_series(recs, platform="youtube", id_key="video_id")
        slot = out["abc"]
        self.assertEqual(slot["platform"], "youtube")
        self.assertEqual(set(slot["latest"]["stats"]), set(metrics.YT_STATS))
        # YouTube 只有点赞一项做分子，engagement 必须只反映点赞
        self.assertEqual(slot["latest"]["rates"]["engagement"],
                         slot["latest"]["rates"]["like"])


class TestInteractionRates(unittest.TestCase):
    def test_zero_view_gives_none_not_zero(self):
        rates = metrics.interaction_rates(
            {"view": 0, "like": 0, "coin": 0, "favorite": 0})
        self.assertIsNone(rates["engagement"])
        self.assertIsNone(rates["like"])

    def test_missing_numerator_blocks_engagement_only(self):
        """点赞缺失时不能把三连率算成「只有投币+收藏」—— 那会低估。"""
        rates = metrics.interaction_rates(
            {"view": 1000, "like": None, "coin": 40, "favorite": 20})
        self.assertIsNone(rates["engagement"])
        self.assertEqual(rates["coin"], 4.0)

    def test_bilibili_engagement_is_three_way_sum(self):
        rates = metrics.interaction_rates(
            {"view": 1000, "like": 100, "coin": 40, "favorite": 20})
        self.assertEqual(rates["engagement"], 16.0)


class TestOnlineDaily(unittest.TestCase):
    def _samples(self, n, players):
        return [{"date_local": "2026-09-14", "hour_local": h, "players": p}
                for h, p in zip(range(n), players)]

    def test_peak_trough_and_ratio(self):
        out = metrics.online_daily(self._samples(8, [10, 20, 30, 40, 35, 25, 15, 12]))
        day = out[0]
        self.assertEqual(day["peak"], 40)
        self.assertEqual(day["trough"], 10)
        self.assertEqual(day["peak_hour"], 3)
        self.assertEqual(day["peak_trough_ratio"], 4.0)
        self.assertEqual(day["status"], "observed")

    def test_thin_sampling_marked_partial(self):
        """半天的样本算不出真实日峰值，必须标 partial 而不是当作完整日。"""
        out = metrics.online_daily(self._samples(3, [10, 20, 30]))
        self.assertEqual(out[0]["status"], "partial")
        self.assertEqual(out[0]["samples"], 3)

    def test_unavailable_samples_are_skipped_not_zeroed(self):
        samples = self._samples(6, [10, 20, 30, 40, 50, 60])
        samples[0]["players"] = None
        out = metrics.online_daily(samples)
        self.assertEqual(out[0]["trough"], 20)
        self.assertEqual(out[0]["samples"], 5)


class TestIndexed(unittest.TestCase):
    def test_first_valid_value_is_base(self):
        out = metrics.indexed([{"value": 200}, {"value": 300}, {"value": 100}])
        self.assertEqual(out[0]["indexed"], 100.0)
        self.assertEqual(out[1]["indexed"], 150.0)
        self.assertEqual(out[2]["indexed"], 50.0)

    def test_missing_values_stay_none(self):
        out = metrics.indexed([{"value": None}, {"value": 200}, {"value": None}])
        self.assertIsNone(out[0]["indexed"])
        self.assertEqual(out[1]["indexed"], 100.0)
        self.assertIsNone(out[2]["indexed"])


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
