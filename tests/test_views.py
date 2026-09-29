"""v3 指标视图：用手工构造的小数据核对，期望值全部手算写在测试里。

这些测试不调用任何被测的 Python 计算函数，是对 SQL 口径的独立核对。
"""
from __future__ import annotations

import json
import sqlite3
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from store import db

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TODAY = datetime.now(timezone(timedelta(hours=8))).date()


def days_ago(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


def review(rid, day, voted_up, playtime, forever, last_seen):
    return {"review_id": rid, "game_id": "g1", "created_at": 0, "created_date": day, "voted_up": voted_up,
            "language": "english", "playtime_at_review": playtime, "playtime_forever": forever,
            "steam_purchase": 1, "received_for_free": 0, "last_seen_at": last_seen}


class ViewTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        c = cls.conn = db.connect(":memory:")
        db.upsert(c, "game", [{"game_id": "g1", "display_name": "测试游戏", "steam_app_id": 1,
                               "steam_release": "2026-01-01", "active": 1}])
        db.upsert(c, "version", [
            {"game_id": "g1", "version_id": "1.0", "start_date": "2026-01-01", "status": "released"},
            {"game_id": "g1", "version_id": "1.1", "start_date": "2026-01-10", "status": "released"},
            {"game_id": "g1", "version_id": "1.2", "start_date": None, "status": "scheduled"},
        ])
        db.upsert(c, "review", [
            review(1, "2026-01-01", 1, 60, 60, "2026-02-01T00:00:00+00:00"),
            review(2, "2026-01-03", 0, 1200, 1500, "2026-01-10T00:00:00+00:00"),
            review(3, "2026-01-10", 1, 6000, 6100, "2026-02-01T00:00:00+00:00"),
            review(4, "2026-01-10", None, None, None, "2026-02-01T00:00:00+00:00"),
            review(5, "2026-01-17", 1, 119, 119, "2026-02-01T00:00:00+00:00"),
        ])
        db.insert(c, "review_run", [{"game_id": "g1", "mode": "full", "finished_at": "2026-01-18T04:00:00+00:00",
                                     "covered_through": "2026-01-18"}])
        db.upsert(c, "steam_daily", [
            {"game_id": "g1", "date": "2026-01-10", "total_reviews": 100, "total_positive": 80, "current_players": None, "observed_at": "x"},
            {"game_id": "g1", "date": "2026-01-11", "total_reviews": 110, "total_positive": 88, "current_players": None, "observed_at": "x"},
            {"game_id": "g1", "date": "2026-01-12", "total_reviews": None, "total_positive": None, "current_players": 500, "observed_at": "x"},
            {"game_id": "g1", "date": "2026-01-14", "total_reviews": 120, "total_positive": 90, "current_players": None, "observed_at": "x"},
            {"game_id": "g1", "date": days_ago(1), "total_reviews": 130, "total_positive": 95, "current_players": None, "observed_at": "x"},
        ])
        db.upsert(c, "video_pair", [{"pair_id": "p1", "game_id": "g1", "content_type": "character_trailer"}])
        db.upsert(c, "video", [
            {"platform": "youtube", "video_id": "v1", "game_id": "g1", "pair_id": "p1", "locale": "global",
             "published_date": "2026-01-12", "published_at": None, "version_id": "1.0", "version_confirmed": 1},
            {"platform": "bilibili", "video_id": "v2", "game_id": "g1", "pair_id": None, "locale": "zh-cn",
             "published_date": "2026-01-05", "published_at": None, "version_id": None, "version_confirmed": 0},
            {"platform": "youtube", "video_id": "v3", "game_id": "g1", "pair_id": None, "locale": "ja",
             "published_date": "2026-01-09", "published_at": "2026-01-09T20:00:00Z", "version_id": None,
             "version_confirmed": 0},
        ])
        obs = lambda vid, platform, day, views: {"platform": platform, "video_id": vid, "date": day, "views": views,
                                                 "observed_at": "x"}
        db.upsert(c, "video_obs", [obs("v1", "youtube", "2026-01-12", 100), obs("v1", "youtube", "2026-01-13", 150),
                                   obs("v1", "youtube", "2026-01-16", 300), obs("v2", "bilibili", "2026-01-10", 10)])
        db.upsert(c, "online_daily", [{"game_id": "g1", "date": days_ago(8), "avg_players": 900,
                                       "point_players": 1000, "imported_at": "x"}])
        db.record_attempt(c, "youtube", "g1", days_ago(2), "success", attempted_at="2026-09-01T00:00:00+00:00")
        db.record_attempt(c, "youtube", "g1", days_ago(1), "failed", attempted_at="2026-09-02T00:00:00+00:00")
        db.record_attempt(c, "steam", "g1", days_ago(1), "success", attempted_at="2026-09-02T00:00:00+00:00")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def one(self, sql, *args):
        row = self.conn.execute(sql, args).fetchone()
        return tuple(row) if row is not None else None

    def rows(self, sql, *args):
        return [tuple(r) for r in self.conn.execute(sql, args)]


class VersionWindow(ViewTestCase):
    def test_window_runs_to_the_day_before_the_next_release(self):
        self.assertEqual(self.one("SELECT start_date, end_date, days, is_open, prev_version, next_version, seq "
                                  "FROM v_version_window WHERE version_id = '1.0'"),
                         ("2026-01-01", "2026-01-09", 9, 0, None, "1.1", 1))

    def test_latest_version_is_open_until_today(self):
        expected_days = (TODAY - date(2026, 1, 10)).days + 1
        self.assertEqual(self.one("SELECT end_date, days, is_open FROM v_version_window WHERE version_id = '1.1'"),
                         (TODAY.isoformat(), expected_days, 1))

    def test_scheduled_version_is_not_a_window(self):
        self.assertIsNone(self.one("SELECT * FROM v_version_window WHERE version_id = '1.2'"))


class Reviews(ViewTestCase):
    def test_version_day_index_and_game_day_index(self):
        self.assertEqual(self.rows("SELECT review_id, version_id, day_index, game_day_index, version_week "
                                   "FROM v_review ORDER BY review_id"),
                         [(1, "1.0", 0, 0, 0), (2, "1.0", 2, 2, 0), (3, "1.1", 0, 9, 0),
                          (4, "1.1", 0, 9, 0), (5, "1.1", 7, 16, 1)])

    def test_playtime_bands_use_half_open_boundaries(self):
        # 119 分钟 < 2h；1200 分钟正好 20h，归入 20-100h；6000 分钟正好 100h，归入 100h+
        self.assertEqual(self.rows("SELECT review_id, playtime_band FROM v_review ORDER BY review_id"),
                         [(1, "0-2h"), (2, "20-100h"), (3, "100h+"), (4, None), (5, "0-2h")])

    def test_week_starts_on_monday(self):
        # 2026-01-17 是周六，所在自然周从 2026-01-12（周一）开始；2026-01-01 是周四
        self.assertEqual(self.rows("SELECT review_id, week_start FROM v_review WHERE review_id IN (1, 5) "
                                   "ORDER BY review_id"),
                         [(1, "2025-12-29"), (5, "2026-01-12")])

    def test_post_review_playtime_needs_fourteen_days_of_observation(self):
        # 评测 2 只观察了 7 天 → 不计算；评测 3 观察 22 天，评测后又玩 100 分钟
        # 评测 1 观察 31 天、评测后没再玩 → 0（真实的 0）；评测 2 只观察了 7 天 → NULL
        self.assertEqual(self.rows("SELECT review_id, post_review_minutes FROM v_review "
                                   "WHERE review_id IN (1, 2, 3) ORDER BY review_id"),
                         [(1, 0), (2, None), (3, 100)])


class ReviewDaily(ViewTestCase):
    def test_days_without_reviews_are_real_zeros(self):
        self.assertEqual(self.one("SELECT reviews, positive, negative FROM v_review_daily WHERE date = '2026-01-02'"),
                         (0, 0, 0))

    def test_unknown_vote_counts_as_a_review_but_not_positive_or_negative(self):
        self.assertEqual(self.one("SELECT reviews, positive, negative FROM v_review_daily WHERE date = '2026-01-10'"),
                         (2, 1, 0))

    def test_calendar_runs_to_the_last_covered_day_which_is_incomplete(self):
        self.assertEqual(self.one("SELECT MIN(date), MAX(date), COUNT(*) FROM v_review_daily"),
                         ("2026-01-01", "2026-01-18", 18))
        self.assertEqual(self.rows("SELECT date, complete_day FROM v_review_daily WHERE date >= '2026-01-17'"),
                         [("2026-01-17", 1), ("2026-01-18", 0)])

    def test_totals_match_the_review_rows(self):
        self.assertEqual(self.one("SELECT SUM(reviews), SUM(positive), SUM(negative) FROM v_review_daily"), (5, 3, 1))


class SteamDaily(ViewTestCase):
    def test_net_change_records_how_many_days_it_spans(self):
        self.assertEqual(self.rows("SELECT date, net_change, net_change_span_days, cumulative_positive_rate "
                                   "FROM v_steam_daily WHERE date < '2026-02-01' ORDER BY date"),
                         [("2026-01-10", None, None, 80.0), ("2026-01-11", 10, 1, 80.0),
                          ("2026-01-14", 10, 3, 75.0)])


class Videos(ViewTestCase):
    def test_confirmed_version_wins_over_publication_window(self):
        self.assertEqual(self.one("SELECT version_id, version_basis, curated FROM v_video WHERE video_id = 'v1'"),
                         ("1.0", "confirmed", 1))

    def test_unconfirmed_video_uses_the_window_of_its_publication_day(self):
        self.assertEqual(self.one("SELECT version_id, version_basis, curated FROM v_video WHERE video_id = 'v2'"),
                         ("1.0", "pub_date", 0))

    def test_publication_day_is_the_utc8_date_of_the_exact_timestamp(self):
        # 2026-01-09 20:00 UTC = 2026-01-10 04:00 UTC+8，落在 1.1 的窗口
        self.assertEqual(self.one("SELECT pub_date, version_id FROM v_video WHERE video_id = 'v3'"),
                         ("2026-01-10", "1.1"))

    def test_deltas_record_their_span_and_age(self):
        self.assertEqual(self.rows("SELECT date, days_since_pub, views_delta, span_days, is_latest, first_obs_age "
                                   "FROM v_video_obs WHERE video_id = 'v1' ORDER BY date"),
                         [("2026-01-12", 0, None, None, 0, 0), ("2026-01-13", 1, 50, 1, 0, 0),
                          ("2026-01-16", 4, 150, 3, 1, 0)])

    def test_first_observation_age_reveals_a_missing_start(self):
        self.assertEqual(self.one("SELECT first_obs_age FROM v_video_obs WHERE video_id = 'v2'"), (5,))

    def test_latest_has_one_row_per_observed_video(self):
        self.assertEqual(self.rows("SELECT video_id, date, views FROM v_video_latest ORDER BY video_id"),
                         [("v1", "2026-01-16", 300), ("v2", "2026-01-10", 10)])


class SourceStatus(ViewTestCase):
    def status(self, source):
        return self.one("SELECT data_through, age_days, last_attempt_status, status FROM v_source_status "
                        "WHERE source = ?", source)

    def test_recent_data_with_successful_attempt_is_healthy(self):
        self.assertEqual(self.status("steam"), (days_ago(1), 1, "success", "healthy"))

    def test_latest_failed_attempt_is_reported_even_if_old_data_exists(self):
        self.assertEqual(self.status("youtube")[2:], ("failed", "failed"))

    def test_source_without_any_data_is_missing(self):
        self.assertEqual(self.status("steam_build"), (None, None, None, "missing"))

    def test_old_data_without_attempts_is_stale(self):
        age = (TODAY - date(2026, 1, 10)).days
        self.assertEqual(self.status("bilibili"), ("2026-01-10", age, None, "stale"))

    def test_steamdb_is_stale_after_eight_days(self):
        self.assertEqual(self.status("steamdb"), (days_ago(8), 8, None, "stale"))


class Quantile(unittest.TestCase):
    def test_shared_cases(self):
        cases = json.loads((FIXTURES / "quantile-cases.json").read_text(encoding="utf-8"))
        conn = db.connect(":memory:")
        conn.execute("CREATE TEMP TABLE t (grp INTEGER, x REAL)")
        for index, case in enumerate(cases):
            conn.executemany("INSERT INTO t VALUES (?, ?)", [(index, v) for v in case["values"]])
            got = conn.execute("SELECT quantile(x, ?) FROM t WHERE grp = ?", (case["p"], index)).fetchone()[0]
            with self.subTest(case["note"]):
                if case["expected"] is None:
                    self.assertIsNone(got)
                else:
                    self.assertAlmostEqual(got, case["expected"])
        conn.close()

    def test_invalid_p_is_an_error(self):
        conn = db.connect(":memory:")
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("SELECT quantile(x, 2) FROM (SELECT 1 AS x)").fetchone()
        conn.close()


if __name__ == "__main__":
    unittest.main()
