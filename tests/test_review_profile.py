"""玩家结构分析的单元测试。

这个模块最容易出的错不是算错数，而是算出一个**看起来有意义、
实际上完全由观测窗口造成**的数字。实测踩到过：

    绝区零 90 天前那批评测，still_playing_share = 90.4%
    今天这批                 still_playing_share = 21.1%

看上去像「留存崩了」，实际上今天写的评测观测窗口是 0 天，
谁也来不及在写完评测之后再玩一小时。版本前后对比会系统性地
放大这个假象 —— 更新日之后的窗口永远离今天更近。

因此本文件的核心用例都在锁这件事：
  1. 观测窗口不足时，留存代理必须是 None，不能是一个小数字；
  2. 受窗口影响的字段不得进入版本前后对比的 change 计算。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import review_profile as rp  # noqa: E402


def review(day: str, at_review: int, forever: int, voted_up: bool = True,
           language: str = "english", purchase: bool = True) -> dict:
    """构造一条评测。timestamp 用当天 12:00 UTC，避开时区边界。"""
    from datetime import datetime, timezone
    ts = int(datetime.strptime(day + " 12:00", "%Y-%m-%d %H:%M")
             .replace(tzinfo=timezone.utc).timestamp())
    return {"timestamp_created": ts, "playtime_at_review": at_review,
            "playtime_forever": forever, "voted_up": voted_up,
            "language": language, "steam_purchase": purchase,
            "received_for_free": False}


class TestObservationWindowGate(unittest.TestCase):
    def test_short_window_yields_none_not_a_small_number(self):
        """窗口 2 天时，留存代理必须留空 —— 它注定接近 0，会被误读成留存崩盘。"""
        reviews = [review("2026-09-12", 600, 600) for _ in range(20)]
        daily = rp.daily_profile(reviews, collected_at="2026-09-14")
        row = daily[0]
        self.assertEqual(row["observation_days"], 2)
        self.assertFalse(row["observation_sufficient"])
        self.assertIsNone(row["still_playing_share"])
        self.assertIsNone(row["post_review_minutes_median"])

    def test_sufficient_window_produces_value(self):
        reviews = ([review("2026-06-01", 600, 1200) for _ in range(8)]
                   + [review("2026-06-01", 600, 600) for _ in range(2)])
        daily = rp.daily_profile(reviews, collected_at="2026-09-14")
        row = daily[0]
        self.assertTrue(row["observation_sufficient"])
        self.assertEqual(row["still_playing_share"], 80.0)

    def test_playtime_regression_is_clamped_not_negative(self):
        """Steam 偶尔会修正统计，forever < at_review。截到 0，不留负数。"""
        daily = rp.daily_profile([review("2026-06-01", 900, 600)],
                                 collected_at="2026-09-14")
        self.assertEqual(daily[0]["post_review_minutes_median"], 0)


class TestPlaytimeDistribution(unittest.TestCase):
    def test_short_and_heavy_shares(self):
        reviews = [
            review("2026-06-01", 30, 30),      # 30 分钟，退款线内
            review("2026-06-01", 60, 60),      # 1 小时
            review("2026-06-01", 7000, 7000),  # 116 小时，重度
            review("2026-06-01", 3000, 3000),  # 50 小时
        ]
        row = rp.daily_profile(reviews, collected_at="2026-09-14")[0]
        self.assertEqual(row["short_play_share"], 50.0)
        self.assertEqual(row["heavy_play_share"], 25.0)
        self.assertEqual(row["playtime_at_review_median"], 3000)

    def test_review_rate_and_purchase_share(self):
        reviews = [review("2026-06-01", 100, 100, voted_up=True),
                   review("2026-06-01", 100, 100, voted_up=True),
                   review("2026-06-01", 100, 100, voted_up=False),
                   review("2026-06-01", 100, 100, purchase=False)]
        row = rp.daily_profile(reviews, collected_at="2026-09-14")[0]
        self.assertEqual(row["review_rate"], 75.0)
        self.assertEqual(row["steam_purchase_share"], 75.0)


class TestLanguageShare(unittest.TestCase):
    def test_buckets_share_one_language_set(self):
        """每个桶的图例必须一致，否则看不出谁在涨。"""
        reviews = ([review("2026-06-01", 60, 60, language="english")] * 10
                   + [review("2026-06-08", 60, 60, language="russian")] * 10)
        daily = rp.daily_profile(reviews, collected_at="2026-09-14")
        share = rp.language_share_series(daily, bucket_days=7)
        self.assertEqual(len(share["buckets"]), 2)
        first, second = share["buckets"]
        self.assertEqual(set(first["shares"]), set(second["shares"]))
        self.assertEqual(first["shares"]["english"], 100.0)
        self.assertEqual(second["shares"]["russian"], 100.0)

    def test_version_buckets_restart_at_update_day(self):
        """版本相对周不能把更新日前的自然周数据带进来。"""
        reviews = (
            [review("2026-07-01", 60, 60, language="english")] * 5
            + [review("2026-07-03", 60, 60, language="russian")] * 2
            + [review("2026-07-04", 60, 60, language="japanese")] * 3
            + [review("2026-07-10", 60, 60, language="koreana")] * 4
            + [review("2026-07-12", 60, 60, language="english")] * 2
        )
        daily = rp.daily_profile(reviews, collected_at="2026-07-14")
        series = rp.version_language_share_series(
            daily,
            [
                {"date_local": "2026-07-03", "version_id": "2.0"},
                {"date_local": "2026-07-12", "version_id": "2.1"},
            ],
        )

        first = series[0]
        self.assertEqual(first["date_local"], "2026-07-03")
        self.assertEqual(first["end_local"], "2026-07-11")
        self.assertEqual([b["relative_week"] for b in first["buckets"]], [1, 2])
        self.assertEqual(first["buckets"][0]["start"], "2026-07-03")
        self.assertEqual(first["buckets"][0]["end"], "2026-07-09")
        self.assertEqual(first["overall_total"], 9)
        self.assertEqual(first["overall"].get("english", 0), 0)
        self.assertEqual(first["overall"].get("russian", 0), 2)
        self.assertEqual(first["overall"].get("japanese", 0), 3)
        self.assertEqual(first["buckets"][1]["start"], "2026-07-10")
        self.assertEqual(first["buckets"][1]["end"], "2026-07-11")
        self.assertEqual(first["buckets"][1]["days_with_reviews"], 1)

    def test_version_cumulative_rate_restarts_at_update_day(self):
        """版本累计好评率的分子分母都不能带入更新日前的评测。"""
        reviews = (
            [review("2026-07-01", 60, 60, voted_up=False)] * 10
            + [review("2026-07-03", 60, 60, voted_up=True)] * 3
            + [review("2026-07-04", 60, 60, voted_up=False)]
            + [review("2026-07-05", 60, 60, voted_up=True)] * 2
        )
        daily = rp.daily_profile(reviews, collected_at="2026-07-06")
        series = rp.version_cumulative_review_rate(
            daily,
            [
                {"date_local": "2026-07-03", "version_id": "2.0"},
                {"date_local": "2026-07-06", "version_id": "2.1"},
            ],
        )

        first = series[0]["series"]
        self.assertEqual(first[0]["date_local"], "2026-07-03")
        self.assertEqual(first[0]["value"], 100.0)
        self.assertEqual(first[0]["total_reviews"], 3)
        self.assertEqual(first[1]["value"], 75.0)
        self.assertEqual(first[1]["total_reviews"], 4)
        self.assertEqual(first[2]["value"], round(5 / 6 * 100, 2))
        self.assertEqual(first[2]["total_reviews"], 6)


class TestVersionWindows(unittest.TestCase):
    def _daily(self):
        """更新日 2026-07-15 前后各 7 天，每天 10 条评测。"""
        from datetime import date, timedelta
        reviews = []
        start = date(2026, 7, 8)
        for offset in range(14):
            day = (start + timedelta(days=offset)).isoformat()
            reviews += [review(day, 600, 1200) for _ in range(10)]
        return rp.daily_profile(reviews, collected_at="2026-09-14")

    def test_complete_window_is_flagged(self):
        out = rp.version_windows(self._daily(),
                                 [{"date_local": "2026-07-15", "version_id": "3.1"}])
        self.assertTrue(out[0]["complete"])
        self.assertEqual(out[0]["before_days"], 7)
        self.assertEqual(out[0]["after_days"], 7)

    def test_incomplete_window_carries_a_note(self):
        daily = self._daily()[:10]      # 后窗口不够 7 天
        out = rp.version_windows(daily,
                                 [{"date_local": "2026-07-15", "version_id": "3.1"}])
        self.assertFalse(out[0]["complete"])
        self.assertIn("窗口不完整", out[0]["coverage_note"])

    def test_comparison_fields_exclude_observation_sensitive_metrics(self):
        """留存代理不得出现在版本对比表里 —— 它的前后差值是窗口差，不是留存差。"""
        fields = {f for f, _, _ in rp.WINDOW_FIELDS}
        self.assertFalse(fields & rp.OBSERVATION_SENSITIVE,
                         "受观测窗口影响的字段混进了版本前后对比")

    def test_confounded_field_gets_no_change_value(self):
        """即使有人硬把它加进 WINDOW_FIELDS，change 也必须为 None。"""
        original = rp.WINDOW_FIELDS
        rp.WINDOW_FIELDS = original + (
            ("still_playing_share", "评测后仍在玩占比", "weighted_share"),)
        try:
            out = rp.version_windows(
                self._daily(), [{"date_local": "2026-07-15", "version_id": "3.1"}])
            entry = next(c for c in out[0]["comparisons"]
                         if c["field"] == "still_playing_share")
            self.assertIsNone(entry["change"])
            self.assertEqual(entry["confounded"], "observation_window")
        finally:
            rp.WINDOW_FIELDS = original


if __name__ == "__main__":
    unittest.main()
