"""配置同步：YAML → 维度表。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from store import config_sync, db

GAMES = {"games": [
    {"game_id": "g1", "display_name": "游戏一", "steam_app_id": 1, "steam_release": "2026-01-01"},
    {"game_id": "g2", "display_name": "游戏二", "steam_app_id": 2, "color": "#123456"},
]}
VERSIONS = {"g1": {
    "1.0": {"steam_start_date": "2026-01-01", "status": "released"},
    "1.1": {"steam_start_at": "2026-02-01T06:00:00+08:00", "status": "released", "cn_start_date": "2026-01-28"},
    "1.2": {"cn_start_date": "2026-03-01", "status": "scheduled"},
}}
BILIBILI = {"official_accounts": {"g1": {"mid": 42, "name": "官方号"}},
            "videos": [{"bvid": "BV1", "game_id": "g1", "title": "登记标题", "pubdate": "2026-01-05",
                        "content_type": "other", "version_id": None, "version_confirmed": False,
                        "is_official_account": True, "active": True}]}
YOUTUBE = {"official_channels": {"g1": {"global": {"channel_id": "UC1", "title": "Global"}}},
           "videos": [{"video_id": "Y1", "game_id": "g1", "locale": "global", "title": "yt", "pubdate": "2026-01-06",
                       "content_type": "other", "is_official_account": True, "active": True}]}
PAIRS = {"videos": [{"pair_id": "p1", "game_id": "g1", "bvid": "BV1", "pubdate": "2026-01-05",
                     "content_type": "character_trailer", "version_id": "1.1", "version_confirmed": True,
                     "character_name": "角色", "youtube": {"global": "Y1", "ja": "Y2", "ko": None}}]}


class ConfigSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.write(games=GAMES, versions=VERSIONS, bilibili_videos=BILIBILI, youtube_videos=YOUTUBE,
                   video_pairs=PAIRS)
        self.conn = db.connect(":memory:")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def write(self, **files):
        for name, content in files.items():
            (self.dir / f"{name}.yml").write_text(yaml.safe_dump(content, allow_unicode=True), encoding="utf-8")

    def rows(self, sql):
        return [tuple(r) for r in self.conn.execute(sql)]

    def test_games_get_palette_colors_unless_configured(self):
        config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT game_id, color, active FROM game ORDER BY game_id"),
                         [("g1", config_sync.SLOT_COLORS[0], 1), ("g2", "#123456", 1)])

    def test_versions_take_the_business_date_of_exact_start_time(self):
        config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT version_id, start_date, cn_start_date, status FROM version ORDER BY version_id"),
                         [("1.0", "2026-01-01", None, "released"), ("1.1", "2026-02-01", "2026-01-28", "released"),
                          ("1.2", None, "2026-03-01", "scheduled")])

    def test_utc_start_time_is_converted_to_the_utc8_business_day(self):
        """审核 L3：UTC 22:00 已经是北京时间第二天。"""
        self.write(versions={"g1": {"1.0": {"steam_start_at": "2026-08-19T22:00:00Z", "status": "released"}}})
        config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT start_date, start_at FROM version"), [("2026-08-20", "2026-08-19T22:00:00+00:00")])

    def test_released_version_without_steam_date_is_rejected(self):
        self.write(versions={"g1": {"1.0": {"status": "released"}}})
        with self.assertRaisesRegex(ValueError, "no Steam start date"):
            config_sync.sync(self.conn, self.dir)

    def test_pair_overrides_registry_metadata_and_adds_unregistered_members(self):
        config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT platform, video_id, pair_id, locale, content_type, version_id, "
                                   "version_confirmed, title, identity_verified FROM video ORDER BY video_id"),
                         [("bilibili", "BV1", "p1", "zh-cn", "character_trailer", "1.1", 1, "登记标题", 1),
                          ("youtube", "Y1", "p1", "global", "character_trailer", "1.1", 1, "yt", 1),
                          ("youtube", "Y2", "p1", "ja", "character_trailer", "1.1", 1, None, None)])

    def test_resync_is_idempotent_and_keeps_observed_fields(self):
        config_sync.sync(self.conn, self.dir)
        self.conn.execute("UPDATE video SET observed_title = '接口标题' WHERE video_id = 'BV1'")
        config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM video"), [(3,)])
        self.assertEqual(self.rows("SELECT observed_title FROM video WHERE video_id = 'BV1'"), [("接口标题",)])

    def test_removed_video_and_game_are_kept_but_flagged(self):
        config_sync.sync(self.conn, self.dir)
        self.write(youtube_videos={**YOUTUBE, "videos": []},
                   video_pairs={"videos": []}, games={"games": GAMES["games"][:1]})
        config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT video_id, registered, pair_id FROM video ORDER BY video_id"),
                         [("BV1", 1, None), ("Y1", 0, None), ("Y2", 0, None)])
        self.assertEqual(self.rows("SELECT game_id, active FROM game ORDER BY game_id"), [("g1", 1), ("g2", 0)])

    def test_registry_for_unknown_game_is_rejected_without_partial_writes(self):
        self.write(video_pairs={"videos": [{**PAIRS["videos"][0], "game_id": "nope"}]})
        with self.assertRaises(ValueError):
            config_sync.sync(self.conn, self.dir)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM game"), [(0,)])


if __name__ == "__main__":
    unittest.main()
