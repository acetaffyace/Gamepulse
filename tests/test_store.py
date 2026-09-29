"""v3 存储层：表结构升级与写入规则。"""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from store import db


def game_row(game_id="wuthering_waves", app_id=3513350):
    return {"game_id": game_id, "display_name": "鸣潮", "short_name": "鸣潮", "developer": "库洛游戏",
            "steam_app_id": app_id, "steam_release": "2025-04-28", "color": "#2a78d6", "active": 1}


def review_row(review_id, game_id="wuthering_waves", day="2026-08-20", voted_up=1, playtime=120):
    return {"review_id": review_id, "game_id": game_id, "created_at": 1787000000, "created_date": day,
            "voted_up": voted_up, "language": "english", "playtime_at_review": playtime,
            "playtime_forever": playtime, "steam_purchase": 1, "received_for_free": 0,
            "last_seen_at": "2026-09-27T10:10:47+00:00"}


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "gamepulse.sqlite"
        self.conn = db.connect(self.path)
        db.upsert(self.conn, "game", [game_row()])

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def count(self, table):
        return self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


class Migrations(StoreTestCase):
    def test_new_database_is_at_latest_version(self):
        self.assertEqual(db.schema_version(self.conn), len(db.migrations()))

    def test_reopening_does_not_rerun_migrations(self):
        self.conn.close()
        self.conn = db.connect(self.path)
        self.assertEqual(self.count("game"), 1)
        self.assertEqual(self.count("fact_source"), 6)

    def test_database_newer_than_code_is_refused(self):
        self.conn.execute("PRAGMA user_version = 99")
        with self.assertRaises(RuntimeError):
            db.apply_migrations(self.conn)

    def test_failed_migration_leaves_version_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "001_ok.sql").write_text("CREATE TABLE a (x INTEGER);", encoding="utf-8")
            Path(folder, "002_bad.sql").write_text("CREATE TABLE b (x INTEGER);\nSELECT * FROM missing;",
                                                   encoding="utf-8")
            conn = sqlite3.connect(":memory:", isolation_level=None)
            with patch.object(db, "MIGRATIONS_DIR", Path(folder)):
                with self.assertRaises(sqlite3.OperationalError):
                    db.apply_migrations(conn)
            self.assertEqual(db.schema_version(conn), 1)
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertEqual(tables, {"a"})

    def test_migration_numbers_must_be_contiguous(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "001_a.sql").write_text("", encoding="utf-8")
            Path(folder, "003_c.sql").write_text("", encoding="utf-8")
            with patch.object(db, "MIGRATIONS_DIR", Path(folder)):
                with self.assertRaises(ValueError):
                    db.migrations()


class Upsert(StoreTestCase):
    def daily(self, **values):
        row = {"game_id": "wuthering_waves", "date": "2026-09-29", "total_reviews": 56381,
               "total_positive": 49373, "review_score_desc": "Very Positive", "current_players": 6958,
               "observed_at": "2026-09-29T08:02:28+00:00"}
        row.update(values)
        return row

    def test_same_key_updates_instead_of_duplicating(self):
        db.upsert(self.conn, "steam_daily", [self.daily()])
        db.upsert(self.conn, "steam_daily", [self.daily(total_reviews=56400, observed_at="2026-09-29T09:00:00+00:00")])
        rows = self.conn.execute("SELECT total_reviews, observed_at FROM steam_daily").fetchall()
        self.assertEqual([tuple(r) for r in rows], [(56400, "2026-09-29T09:00:00+00:00")])

    def test_rerunning_the_same_write_is_idempotent(self):
        for _ in range(3):
            db.upsert(self.conn, "steam_daily", [self.daily()])
        self.assertEqual(self.count("steam_daily"), 1)

    def test_hidden_count_stays_null_and_is_not_mixed_with_old_value(self):
        db.upsert(self.conn, "steam_daily", [self.daily()])
        db.upsert(self.conn, "steam_daily", [self.daily(current_players=None)])
        value = self.conn.execute("SELECT current_players FROM steam_daily").fetchone()[0]
        self.assertIsNone(value)

    def test_columns_not_passed_are_left_unchanged(self):
        db.upsert(self.conn, "steam_daily", [self.daily()])
        db.upsert(self.conn, "steam_daily", [{"game_id": "wuthering_waves", "date": "2026-09-29",
                                              "total_reviews": 56500, "observed_at": "2026-09-29T10:00:00+00:00"}])
        row = self.conn.execute("SELECT total_reviews, total_positive FROM steam_daily").fetchone()
        self.assertEqual(tuple(row), (56500, 49373))

    def test_misspelled_column_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown columns"):
            db.upsert(self.conn, "steam_daily", [{**self.daily(), "total_review": 1}])

    def test_rows_with_different_columns_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "expected"):
            db.upsert(self.conn, "steam_daily", [self.daily(), {"game_id": "wuthering_waves", "date": "2026-09-30",
                                                                "observed_at": "x"}])

    def test_missing_primary_key_is_rejected(self):
        row = self.daily()
        del row["date"]
        with self.assertRaisesRegex(ValueError, "primary key"):
            db.upsert(self.conn, "steam_daily", [row])

    def test_batch_is_all_or_nothing(self):
        with self.assertRaises(sqlite3.IntegrityError):
            db.upsert(self.conn, "steam_daily", [self.daily(), self.daily(date="2026-09-30", total_reviews=-1)])
        self.assertEqual(self.count("steam_daily"), 0)

    def test_negative_counts_and_bad_dates_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            db.upsert(self.conn, "steam_daily", [self.daily(total_reviews=-5)])
        with self.assertRaises(sqlite3.IntegrityError):
            db.upsert(self.conn, "steam_daily", [self.daily(date="2026/09/29")])

    def test_unknown_game_is_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            db.upsert(self.conn, "steam_daily", [self.daily(game_id="no_such_game")])

    def test_unknown_vote_is_stored_as_null_not_negative(self):
        db.upsert(self.conn, "review", [review_row(1, voted_up=None)])
        row = self.conn.execute("SELECT voted_up, SUM(voted_up = 0) AS negatives FROM review").fetchone()
        self.assertIsNone(row["voted_up"])
        self.assertIsNone(row["negatives"])


class VideoObservations(StoreTestCase):
    def setUp(self):
        super().setUp()
        db.upsert(self.conn, "video", [{"platform": "youtube", "video_id": "GSmZaEASKjU",
                                        "game_id": "wuthering_waves", "locale": "global"}])

    def obs(self, **values):
        row = {"platform": "youtube", "video_id": "GSmZaEASKjU", "date": "2026-09-29", "views": 4373670,
               "likes": 25238, "comments": 1830, "coins": None, "favorites": None, "shares": None,
               "danmaku": None, "observed_at": "2026-09-29T08:04:07+00:00"}
        row.update(values)
        return row

    def test_counts_the_platform_does_not_provide_stay_null(self):
        db.upsert(self.conn, "video_obs", [self.obs()])
        row = self.conn.execute("SELECT coins, favorites FROM video_obs").fetchone()
        self.assertEqual(tuple(row), (None, None))

    def test_observation_for_unregistered_video_is_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            db.upsert(self.conn, "video_obs", [self.obs(video_id="not_registered")])


class ReplaceReviews(StoreTestCase):
    def setUp(self):
        super().setUp()
        db.upsert(self.conn, "game", [game_row("zenless_zone_zero", 4162040)])
        db.upsert(self.conn, "review", [review_row(1), review_row(2), review_row(9, game_id="zenless_zone_zero")])

    def ids(self, game_id="wuthering_waves"):
        return [r[0] for r in self.conn.execute(
            "SELECT review_id FROM review WHERE game_id = ? ORDER BY review_id", (game_id,))]

    def test_full_backfill_replaces_one_games_reviews(self):
        # 评测 1 被删除、评测 2 改成差评、评测 3 是新写的
        db.replace_where(self.conn, "review", {"game_id": "wuthering_waves"},
                         [review_row(2, voted_up=0), review_row(3)])
        self.assertEqual(self.ids(), [2, 3])
        self.assertEqual(self.conn.execute("SELECT voted_up FROM review WHERE review_id = 2").fetchone()[0], 0)
        self.assertEqual(self.ids("zenless_zone_zero"), [9])

    def test_failed_replacement_keeps_the_old_set(self):
        with self.assertRaises(sqlite3.IntegrityError):
            db.replace_where(self.conn, "review", {"game_id": "wuthering_waves"},
                             [review_row(4), review_row(5, playtime=-1)])
        self.assertEqual(self.ids(), [1, 2])

    def test_rows_for_another_game_are_refused(self):
        with self.assertRaisesRegex(ValueError, "expected"):
            db.replace_where(self.conn, "review", {"game_id": "wuthering_waves"},
                             [review_row(4, game_id="zenless_zone_zero")])
        self.assertEqual(self.ids(), [1, 2])


class Attempts(StoreTestCase):
    def test_failure_is_recorded_without_touching_facts(self):
        db.upsert(self.conn, "steam_daily", [{"game_id": "wuthering_waves", "date": "2026-09-29",
                                              "total_reviews": 56381, "observed_at": "2026-09-29T08:00:00+00:00"}])
        db.record_attempt(self.conn, "steam", "wuthering_waves", "2026-09-29", "failed",
                          expected=2, succeeded=0, detail="timeout")
        self.assertEqual(self.conn.execute("SELECT total_reviews FROM steam_daily").fetchone()[0], 56381)
        row = self.conn.execute("SELECT status, expected, succeeded, detail FROM collection_attempt").fetchone()
        self.assertEqual(tuple(row), ("failed", 2, 0, "timeout"))

    def test_unknown_status_is_rejected(self):
        with self.assertRaises(ValueError):
            db.record_attempt(self.conn, "steam", "wuthering_waves", "2026-09-29", "ok")


class Transactions(StoreTestCase):
    def test_nested_writes_roll_back_together(self):
        with self.assertRaises(RuntimeError):
            with db.transaction(self.conn):
                db.upsert(self.conn, "review", [review_row(1)])
                db.record_attempt(self.conn, "steam_reviews", "wuthering_waves", "2026-09-29", "success")
                raise RuntimeError("collector crashed")
        self.assertEqual(self.count("review"), 0)
        self.assertEqual(self.count("collection_attempt"), 0)

    def test_second_connection_sees_only_committed_data(self):
        other = db.connect(self.path)
        try:
            with db.transaction(self.conn):
                db.upsert(self.conn, "review", [review_row(1)])
                self.assertEqual(other.execute("SELECT COUNT(*) FROM review").fetchone()[0], 0)
            self.assertEqual(other.execute("SELECT COUNT(*) FROM review").fetchone()[0], 1)
        finally:
            other.close()


class Backup(StoreTestCase):
    def test_backup_is_a_readable_copy_and_old_copies_are_pruned(self):
        db.upsert(self.conn, "review", [review_row(1)])
        folder = Path(self.tmp.name) / "backups"
        for day in range(1, 10):
            target = db.backup(self.conn, folder, keep=7, today=date(2026, 9, day))
        names = sorted(p.name for p in folder.glob("gamepulse-*.sqlite"))
        self.assertEqual(len(names), 7)
        self.assertEqual(names[0], "gamepulse-2026-09-03.sqlite")
        copy = sqlite3.connect(target)
        try:
            self.assertEqual(copy.execute("SELECT COUNT(*) FROM review").fetchone()[0], 1)
        finally:
            copy.close()


if __name__ == "__main__":
    unittest.main()
