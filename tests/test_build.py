"""构建与导出：用合成数据走一遍完整构建，检查发布包。"""
from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from store import build, checks, db, derive, export
from tests.support import fixture


class BuildPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.db_path = fixture.build(cls.root)
        cls.out = cls.root / "dist"
        cls.result = build.build(cls.db_path, cls.out, config_dir=cls.root / "config", backup=False)
        cls.manifest = cls.result["manifest"]
        cls.public = cls.root / "public.sqlite"
        packed = (cls.out / "data" / cls.manifest["database"]["file"]).read_bytes()
        cls.public.write_bytes(gzip.decompress(packed))
        cls.pub = sqlite3.connect(cls.public)
        cls.pub.create_aggregate("quantile", 2, db.Quantile)

    @classmethod
    def tearDownClass(cls):
        cls.pub.close()
        cls.tmp.cleanup()

    def scalar(self, sql, *args):
        return self.pub.execute(sql, args).fetchone()[0]

    def test_manifest_points_to_a_file_with_matching_hash(self):
        info = self.manifest["database"]
        raw = self.public.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), info["sha256"])
        self.assertEqual(len(raw), info["bytes"])
        self.assertTrue(info["file"].startswith(f"gamepulse.{info['sha256'][:12]}"))
        on_disk = json.loads((self.out / "data" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["build_id"], self.manifest["build_id"])

    def test_web_files_are_copied(self):
        self.assertTrue((self.out / "vendor" / "sql-wasm.wasm").exists())
        self.assertTrue((self.out / "lib" / "query.js").exists())
        self.assertFalse((self.out / "package.json").exists())

    def test_reviews_are_stored_once(self):
        tables = {r[0] for r in self.pub.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertIn("v_review_base", tables)
        self.assertNotIn("review", tables)
        self.assertNotIn("online_hourly", tables)

    def test_public_views_give_the_same_numbers_as_the_local_database(self):
        local = db.connect(self.db_path)
        try:
            for sql in (
                "SELECT game_id, version_id, COUNT(*), SUM(voted_up = 1), quantile(playtime_at_review, 0.5) "
                "FROM v_review GROUP BY 1, 2 ORDER BY 1, 2",
                "SELECT game_id, playtime_band, language, COUNT(*) FROM v_review GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
                "SELECT game_id, SUM(reviews), SUM(complete_day) FROM v_review_daily GROUP BY 1 ORDER BY 1",
                "SELECT platform, video_id, views, first_obs_age FROM v_video_latest ORDER BY 1, 2",
                "SELECT game_id, source, status FROM v_source_status ORDER BY 1, 2",
            ):
                with self.subTest(sql=sql[:60]):
                    self.assertEqual([tuple(r) for r in local.execute(sql)],
                                     [tuple(r) for r in self.pub.execute(sql)])
        finally:
            local.close()

    def test_catalog_and_build_info_are_embedded(self):
        cat = json.loads(self.scalar("SELECT value FROM app_config WHERE key = 'catalog'"))
        self.assertIn("review_count", cat["metrics"])
        info = json.loads(self.scalar("SELECT value FROM app_config WHERE key = 'build'"))
        self.assertEqual(info["build_id"], self.manifest["build_id"])
        self.assertEqual(self.scalar("SELECT build_id FROM build_meta"), self.manifest["build_id"])

    def test_failure_details_are_sanitized(self):
        detail = self.scalar("SELECT detail FROM collection_attempt WHERE status = 'failed'")
        self.assertNotIn("127.0.0.1", detail)
        self.assertNotIn("googleapis.com", detail)
        self.assertIn("ConnectTimeout", detail)

    def test_derived_events_and_issues(self):
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM event WHERE type = 'version_update' AND game_id = 'alpha'"), 3)
        self.assertEqual(self.scalar("SELECT COUNT(*) FROM event WHERE type = 'version_preview'"), 1)
        codes = {r[0] for r in self.pub.execute("SELECT code FROM quality_issue")}
        self.assertIn("missing_days", codes)          # 合成数据里 steam_daily 漏了两天
        self.assertIn("version_not_in_table", codes)  # 公告提到 1.4，版本表没有

    def test_reviews_outside_every_version_are_reported(self):
        conn = db.connect(self.db_path)
        try:
            db.upsert(conn, "review", [{"review_id": 999999, "game_id": "alpha", "created_at": 0,
                                        "created_date": "2026-05-20", "voted_up": 1, "language": "english",
                                        "playtime_at_review": 10, "playtime_forever": 10, "steam_purchase": 1,
                                        "received_for_free": 0, "last_seen_at": "x"}])
            issues = [i for i in derive.quality_issues(conn) if i["code"] == "reviews_without_version"]
            conn.execute("DELETE FROM review WHERE review_id = 999999")
        finally:
            conn.close()
        self.assertEqual([(i["game_id"], json.loads(i["detail"])["count"]) for i in issues], [("alpha", 1)])

    def test_concurrent_builds_leave_a_consistent_bundle(self):
        """审核 M2：几次构建同时运行，manifest 不能指向被清理掉的数据库文件。"""
        from concurrent.futures import ThreadPoolExecutor
        out = self.root / "dist-concurrent"      # 单独的输出目录，不影响本类其他测试依赖的发布包
        with ThreadPoolExecutor(3) as pool:
            list(pool.map(lambda _: build.build(self.db_path, out, config_dir=self.root / "config", backup=False),
                          range(3)))
        manifest = json.loads((out / "data" / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue((out / "data" / manifest["database"]["file"]).exists())
        self.assertEqual([p.name for p in (out / "data").glob(".*")], [])   # 没有留下临时文件

    def test_rebuilding_keeps_the_previous_database_file(self):
        first = self.manifest["database"]["file"]
        conn = db.connect(self.db_path)
        try:
            db.upsert(conn, "online_daily", [{"game_id": "alpha", "date": "2026-09-30", "avg_players": 1,
                                              "point_players": 1, "imported_at": "x"}])
        finally:
            conn.close()
        second = build.build(self.db_path, self.out, config_dir=self.root / "config", backup=False)["manifest"]
        third = build.build(self.db_path, self.out, config_dir=self.root / "config", backup=False)["manifest"]
        files = sorted(p.name for p in (self.out / "data").glob("gamepulse.*.sqlite.gz"))
        self.assertNotIn(first, files)          # 两次之前的已清理
        self.assertIn(second["database"]["file"], files)
        self.assertIn(third["database"]["file"], files)


class Checks(unittest.TestCase):
    def test_overlapping_releases_are_blocking(self):
        conn = db.connect(":memory:")
        db.upsert(conn, "game", [{"game_id": "g", "display_name": "g", "steam_app_id": 1, "steam_release": "2026-01-01"}])
        db.upsert(conn, "version", [{"game_id": "g", "version_id": "1.0", "start_date": "2026-01-01", "status": "released"},
                                    {"game_id": "g", "version_id": "1.1", "start_date": "2026-01-01", "status": "released"}])
        self.assertTrue(any("share start date" in e for e in checks.run(conn)))
        with self.assertRaises(checks.CheckFailed):
            checks.require(conn)
        conn.close()

    def test_released_version_in_the_future_is_blocking(self):
        """审核 L5：标为已开放、开放日在未来的版本会得到结束早于开始的窗口。"""
        conn = db.connect(":memory:")
        db.upsert(conn, "game", [{"game_id": "g", "display_name": "g", "steam_app_id": 1, "steam_release": "2026-01-01"}])
        db.upsert(conn, "version", [{"game_id": "g", "version_id": "9.9", "start_date": "2099-01-01", "status": "released"}])
        self.assertTrue(any("starts in the future" in e for e in checks.run(conn)))
        conn.close()

    def test_clean_database_passes(self):
        conn = db.connect(":memory:")
        self.assertEqual(checks.run(conn), [])
        conn.close()


class Sanitize(unittest.TestCase):
    def test_urls_ips_and_keys_are_removed(self):
        cases = {
            "HTTPSConnectionPool(host=x): https://a.b/c?key=SECRET via http://10.0.0.2:7890 key=abc":
                ("SECRET", "10.0.0.2", "a.b/c", "abc"),
            "ProxyError socks5://user:pw@proxy.lan:1080": ("user:pw", "proxy.lan"),
            "host='myproxy.corp', port=8080": ("myproxy.corp", "8080"),
            "connect to localhost:7890 failed": ("7890",),
            "{'key': 'AIzaSyAbcdefghijklmnopqrstuv'}": ("AIza",),
            "api_key: abc123": ("abc123",),
            "[::1]:7890 refused": ("::1",),
        }
        for text, secrets in cases.items():
            clean = export.sanitize(text)
            for secret in secrets:
                self.assertNotIn(secret, clean, text)
        self.assertEqual(export.sanitize("request_error:ConnectTimeout:retried2"), "request_error:ConnectTimeout:retried2")


if __name__ == "__main__":
    unittest.main()
