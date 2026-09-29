"""采集器写数据库的规则：用模拟的接口响应，不发真实请求。

使用项目真实的 config/（游戏、官方账号、精选视频），数据库在临时目录。
"""
from __future__ import annotations

import contextlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from collectors import bilibili, common, steam, steam_build, steam_reviews_backfill as backfill, steamdb_import, youtube
from store import config_sync, db

WW = "wuthering_waves"


class CollectorTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.conn = db.connect(self.root / "g.sqlite")
        config_sync.sync(self.conn)
        self.stack = contextlib.ExitStack()
        for module in (steam, steam_build, bilibili, youtube, backfill):
            if hasattr(module, "polite_sleep"):
                self.stack.enter_context(patch.object(module, "polite_sleep", lambda *a, **k: None))
            if hasattr(module, "save_raw"):
                self.stack.enter_context(patch.object(module, "save_raw", lambda *a, **k: None))
        self.stack.enter_context(patch.object(backfill.time, "sleep", lambda *a: None))
        self.stack.enter_context(patch.object(backfill, "RAW_DIR", self.root / "raw"))
        self.game = common.get_game(WW)

    def tearDown(self):
        self.stack.close()
        self.conn.close()
        self.tmp.cleanup()

    def attempts(self, source):
        return [tuple(r) for r in self.conn.execute(
            "SELECT status, expected, succeeded FROM collection_attempt WHERE source = ? ORDER BY attempt_id", (source,))]


def steam_responses(players_ok=True, reviews_ok=True, news=None):
    def fake(sess, url, params=None, **kw):
        if "GetNumberOfCurrentPlayers" in url:
            return ({"response": {"result": 1, "player_count": 7000}}, "ok") if players_ok else (None, "request_error:ReadTimeout")
        if "appreviews" in url:
            return ({"success": 1, "query_summary": {"total_reviews": 56000, "total_positive": 49000,
                                                     "review_score_desc": "Very Positive"}}, "ok") if reviews_ok \
                else (None, "http_502")
        if "GetNewsForApp" in url:
            return {"appnews": {"newsitems": news or []}}, "ok"
        raise AssertionError(url)
    return fake


class Steam(CollectorTestCase):
    NEWS = [{"gid": "1", "title": "Version 3.7 Update Announcement", "url": "u1", "feedlabel": "Community Announcements",
             "feedname": "steam_community_announcements", "date": 1790000000},
            {"gid": "2", "title": "CGMagazine: Wuthering Waves 3.7 Hands-On", "url": "u2", "feedlabel": "CGMagazine",
             "feedname": "cgmagazine", "date": 1790000500}]

    def test_success_writes_daily_totals_and_news(self):
        with patch.object(steam, "get_json", steam_responses(news=self.NEWS)):
            self.assertFalse(steam.run(self.conn, [self.game], "2026-09-29"))
        row = self.conn.execute("SELECT total_reviews, total_positive, current_players FROM steam_daily").fetchone()
        self.assertEqual(tuple(row), (56000, 49000, 7000))
        news = [tuple(r) for r in self.conn.execute("SELECT gid, is_official FROM steam_news ORDER BY gid")]
        self.assertEqual(news, [("1", 1), ("2", 0)])   # 第三方媒体转载不是官方公告
        self.assertEqual(self.attempts("steam"), [("success", 2, 2)])

    def test_failed_field_on_rerun_keeps_the_earlier_value(self):
        with patch.object(steam, "get_json", steam_responses()):
            steam.run(self.conn, [self.game], "2026-09-29")
        with patch.object(steam, "get_json", steam_responses(reviews_ok=False)):
            self.assertTrue(steam.run(self.conn, [self.game], "2026-09-29"))
        row = self.conn.execute("SELECT total_reviews, current_players FROM steam_daily").fetchone()
        self.assertEqual(tuple(row), (56000, 7000))
        self.assertEqual(self.attempts("steam")[-1], ("partial", 2, 1))

    def test_total_failure_writes_nothing_but_the_attempt(self):
        with patch.object(steam, "get_json", steam_responses(players_ok=False, reviews_ok=False)):
            self.assertTrue(steam.run(self.conn, [self.game], "2026-09-29"))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM steam_daily").fetchone()[0], 0)
        detail = self.conn.execute("SELECT detail FROM collection_attempt").fetchone()[0]
        self.assertIn("ReadTimeout", detail)

    def test_crash_in_one_game_is_recorded_and_others_continue(self):
        other = common.get_game("zenless_zone_zero")
        calls = []

        def flaky(conn, game, day):
            calls.append(game["game_id"])
            if game["game_id"] == WW:
                raise RuntimeError("boom")
            return 2, 2, ""
        with patch.object(steam, "collect_one", flaky):
            self.assertTrue(steam.run(self.conn, [self.game, other], "2026-09-29"))
        self.assertEqual(calls, [WW, "zenless_zone_zero"])
        rows = [tuple(r) for r in self.conn.execute("SELECT game_id, status, detail FROM collection_attempt ORDER BY game_id")]
        self.assertEqual(rows, [(WW, "failed", "RuntimeError: boom"), ("zenless_zone_zero", "success", None)])


class SteamBuild(CollectorTestCase):
    def test_build_is_written_with_business_date(self):
        payload = {"status": "success", "data": {"3513350": {"depots": {"branches": {"public": {
            "buildid": "24626793", "timeupdated": "1787170000"}}}}}}
        with patch.object(steam_build, "get_json", lambda *a, **k: (payload, "ok")):
            self.assertFalse(steam_build.run(self.conn, [self.game], "2026-09-29"))
        row = self.conn.execute("SELECT buildid, build_updated_date FROM steam_build").fetchone()
        self.assertEqual(tuple(row), ("24626793", "2026-08-20"))

    def test_missing_public_branch_is_a_failure(self):
        payload = {"status": "success", "data": {"3513350": {"depots": {"branches": {}}}}}
        with patch.object(steam_build, "get_json", lambda *a, **k: (payload, "ok")):
            self.assertTrue(steam_build.run(self.conn, [self.game], "2026-09-29"))
        self.assertEqual(self.attempts("steam_build"), [("failed", 1, 0)])


class Bilibili(CollectorTestCase):
    def test_impostor_upload_is_not_written(self):
        bvids = bilibili.targets(WW, True)
        official = next(iter(common.official_mids(WW)))

        def fake(sess, url, params=None, **kw):
            mid = 1328260 if params["bvid"] == bvids[0] else official   # 第一支被搬运号冒充
            return {"code": 0, "data": {"title": "t", "pubdate": 1790000000, "owner": {"mid": mid, "name": "n"},
                                        "stat": {"view": 100, "like": 5, "reply": 1, "coin": 2, "favorite": 3,
                                                 "share": 0, "danmaku": 9}}}, "ok"
        with patch.object(bilibili, "get_json", fake):
            self.assertTrue(bilibili.run(self.conn, [self.game], "2026-09-29"))
        stored = {r[0] for r in self.conn.execute("SELECT video_id FROM video_obs")}
        self.assertNotIn(bvids[0], stored)
        self.assertEqual(len(stored), len(bvids) - 1)
        self.assertEqual(self.attempts("bilibili"), [("partial", len(bvids), len(bvids) - 1)])
        self.assertIn("owner_mismatch", self.conn.execute("SELECT detail FROM collection_attempt").fetchone()[0])
        comments = self.conn.execute("SELECT comments FROM video_obs LIMIT 1").fetchone()[0]
        self.assertEqual(comments, 1)   # B 站评论数来自 reply


class YouTube(CollectorTestCase):
    def test_identity_checks_and_hidden_counts(self):
        entries = common.curated_youtube_entries(WW)
        channels = {loc: e["channel_id"] for loc, e in common.youtube_channels(WW).items()}
        target_global = next(e for e in entries if e["locale"] == "global")
        target_ja = next(e for e in entries if e["locale"] == "ja")
        target_ko = next(e for e in entries if e["locale"] == "ko")

        def fake(sess, url, params=None, **kw):
            items = []
            for vid in params["id"].split(","):
                entry = next(e for e in entries if e["video_id"] == vid)
                if vid == target_ko["video_id"]:
                    continue   # 删除或转私密：接口不返回
                channel = channels["global"] if vid == target_ja["video_id"] else channels[entry["locale"]]
                stats = {"viewCount": "1000", "commentCount": "3"}   # likeCount 被隐藏
                items.append({"id": vid, "statistics": stats,
                              "snippet": {"channelId": channel, "channelTitle": "c", "title": "t",
                                          "publishedAt": "2026-07-08T03:00:32Z"}})
            return {"items": items}, "ok"
        with patch.object(youtube, "get_json", fake), patch.object(youtube, "youtube_api_key", lambda: "k"):
            self.assertTrue(youtube.run(self.conn, [self.game], "2026-09-29"))
        stored = {r[0]: r[1] for r in self.conn.execute("SELECT video_id, likes FROM video_obs")}
        self.assertIn(target_global["video_id"], stored)
        self.assertIsNone(stored[target_global["video_id"]])       # 隐藏的点赞数是 NULL，不是 0
        self.assertNotIn(target_ja["video_id"], stored)             # 语区标错
        self.assertNotIn(target_ko["video_id"], stored)             # 接口没返回
        detail = self.conn.execute("SELECT detail FROM collection_attempt").fetchone()[0]
        self.assertIn("locale_mismatch", detail)
        published = self.conn.execute("SELECT published_at FROM video WHERE video_id = ?",
                                      (target_global["video_id"],)).fetchone()[0]
        self.assertEqual(published, "2026-07-08T03:00:32Z")

    def test_missing_api_key_is_recorded_as_disabled(self):
        with patch.object(youtube, "youtube_api_key", lambda: None):
            self.assertFalse(youtube.run(self.conn, [self.game], "2026-09-29"))
        self.assertEqual(self.attempts("youtube"), [("disabled", 0, 0)])
        # 审核 L1：数据来源页要显示"未配置"，而不是"过期"或"没有数据"
        status = self.conn.execute("SELECT status FROM v_source_status WHERE game_id = ? AND source = 'youtube'",
                                   (WW,)).fetchone()[0]
        self.assertEqual(status, "disabled")


def api_review(rid, ts, voted_up=True, playtime=60):
    return {"recommendationid": str(rid), "timestamp_created": ts, "voted_up": voted_up, "language": "english",
            "steam_purchase": True, "received_for_free": False,
            "author": {"playtime_at_review": playtime, "playtime_forever": playtime + 10}}


class Reviews(CollectorTestCase):
    def full(self, reviews, stop="empty_page", expected=None):
        return patch.object(backfill, "fetch_all_reviews", lambda *a, **k: (
            reviews, {"pages": 1, "fetched": len(reviews), "total_expected": expected or len(reviews), "stop_reason": stop}))

    def test_full_backfill_replaces_the_set(self):
        with self.full([api_review(1, 1780000000), api_review(2, 1780000000)]):
            backfill.run(self.conn, [self.game], "2026-09-29", incremental=False)
        with self.full([api_review(2, 1780000000, voted_up=False), api_review(3, 1781000000)]):
            self.assertFalse(backfill.run(self.conn, [self.game], "2026-09-29", incremental=False))
        rows = [tuple(r) for r in self.conn.execute("SELECT review_id, voted_up, playtime_at_review FROM review ORDER BY 1")]
        self.assertEqual(rows, [(2, 0, 60), (3, 1, 60)])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review_run WHERE mode = 'full'").fetchone()[0], 2)

    def test_incomplete_full_backfill_keeps_the_old_set(self):
        with self.full([api_review(i, 1780000000) for i in range(100)]):
            backfill.run(self.conn, [self.game], "2026-09-29", incremental=False)
        with self.full([api_review(1, 1780000000)], stop="request_failed:http_502"):
            self.assertTrue(backfill.run(self.conn, [self.game], "2026-09-29", incremental=False))
        with self.full([api_review(i, 1780000000) for i in range(50)]):   # 看似正常结束却少了一半
            self.assertTrue(backfill.run(self.conn, [self.game], "2026-09-29", incremental=False))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review").fetchone()[0], 100)
        self.assertEqual(self.attempts("reviews_full")[1:], [("failed", 1, 0), ("failed", 1, 0)])

    def test_incremental_without_a_full_base_falls_back_to_full(self):
        with self.full([api_review(1, 1780000000)]), \
                patch.object(backfill, "fetch_recent_reviews", side_effect=AssertionError("should not run")):
            self.assertFalse(backfill.run(self.conn, [self.game], "2026-09-29", incremental=True))
        self.assertEqual(self.conn.execute("SELECT mode FROM review_run").fetchone()[0], "full")

    def test_incremental_adds_recent_reviews_and_keeps_older_ones(self):
        with self.full([api_review(i, 1780000000) for i in range(1, 21)]):
            backfill.run(self.conn, [self.game], "2026-09-29", incremental=False)
        recent = [api_review(20, 1790000000, voted_up=False), api_review(21, 1790000000)]
        meta = {"pages": 1, "fetched": 2, "total_expected": 21, "stop_reason": "cutoff_reached", "cutoff": "x"}
        with patch.object(backfill, "fetch_recent_reviews", lambda *a, **k: (recent, meta)) as _:
            self.assertFalse(backfill.run(self.conn, [self.game], "2026-09-29", incremental=True))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review").fetchone()[0], 21)
        self.assertEqual(self.conn.execute("SELECT voted_up FROM review WHERE review_id = 20").fetchone()[0], 0)
        run = self.conn.execute("SELECT mode, cutoff FROM review_run ORDER BY run_id DESC LIMIT 1").fetchone()
        self.assertEqual(run[0], "incremental")

    def test_resumed_full_backfill_keeps_reviews_newer_than_the_walk(self):
        """审核 M1：全量从旧进度续翻时看不到翻页开始之后的新评测，这些评测不能被当成已删除。"""
        start = "2026-09-20T10:00:00+00:00"          # 翻页开始于北京时间 2026-09-20 18:00
        start_ts = 1790503200
        with self.full([api_review(i, 1780000000) for i in range(1, 101)]):
            backfill.run(self.conn, [self.game], "2026-09-19", incremental=False)
        # 翻页开始之后，增量回填存进来 10 条新评测
        db.upsert(self.conn, "review", [backfill.review_row(api_review(1000 + i, start_ts + 3600 * (i + 1)), WW, "x")
                                        for i in range(10)])
        meta = {"pages": 2, "fetched": 100, "total_expected": 100, "stop_reason": "empty_page", "started_at": start}
        rows = [api_review(i, 1780000000) for i in range(1, 101)]
        with patch.object(backfill, "fetch_all_reviews", lambda *a, **k: (rows, meta)):
            self.assertFalse(backfill.run(self.conn, [self.game], "2026-09-22", incremental=False))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review").fetchone()[0], 110)
        covered = self.conn.execute("SELECT covered_through FROM review_run ORDER BY run_id DESC LIMIT 1").fetchone()[0]
        self.assertEqual(covered, "2026-09-20")      # 覆盖到翻页开始那天，不是运行结束的那天

    def test_flattened_v2_rows_keep_their_playtime(self):
        flat = {"recommendationid": "9", "timestamp_created": 1780000000, "voted_up": True,
                "playtime_at_review": 300, "playtime_forever": 400}
        row = backfill.review_row(flat, WW, "x")
        self.assertEqual((row["playtime_at_review"], row["playtime_forever"]), (300, 400))
        self.assertIsNone(row["steam_purchase"])   # 缺失字段是 NULL，不是 False


CSV = "DateTime,Players,Average Players\n" \
      "2026-09-20 00:00:00,9000,8000\n2026-09-21 00:00:00,8500,7900\n2026-09-21 14:00:00,9100,\n"


class SteamDB(CollectorTestCase):
    def test_inbox_import_merges_by_date_and_archives_files(self):
        inbox = self.root / "inbox"
        inbox.mkdir()
        db.upsert(self.conn, "online_daily", [{"game_id": WW, "date": "2025-05-01", "avg_players": 1, "point_players": 2,
                                               "imported_at": "x"}])
        (inbox / "steamdb_chart_3513350 (1).csv").write_text(CSV, encoding="utf-8")
        (inbox / "steamdb_chart_999.csv").write_text(CSV, encoding="utf-8")
        (inbox / "random.csv").write_text("a,b\n", encoding="utf-8")
        self.assertTrue(steamdb_import.import_inbox(self.conn, inbox))
        rows = [tuple(r) for r in self.conn.execute("SELECT date, avg_players, point_players FROM online_daily ORDER BY date")]
        # 09-21 在导出时还没结束（最后一行是 14:00 的日内采样），它的日均不完整，不导入
        self.assertEqual(rows, [("2025-05-01", 1, 2), ("2026-09-20", 8000, 9000)])
        self.assertEqual(len(list((inbox / "imported").iterdir())), 1)
        self.assertEqual(len(list((inbox / "rejected").iterdir())), 2)
        self.assertEqual(list(inbox.glob("*.csv")), [])
        statuses = sorted(r[0] for r in self.conn.execute("SELECT status FROM collection_attempt WHERE source = 'steamdb'"))
        self.assertEqual(statuses, ["failed", "failed", "success"])

    def test_rejected_file_for_a_known_game_shows_on_that_game(self):
        """审核 L2：认出了游戏的失败导入要记在这款游戏名下，数据来源页才看得到。"""
        inbox = self.root / "inbox2"
        inbox.mkdir()
        (inbox / "steamdb_chart_3513350.csv").write_text("DateTime,Players\n2026-09-20 00:00:00,1\n", encoding="utf-8")
        steamdb_import.import_inbox(self.conn, inbox)
        row = self.conn.execute("SELECT game_id, status FROM collection_attempt WHERE source = 'steamdb'").fetchone()
        self.assertEqual(tuple(row), (WW, "failed"))
        status = self.conn.execute("SELECT last_attempt_status FROM v_source_status WHERE game_id = ? AND source = 'steamdb'",
                                   (WW,)).fetchone()[0]
        self.assertEqual(status, "failed")

    def test_file_without_summary_rows_is_rejected(self):
        path = self.root / "steamdb_chart_3513350.csv"
        path.write_text("DateTime,Players,Average Players\n2026-09-21 14:00:00,9100,\n", encoding="utf-8")
        with self.assertRaises(steamdb_import.ImportRejected):
            steamdb_import.import_file(self.conn, path)


if __name__ == "__main__":
    unittest.main()
