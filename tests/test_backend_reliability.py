"""Fault injection and cross-module contracts for the production data pipeline."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from collectors import common, bilibili, youtube, youtube_discover, steam_build, steam_online, steam_reviews_backfill as backfill
from collectors.review_checkpoint import ReviewCheckpoint
from pipeline import metrics, review_profile, quality, publication, build_snapshot, import_steamdb_chart
from tools import add_game


class BackendReliability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.stack = contextlib.ExitStack()
        for name, value in {"SERIES_DIR": self.root / "series", "RAW_DIR": self.root / "raw", "COLLECT_LOG": self.root / "log.tsv"}.items():
            self.stack.enter_context(patch.object(common, name, value))

    def tearDown(self):
        self.stack.close(); self.tmp.cleanup()

    def test_failed_retry_preserves_value_and_attempt_provenance(self):
        good = {"date_local": "2026-09-29", "sampled_at": "2026-09-29T02:00:00Z", "players": 123, "status": "observed"}
        common.upsert_series("g", "online", good)
        common.upsert_series("g", "online", {**good, "players": None, "status": "unavailable", "sampled_at": "2026-09-29T03:00:00Z", "note": "timeout"})
        row = common.read_series("g", "online")[0]
        self.assertEqual(row["players"], 123)
        self.assertEqual(row["sampled_at"], good["sampled_at"])
        self.assertEqual(row["last_attempt"]["at"], "2026-09-29T03:00:00Z")
        common.upsert_series("g", "online", {**good, "players": 0})
        self.assertEqual(common.read_series("g", "online")[0]["players"], 0)
        common.upsert_series("g", "online", {**good, "date_local": "2026-09-30", "players": None, "status": "unavailable"})
        self.assertIsNone(common.read_series("g", "online")[-1]["players"])

    def test_video_subsets_and_failed_retries_keep_other_ids(self):
        def write(vid, value):
            common.upsert_video_subset_series("g", "youtube", {"date_local": "2026-09-29", "videos": [{"video_id": vid, "view": value, "status": "observed" if value is not None else "unavailable"}]}, "video_id")
        write("a", 123); write("b", 456); write("a", None)
        self.assertEqual({v["video_id"]: v["view"] for v in common.read_series("g", "youtube")[0]["videos"]}, {"a": 123, "b": 456})

    def test_failed_news_keeps_successful_items(self):
        common.upsert_series("g", "news", {"date_local": "2026-09-29", "items": [{"gid": "a"}], "status": "observed"})
        common.upsert_series("g", "news", {"date_local": "2026-09-29", "items": [], "status": "unavailable"})
        self.assertEqual(common.read_series("g", "news")[0]["items"], [{"gid": "a"}])

    def test_threaded_subsets_do_not_lose_updates(self):
        def write(i):
            common.upsert_video_subset_series("g", "youtube", {"date_local": "2026-09-29", "videos": [{"video_id": str(i), "view": i, "status": "observed"}]}, "video_id")
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(write, range(32)))
        self.assertEqual(len(common.read_series("g", "youtube")[0]["videos"]), 32)

    def test_cross_process_writers_do_not_lose_dates(self):
        code = """from pathlib import Path
import sys
from collectors import common
common.SERIES_DIR=Path(sys.argv[1])
for i in range(15):
 common.upsert_series_keyed('g','race',{'date_local':'2026-09-29','id':sys.argv[2]+'-'+str(i)},('date_local','id'))
"""
        writers = [subprocess.Popen([sys.executable, "-c", code, str(self.root / "series"), str(i)], stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(3)]
        for process in writers:
            _, err = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, err.decode())
        self.assertEqual(len(common.read_series("g", "race")), 45)

    def test_interrupted_atomic_replace_keeps_previous_file(self):
        path = self.root / "data.json"
        common.write_json(path, {"old": True})
        with patch.object(common.os, "replace", side_effect=OSError("injected")):
            with self.assertRaises(OSError): common.write_json(path, {"new": True})
        self.assertEqual(json.loads(path.read_text()), {"old": True})
        self.assertFalse(list(self.root.glob("*.tmp")))

    def test_raw_retries_keep_both_attempts(self):
        common.save_raw("youtube", "g", "2026-09-29", {"ok": True})
        common.save_raw("youtube", "g", "2026-09-29", {"ok": False})
        self.assertEqual(len(list((self.root / "raw/2026-09-29/attempts").glob("*.json"))), 2)

    def test_utc_midnight_contract(self):
        stamp = int(datetime(2026, 9, 8, 20, tzinfo=timezone.utc).timestamp())
        review = {"timestamp_created": stamp, "voted_up": True}
        self.assertEqual(common.business_date(stamp), "2026-09-09")
        self.assertEqual(backfill.aggregate_by_date([review])[0]["date_local"], review_profile.daily_profile([review])[0]["date_local"])
        self.assertEqual(common.business_date("2026-09-08T20:00:00Z"), "2026-09-09")

    def test_population_median_and_valid_denominator(self):
        def row(day, minutes):
            return {"timestamp_created": int(datetime(2026, 9, day, 4, tzinfo=timezone.utc).timestamp()), "playtime_at_review": minutes, "voted_up": True}
        days = review_profile.daily_profile([row(1, 10)] * 100 + [row(2, 1000)])
        self.assertEqual(review_profile._aggregate_window(days, "playtime_at_review_median", "median_of_median"), 10)
        days = review_profile.daily_profile([row(1, 60)] + [row(1, None)] * 99 + [row(2, 6000)] * 100)
        self.assertEqual(review_profile._aggregate_window(days, "short_play_share", "weighted_share"), .99)

    def test_missing_counter_is_not_zero_in_aggregate(self):
        videos = {"a": {"latest": {"stats": {"view": 100, "like": 10, "comment": 1}}}, "b": {"latest": {"stats": {"view": 100, "like": None, "comment": 1}}}}
        total = metrics.video_totals(videos, "youtube")
        self.assertIsNone(total["rates"]["engagement"])
        self.assertEqual(total["coverage"]["like"], 1)
        self.assertEqual(total["totals"]["view"], 200)

    def test_mismatched_identity_is_excluded_and_metadata_recovers(self):
        rows = [{"date_local": "2026-09-28", "videos": [{"video_id": "v", "status": "unavailable"}]}, {"date_local": "2026-09-29", "videos": [{"video_id": "v", "title": "Recovered", "view": 2, "status": "observed"}, {"video_id": "bad", "view": 999, "note": "channel_not_official:x"}]}]
        slots = metrics.video_series(rows, "youtube", id_key="video_id")
        self.assertEqual(slots["v"]["title"], "Recovered")
        self.assertNotIn("bad", slots)

    def test_empty_import_cannot_clear_history(self):
        path = self.root / "online.jsonl";path.write_text('old')
        with self.assertRaises(ValueError): import_steamdb_chart.write_jsonl(path, [])
        self.assertEqual(path.read_text(), 'old')

    def test_successful_response_with_hidden_counter_does_not_mix_old_counts(self):
        common.upsert_video_subset_series('g','youtube',{'date_local':'2026-09-29','videos':[{'video_id':'v','status':'observed','view':100,'like':10}]},'video_id')
        common.upsert_video_subset_series('g','youtube',{'date_local':'2026-09-29','videos':[{'video_id':'v','status':'observed','view':200,'like':None}]},'video_id')
        video=common.read_series('g','youtube')[0]['videos'][0]
        self.assertEqual(video['view'],200);self.assertIsNone(video['like'])

    def test_youtube_registration_preserves_locales(self):
        registry = {"official_channels": {"g": {"ja": {"handle": "@ja"}}}}
        with patch.object(common, "youtube_api_key", return_value=None), patch.object(add_game, "edit_yaml", side_effect=lambda _, mutate: mutate(registry)), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(add_game.add_youtube("@global", "g"), 0)
        self.assertEqual(registry["official_channels"]["g"]["ja"]["handle"], "@ja")
        self.assertEqual(registry["official_channels"]["g"]["global"]["handle"], "@global")

    def test_api_errors_preserve_reason_and_retry_budget(self):
        response = Mock(status_code=403);response.json.return_value = {"error": {"errors": [{"reason": "quotaExceeded"}]}}
        sess=Mock();sess.get.return_value=response
        self.assertEqual(common.get_json(sess, "https://example.test", retries=0), (None, "http_403:quotaExceeded"))
        response=Mock(status_code=429, headers={"Retry-After": "2"});response.json.return_value={}
        good=Mock(status_code=200);good.json.return_value={"ok": True}
        sess.get.side_effect=[response,good]
        with patch.object(common.time, "sleep") as sleep:
            self.assertEqual(common.get_json(sess, "https://example.test")[1], "ok");sleep.assert_called_once_with(2)
        sess.get.side_effect=None;sess.get.return_value=good;good.json.return_value=[]
        self.assertEqual(common.get_json(sess, "https://example.test")[1], "invalid_json_shape")

    def test_all_failed_collectors_return_failure(self):
        for module in [bilibili, youtube]:
            with self.subTest(source=module.__name__), patch.object(sys, "argv", ["collector", "--game", "g"]), patch.object(module, "collect_game", return_value={"videos": [{"status": "unavailable"}]}), contextlib.redirect_stdout(io.StringIO()):
                if module is youtube:
                    with patch.object(module, "youtube_api_key", return_value="test-placeholder"): self.assertEqual(module.main(), 1)
                else: self.assertEqual(module.main(), 1)

    def test_source_health_uses_observations_not_build_date(self):
        rows=[{"date_local":"2026-09-27","videos":[{"view":100}]},{"date_local":"2026-09-29","videos":[{"view":None}]}]
        health=quality.source_health({"youtube":rows},None,"2026-09-29")["youtube"]
        self.assertEqual(health["status"],"failed");self.assertEqual(health["data_through"],"2026-09-27")

    def test_page_checkpoint_resumes_after_interruption(self):
        checkpoint=self.root/'checkpoint.json'
        def payload(ids,cursor):
            return {"success":1,"query_summary":{"total_reviews":3},"cursor":cursor,"reviews":[{"recommendationid":i,"timestamp_created":1,"author":{}} for i in ids]}
        with patch.object(backfill, "get_json", side_effect=[(payload(['1'],'next'), 'ok'), (None,'timeout')]):
            rows,meta=backfill.fetch_all_reviews(123,max_pages=10,sleep=0,checkpoint=checkpoint)
        self.assertEqual(meta['stop_reason'],'request_failed:timeout')
        with patch.object(backfill, "get_json", side_effect=[(payload(['2','3'],'last'),'ok'),(payload([],None),'ok')]) as get:
            rows,meta=backfill.fetch_all_reviews(123,max_pages=10,sleep=0,checkpoint=checkpoint)
        self.assertEqual(get.call_args_list[0].args[2]['cursor'],'next')
        self.assertEqual(len(rows),3);self.assertTrue(backfill.complete_backfill(meta))
        changed=ReviewCheckpoint(checkpoint,{'appid':999});self.assertEqual(changed.state['cursor'],'*')

    def test_unknown_backfill_total_does_not_crash_error_path(self):
        args=argparse.Namespace(game='g',incremental=False,max_pages=2,sleep=0)
        with patch.object(backfill,'RAW_DIR',self.root),patch.object(backfill,'get_game',return_value={'steam_app_id':1,'display_name':'g'}),patch.object(backfill,'fetch_all_reviews',return_value=([],{'pages':1,'collected':0,'total_expected':None,'stop_reason':'request_failed:timeout'})),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(backfill.run_backfill(args),1)

    def test_publication_failure_keeps_previous_complete_batch(self):
        entries=[{'game_id':'a','color':'purple'},{'game_id':'b','color':'green'}]
        snapshots={'a':{'value':1},'b':{'value':2}}
        publication.publish(self.root,entries,snapshots,{'lanes':[]})
        previous=(self.root/'index.json').read_bytes()
        original=publication.write_json
        def fail_config(path,payload):
            if path.name=='dashboard_config.json':raise OSError('interrupted build')
            original(path,payload)
        with patch.object(publication,'write_json',side_effect=fail_config):
            with self.assertRaises(OSError):publication.publish(self.root,entries,{'a':{'value':3},'b':{'value':4}},{'lanes':[]})
        self.assertEqual((self.root/'index.json').read_bytes(),previous)
        index,loaded=publication.load_published(self.root)
        self.assertEqual(loaded['a']['value'],1)
        self.assertEqual(loaded['b']['build_id'],index['build_id'])

    def test_publish_keeps_only_current_and_previous_batches(self):
        entries = [{"game_id": "a"}]
        ids = [publication.publish(self.root, entries, {"a": {"value": n}}, {"lanes": []})["build_id"]
               for n in range(3)]
        kept = sorted(p.name for p in (self.root / "releases").iterdir())
        self.assertEqual(kept, sorted(ids[1:]))
        index, loaded = publication.load_published(self.root)
        self.assertEqual(loaded["a"]["value"], 2)

    def test_local_env_fills_only_missing_variables(self):
        env_file = self.root / ".env"
        env_file.write_text("# comment\nHTTPS_PROXY=http://127.0.0.1:7890\nEXISTING='from-file'\n",
                            encoding="utf-8")
        with patch.dict("os.environ", {"EXISTING": "from-shell"}, clear=True):
            common.load_local_env(env_file)
            import os
            self.assertEqual(os.environ["HTTPS_PROXY"], "http://127.0.0.1:7890")
            self.assertEqual(os.environ["EXISTING"], "from-shell")
            self.assertFalse(common.proxy_missing_for("https://www.googleapis.com/youtube/v3/videos"))
        with patch.dict("os.environ", {}, clear=True):
            self.assertTrue(common.proxy_missing_for("https://www.googleapis.com/youtube/v3/videos"))
            self.assertFalse(common.proxy_missing_for("https://api.bilibili.com/x/web-interface/view"))

    def test_youtube_failure_records_dominant_reason(self):
        videos = [{"status": "unavailable", "note": "request_error:ConnectTimeout:retried2"}] * 3
        with patch.dict("os.environ", {}, clear=True):
            detail = youtube.failure_detail(videos, 0)
        self.assertEqual(detail, "request_error:ConnectTimeout:retried2×3;no_proxy_configured")
        self.assertEqual(youtube.failure_detail([{"status": "observed"}], 1), "")

    def test_single_game_build_keeps_catalog_and_colors(self):
        entries=[{'game_id':g,'color':g} for g in ['a','b','c']]
        publication.publish(self.root,entries,{g:{'value':g} for g in ['a','b','c']},{'lanes':[]})
        snapshot={'game':{'display_name':'B'},'coverage':{'valid_days':1},'quality':{'summary':{}},'snapshot_date':'2026-09-29','events':[]}
        with patch.object(build_snapshot,'DATA_DIR',self.root),patch.object(build_snapshot,'load_games',return_value=[{'game_id':g,'active':True} for g in ['a','b','c']]),patch.object(build_snapshot,'build',return_value=snapshot),patch.object(publication,'compile_config',return_value={'lanes':[]}),patch.object(sys,'argv',['build','--game','b']),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build_snapshot.main(),0)
        index,loaded=publication.load_published(self.root)
        self.assertEqual([g['game_id'] for g in index['games']],['a','b','c'])
        self.assertEqual([g['color'] for g in index['games']],['a','b','c'])
        self.assertEqual(loaded['a']['value'],'a')

    def test_backend_uses_shared_metric_fixtures(self):
        fixtures=json.loads((Path(__file__).parent/'fixtures/video-metric-contract.json').read_text())
        for fixture in fixtures:
            self.assertEqual(metrics.interaction_rates(fixture['stats'],fixture['platform'])['engagement'],fixture['engagement'])

    def test_discovery_distinguishes_partial_from_complete(self):
        first={'items':[{'contentDetails':{'videoId':'v','videoPublishedAt':'2026-09-28T20:00:00Z'},'snippet':{'title':'V'}}],'nextPageToken':'next'}
        with patch.object(youtube_discover,'get_json',side_effect=[(first,'ok'),(None,'timeout')]),patch.object(youtube_discover,'polite_sleep'):
            report=youtube_discover.list_uploads(None,'test-placeholder','p','2026-09-01')
        self.assertFalse(report['complete']);self.assertEqual(report['next_page_token'],'next')
        self.assertEqual(report['items'][0]['pubdate'],'2026-09-29')
        with patch.object(youtube_discover,'get_json',return_value=({'items':[]},'ok')):
            report=youtube_discover.list_uploads(None,'test-placeholder','p','2026-09-01')
        self.assertTrue(report['complete']);self.assertEqual(report['stop_reason'],'exhausted')

    def test_partial_core_collectors_fail_without_stopping_other_games(self):
        games=[{'game_id':'a','steam_app_id':1,'active':True},{'game_id':'b','steam_app_id':2,'active':True}]
        with patch.object(sys,'argv',['collector']),patch.object(steam_build,'load_games',return_value=games),patch.object(steam_build,'collect_game',side_effect=[{'buildid':'1'},RuntimeError('failure')]) as collect,patch.object(steam_build,'polite_sleep'):
            self.assertEqual(steam_build.main(),1);self.assertEqual(collect.call_count,2)
        with patch.object(sys,'argv',['collector']),patch.object(steam_online,'load_games',return_value=games),patch.object(steam_online,'sample_game',side_effect=[{'status':'observed'},{'status':'unavailable'}]),patch.object(steam_online,'polite_sleep'):
            self.assertEqual(steam_online.main(),1)

    def test_same_day_failed_attempt_remains_visible_in_health(self):
        rows=[{'date_local':'2026-09-29','videos':[{'view':123,'last_attempt':{'status':'failed','at':'2026-09-29T03:00:00Z'}}]}]
        attempts=[{'source':'youtube','date_local':'2026-09-29','attempted_at':'2026-09-29T03:00:00Z','expected':1,'succeeded':0,'status':'failed'}]
        health=quality.source_health({'youtube':rows},None,'2026-09-29',attempts)['youtube']
        self.assertEqual(health['status'],'failed');self.assertEqual(health['data_through'],'2026-09-29')

    def test_checkpoint_with_missing_page_restarts_safely(self):
        path=self.root/'checkpoint.json'
        state=ReviewCheckpoint(path,{'appid':1});state.commit([{'recommendationid':'a'}],'next',{'next'},1,2)
        (self.root/state.state['files'][0]).unlink()
        restored=ReviewCheckpoint(path,{'appid':1})
        self.assertEqual(restored.state['cursor'],'*');self.assertEqual(restored.rows,[])


if __name__ == '__main__':unittest.main()
