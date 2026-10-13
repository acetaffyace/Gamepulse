"""永劫端游采集：小数据、模拟 HTTP、独立核对日期与失败保留规则。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from collectors import common, official_news, bilibili, steamcharts, steam_reviews_backfill as backfill
from store import config_sync, db

GAME_ID = 'naraka_bladepoint'

URL = "https://www.yjwujian.cn/news/update/20260907/33456_1313227.html"
LIST = f'<li><a href="{URL}"><span class="title">《永劫无间》9月17日更新公告</span><span class="date">[09-17]</span></a></li>'
ARTICLE = '<h1 class="artTitle">《永劫无间》9月17日更新公告</h1><span class="artDate">[2026/09/17]</span><div class="artText"><p>新英雄上线。</p><p>更多玩法。</p></div>'
CONFIG = {"games": {GAME_ID: {"list_urls": ["https://www.yjwujian.cn/news/"],
                                               "allowed_host": "www.yjwujian.cn", "detail_limit": 1}}}


class Parsing(unittest.TestCase):
    def test_display_date_wins_over_url_creation_date(self):
        parser = official_news.ListParser("https://www.yjwujian.cn/", "www.yjwujian.cn")
        parser.feed(LIST)
        self.assertEqual(parser.items[URL]["date"], "2026-09-17")
        self.assertEqual(parser.items[URL]["category"], "版本更新")
        full = official_news.ListParser("https://www.yjwujian.cn/", "www.yjwujian.cn")
        full.feed(f'<li><a href="{URL}">更新公告</a><span>[2026/09/17]</span></li>')
        self.assertEqual(full.items[URL]["date_basis"], "page_full_date")

    def test_cross_year_and_missing_date(self):
        url = "https://www.yjwujian.cn/news/update/20251230/33456_1.html"
        self.assertEqual(official_news.displayed_date("[01-02]", url)[0], "2026-01-02")
        self.assertEqual(official_news.displayed_date("[02-30]", url)[0], None)
        self.assertEqual(official_news.displayed_date("无显示日期", url)[0], None)

    def test_official_host_and_article_path_are_required(self):
        parser = official_news.ListParser("https://www.yjwujian.cn/", "www.yjwujian.cn")
        for url in [URL.replace("www.", "m."), URL.replace("www.yjwujian.cn", "evil.test"), "javascript:alert(1)", "https://www.yjwujian.cn/download/"]:
            parser.feed(f'<li><a href="{url}">手游公告</a><span>[2026/09/17]</span></li>')
        self.assertEqual(parser.items, {})

    def test_article_date_and_nested_excerpt_without_script(self):
        parser = official_news.ArticleParser()
        parser.feed(ARTICLE.replace("<p>更多", "<script>secret()</script><p>更多"))
        values = parser.values(URL)
        self.assertEqual(values["date"], "2026-09-17")
        self.assertEqual(values["excerpt"], "新英雄上线。 更多玩法。")

    def test_image_only_article_is_observed_without_inventing_excerpt(self):
        parser = official_news.ArticleParser()
        parser.feed('<h1 class="artTitle">规则</h1><span class="artDate">[2026/08/06]</span><div class="artText"><img src="x.jpg"/></div>')
        self.assertIsNone(parser.values(URL)['excerpt'])

    def test_monthly_parser_ignores_rolling_window_and_keeps_source_values(self):
        parser = steamcharts.MonthlyParser()
        parser.feed('<table><tr><td>Last 30 Days</td><td>999</td><td>0</td><td>0%</td><td>2000</td></tr>'
                    '<tr><td>September 2026</td><td>24,915.18</td><td>-5532</td><td>-18%</td><td>74,629</td></tr></table>')
        self.assertEqual(parser.rows, [{'month_start':'2026-09-01','avg_players':24915.18,'peak_players':74629}])


class CollectAndReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.conn = db.connect(self.root / "g.sqlite")
        config_sync.sync(self.conn)
        self.game = common.get_game(GAME_ID)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def collect(self, list_result=(LIST, ""), detail_result=(ARTICLE, "")):
        def fetch(sess, url):
            return detail_result if url == URL else list_result
        with patch.object(official_news, "load_yaml", return_value=CONFIG), \
             patch.object(official_news, "fetch_html", side_effect=fetch), \
             patch.object(official_news, "polite_sleep"), patch.object(official_news, "save_raw"):
            return official_news.run(self.conn, [self.game], "2026-10-08")

    def test_idempotent_and_failed_rerun_preserves_history(self):
        self.assertFalse(self.collect())
        self.assertFalse(self.collect())
        before = dict(self.conn.execute("SELECT * FROM official_news").fetchone())
        self.assertEqual(before["date_basis"], "page_full_date")
        self.assertTrue(self.collect((None, "http_403")))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM official_news").fetchone()[0], 1)
        self.assertEqual(dict(self.conn.execute("SELECT * FROM official_news").fetchone()), before)
        self.assertEqual(self.conn.execute("SELECT status FROM collection_attempt ORDER BY attempt_id DESC LIMIT 1").fetchone()[0], "failed")

    def test_changed_empty_page_fails_and_detail_failure_keeps_list(self):
        self.assertTrue(self.collect(("<html>风控页</html>", "")))
        self.assertTrue(self.collect(detail_result=(None, "http_502")))
        row = self.conn.execute("SELECT date, excerpt FROM official_news").fetchone()
        self.assertEqual(tuple(row), ("2026-09-17", None))
        self.assertEqual(self.conn.execute("SELECT status FROM collection_attempt ORDER BY attempt_id DESC LIMIT 1").fetchone()[0], "partial")

    def test_mixed_detail_rows_write_and_excerpt_is_not_erased(self):
        self.assertFalse(self.collect())
        url2 = URL.replace("1313227", "1313999")
        mixed = LIST + f'<li><a href="{url2}">福利活动</a><span>[09-18]</span></li>'
        self.assertTrue(self.collect((mixed, ""), (None, "http_502")))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM official_news").fetchone()[0], 2)
        self.assertEqual(self.conn.execute("SELECT excerpt FROM official_news WHERE url=?", (URL,)).fetchone()[0], "新英雄上线。 更多玩法。")

    def test_source_freshness_uses_observation_not_publication(self):
        self.collect()
        row = self.conn.execute("SELECT data_through, last_attempt_status FROM v_source_status WHERE game_id=? AND source='official_news'",
                                (GAME_ID,)).fetchone()
        self.assertEqual(tuple(row), ("2026-10-08", "success"))
        other = self.conn.execute("SELECT COUNT(*) FROM v_source_status WHERE game_id='wuthering_waves' AND source='official_news'").fetchone()[0]
        self.assertEqual(other, 0)

    def test_naraka_uses_the_shared_curated_video_pipeline(self):
        with patch.object(bilibili, "targets", return_value=[]) as targets:
            bilibili.collect_one(self.conn, self.game, "2026-10-08")
            targets.assert_called_once_with(GAME_ID, True)
        self.assertEqual(common.official_mids(GAME_ID), {349984754})

    def test_shared_registration_has_both_platforms_and_sourced_version_windows(self):
        counts = {r['platform']: r['n'] for r in self.conn.execute(
            'SELECT platform,COUNT(*) AS n FROM v_video WHERE game_id=? AND curated=1 GROUP BY platform', (GAME_ID,))}
        self.assertGreater(counts.get('bilibili', 0), 0)
        self.assertGreater(counts.get('youtube', 0), 0)
        row = self.conn.execute("SELECT version_id,version_basis FROM v_video WHERE video_id='Wbx9B4yoEI4'").fetchone()
        self.assertEqual(tuple(row), ('2026-07-30', 'confirmed'))
        self.assertGreater(self.conn.execute('SELECT COUNT(*) FROM v_version_window WHERE game_id=?', (GAME_ID,)).fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM v_version_window WHERE game_id=? AND version_id='2026-10-09'", (GAME_ID,)).fetchone()[0], 0)

    def test_archive_paginates_to_date_boundary(self):
        root = 'https://www.yjwujian.cn/news/'
        config = {"games": {GAME_ID: {"list_urls": [root], "allowed_host": "www.yjwujian.cn",
                                                   "archive_roots": [root], "detail_limit": 0}}}
        older = LIST.replace('20260907', '20260601').replace('[09-17]', '[06-01]')
        calls = []
        def fetch(sess, url):
            calls.append(url)
            if url.endswith('index_2.html'):return older, ''
            if url == URL:return ARTICLE, ''
            return LIST, ''
        with patch.object(official_news, 'load_yaml', return_value=config), patch.object(official_news, 'fetch_html', side_effect=fetch), \
             patch.object(official_news, 'polite_sleep'), patch.object(official_news, 'save_raw'):
            self.assertFalse(official_news.run(self.conn, [self.game], '2026-10-08', since='2026-07-08'))
        self.assertIn(root + 'index_2.html', calls)
        self.assertNotIn(root + 'index_3.html', calls)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM official_news').fetchone()[0], 1)

    def test_window_coverage_can_fill_zero_at_cutoff_without_claiming_full_history(self):
        raw = [{"recommendationid": "9001", "timestamp_created": 1783526400, "voted_up": True,
                "language": "english", "author": {"playtime_at_review": 180}}]  # 2026-07-09 UTC+8
        meta = {"pages": 2, "fetched": 1, "total_expected": 300000, "stop_reason": "cutoff_reached",
                "started_at": "2026-10-08T08:00:00+00:00"}
        with patch.object(backfill, 'fetch_recent_reviews', return_value=(raw, meta)), \
             patch.object(backfill, 'RAW_DIR', self.root / 'raw'):
            self.assertEqual(backfill.run_window(self.conn, self.game, '2026-07-08', 0, 100), (1, 1, 'covered:2026-07-08:2026-10-08'))
        first = self.conn.execute('SELECT date,reviews,complete_day FROM v_review_daily WHERE game_id=? ORDER BY date LIMIT 1',
                                  (GAME_ID,)).fetchone()
        self.assertEqual(tuple(first), ('2026-07-08', 0, 1))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review_run WHERE game_id=?", (GAME_ID,)).fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT complete_day FROM v_review_daily WHERE game_id=? AND date='2026-10-08'", (GAME_ID,)).fetchone()[0], 0)

    def test_incomplete_window_does_not_write_or_claim_coverage(self):
        with patch.object(backfill, 'fetch_recent_reviews', return_value=([], {'pages':1, 'fetched':0, 'stop_reason':'max_pages'})), \
             patch.object(backfill, 'RAW_DIR', self.root / 'raw'):
            self.assertEqual(backfill.run_window(self.conn, self.game, '2026-07-08', 0, 1)[1], 0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM review_window_run').fetchone()[0], 0)

    def test_separate_covered_windows_do_not_fill_the_gap_with_zero(self):
        db.insert(self.conn, 'review_window_run', [
            {'game_id':GAME_ID,'cutoff':'2026-07-08','covered_through':'2026-07-10',
             'finished_at':'2026-07-10T08:00:00+00:00','pages':1,'fetched':0,'stop_reason':'cutoff_reached'},
            {'game_id':GAME_ID,'cutoff':'2026-07-20','covered_through':'2026-07-22',
             'finished_at':'2026-07-22T08:00:00+00:00','pages':1,'fetched':0,'stop_reason':'cutoff_reached'}])
        observed = [tuple(r) for r in self.conn.execute('SELECT date,reviews,complete_day FROM v_review_daily WHERE game_id=? ORDER BY date',
                                                       (GAME_ID,))]
        self.assertEqual(observed,[('2026-07-08',0,1),('2026-07-09',0,1),('2026-07-10',0,0),
                                   ('2026-07-20',0,1),('2026-07-21',0,1),('2026-07-22',0,0)])



if __name__ == "__main__":
    unittest.main()
