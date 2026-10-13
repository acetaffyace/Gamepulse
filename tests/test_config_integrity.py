"""项目真实配置的一致性：精选视频、官方账号、版本表。

这些 YAML 由人工维护，改错了不会报错，只会让看板悄悄显示错误的数据，所以每次提交都核对一遍。
"""
from __future__ import annotations

import unittest

from collectors.common import CONFIG_DIR, official_mids
from store import config_sync, db, derive


class ConfigIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pairs = config_sync.load_yaml("video_pairs.yml")
        cls.bilibili = config_sync.load_yaml("bilibili_videos.yml")
        cls.youtube = config_sync.load_yaml("youtube_videos.yml")
        cls.versions = config_sync.load_yaml("versions.yml")

    def test_pairs_are_unique_registered_and_in_scope(self):
        rows = self.pairs["videos"]
        self.assertEqual(len(rows), len({r["pair_id"] for r in rows}))
        bvids = [r["bvid"] for r in rows if r.get("bvid")]
        self.assertEqual(len(bvids), len(set(bvids)))
        self.assertTrue(set(bvids) <= {v["bvid"] for v in self.bilibili["videos"]})
        scope = self.pairs["scope"]
        for r in rows:
            game_scope = {**scope, **scope.get("by_game", {}).get(r["game_id"], {})}
            self.assertIn(r["content_type"], game_scope["content_types"])
            self.assertLessEqual(str(game_scope["start_date"]), str(r["pubdate"]))
            self.assertLessEqual(str(r["pubdate"]), str(game_scope["end_date"]))

    def test_youtube_members_are_unique_registered_and_in_the_declared_locale(self):
        registry = {v["video_id"]: v for v in self.youtube["videos"]}
        seen = set()
        for pair in self.pairs["videos"]:
            self.assertEqual(set(pair["youtube"]), {"global", "ja", "ko", "zh-tw"}, pair["pair_id"])
            for locale, vid in pair["youtube"].items():
                if not vid:
                    continue   # 这个语区没有发布对应内容
                with self.subTest(pair=pair["pair_id"], locale=locale):
                    self.assertNotIn(vid, seen)
                    self.assertIn(vid, registry)
                    self.assertEqual(registry[vid]["locale"], locale)
                    self.assertEqual(registry[vid]["game_id"], pair["game_id"])
                seen.add(vid)

    def test_excluded_titles_are_not_registered(self):
        titles = [v.get("title", "") for v in self.bilibili["videos"] + self.youtube["videos"]]
        for phrase in self.pairs["scope"]["excluded_titles"]:
            self.assertFalse(any(phrase in t for t in titles), phrase)

    def test_music_subaccount_is_part_of_the_official_allowlist(self):
        self.assertEqual(official_mids("wuthering_waves"), {1955897084, 3493090606188642})

    def test_version_table_is_sourced(self):
        for game_id, versions in self.versions.items():
            for version, row in versions.items():
                with self.subTest(game=game_id, version=version):
                    self.assertIn(row.get("status"), ("released", "scheduled"))
                    self.assertTrue(row.get("source_url"))
                    if row["status"] == "released":
                        self.assertTrue(row.get("steam_start_date") or row.get("steam_start_at"))

    def test_version_table_has_no_gaps_and_every_video_is_attributable(self):
        conn = db.connect(":memory:")
        try:
            config_sync.sync(conn, CONFIG_DIR)
            gaps = [i for i in derive.quality_issues(conn) if i["code"] == "version_gap"]
            self.assertEqual(gaps, [])
            unknown = conn.execute(
                "SELECT pair_id, version_id FROM video_pair p WHERE version_id IS NOT NULL AND NOT EXISTS "
                "(SELECT 1 FROM version v WHERE v.game_id = p.game_id AND v.version_id = p.version_id)").fetchall()
            self.assertEqual([tuple(r) for r in unknown], [])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
