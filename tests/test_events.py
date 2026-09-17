"""版本事件抽取的单元测试。

这些用例对应实际踩到的三个坑：
1. 第三方媒体条目（CGMagazine / GamingOnLinux）标题同样含版本号，
   不过滤会造出并不存在的版本竖线；
2. 三家发行商的版本公告措辞完全不同，只匹配一种会整家漏掉；
3. 「Version 1.4 Preview Special Program」同时含 Preview 与版本号，
   若先匹配更新规则会把前瞻误标成版本分界线。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.build_snapshot import (  # noqa: E402
    build_events,
    classify_news,
    extract_version,
    is_official_news,
)


class TestExtractVersion(unittest.TestCase):
    def test_mihoyo_style(self):
        self.assertEqual(
            extract_version('Version 3.2 "Their Secret Histories" Update Announcement'),
            "3.2")

    def test_kuro_style(self):
        self.assertEqual(
            extract_version("New Content in Wuthering Waves Version 3.6: Lamplight"),
            "3.6")

    def test_perfectworld_abbreviated(self):
        # 完美世界使用 "Ver. 1.3" 缩写
        self.assertEqual(
            extract_version('Ver. 1.3 "Rising from the Moonlit Fog" Patch Notes'),
            "1.3")

    def test_kuro_compact_prefix(self):
        self.assertEqual(
            extract_version("New Content in Wuthering Waves V2.6: X"),
            "2.6")

    def test_chinese_style(self):
        self.assertEqual(extract_version("《绝区零》3.2版本PV"), "3.2")

    def test_no_version(self):
        self.assertIsNone(extract_version("Server Maintenance Notice"))


class TestClassifyNews(unittest.TestCase):
    def test_update_announcement(self):
        kind, _ = classify_news('Version 3.2 "X" Update Announcement')
        self.assertEqual(kind, "version_update")

    def test_new_content_in(self):
        kind, _ = classify_news("New Content in Wuthering Waves Version 3.6: X")
        self.assertEqual(kind, "version_update")

    def test_patch_notes(self):
        kind, _ = classify_news('Ver. 1.3 "X" Patch Notes')
        self.assertEqual(kind, "version_update")

    def test_preview_wins_over_update(self):
        # 同时含 Preview 与 Special Program，必须判为前瞻而非版本更新
        kind, _ = classify_news("NTE Version 1.4 Preview Special Program丨Airing Soon")
        self.assertEqual(kind, "version_preview")

    def test_plain_announcement(self):
        kind, _ = classify_news("Version 2.0 something else entirely")
        self.assertEqual(kind, "version_news")


class TestOfficialFeedFilter(unittest.TestCase):
    def test_community_announcement_is_official(self):
        self.assertTrue(is_official_news(
            {"feedname": "steam_community_announcements"}))

    def test_third_party_feed_rejected(self):
        self.assertFalse(is_official_news({"feedname": "GamingOnLinux"}))
        self.assertFalse(is_official_news({"feedname": "CGMagazine"}))

    def test_legacy_snapshot_without_feedname(self):
        self.assertTrue(is_official_news({"feedlabel": "Community Announcements"}))
        self.assertFalse(is_official_news({"feedlabel": "CGMagazine"}))


class TestBuildEvents(unittest.TestCase):
    def test_third_party_version_does_not_become_boundary(self):
        news = [{"date_local": "2026-09-14", "items": [
            {"gid": "1", "title": "Wuthering Waves 3.0 Hands-On: Exploring",
             "feedname": "CGMagazine", "date_local": "2025-12-21",
             "url": "http://x"},
            {"gid": "2", "title": "New Content in Wuthering Waves Version 3.6: X",
             "feedname": "steam_community_announcements",
             "date_local": "2026-08-20", "url": "http://y"},
        ]}]
        events = build_events(news, [], {})
        boundaries = [e for e in events if e.get("is_version_boundary")]
        self.assertEqual(len(boundaries), 1)
        self.assertEqual(boundaries[0]["version_id"], "3.6")
        self.assertEqual(boundaries[0]["date_local"], "2026-08-20")

    def test_preview_is_not_a_boundary(self):
        news = [{"date_local": "2026-09-14", "items": [
            {"gid": "1", "title": "NTE Version 1.4 Preview Special Program",
             "feedname": "steam_community_announcements",
             "date_local": "2026-09-11", "url": "http://x"},
        ]}]
        events = build_events(news, [], {})
        self.assertEqual([e for e in events if e.get("is_version_boundary")], [])
        self.assertEqual(events[0]["type"], "version_preview")

    def test_duplicate_gid_counted_once(self):
        item = {"gid": "same", "title": 'Version 3.1 "X" Update Announcement',
                "feedname": "steam_community_announcements",
                "date_local": "2026-07-28", "url": "http://x"}
        news = [{"date_local": "2026-09-13", "items": [item]},
                {"date_local": "2026-09-14", "items": [item]}]
        events = build_events(news, [], {})
        self.assertEqual(len(events), 1)

    def test_duplicate_version_updates_with_different_gids_keep_earliest(self):
        news = [{"date_local": "2025-10-10", "items": [
            {"gid": "later", "title": "New Content in Wuthering Waves Version 2.7: X",
             "feedname": "steam_community_announcements",
             "date_local": "2025-10-10", "url": "http://later"},
        ]}, {"date_local": "2025-10-09", "items": [
            {"gid": "earlier", "title": "New Content in Wuthering Waves Version 2.7: X",
             "feedname": "steam_community_announcements",
             "date_local": "2025-10-09", "url": "http://earlier"},
        ]}]
        events = build_events(news, [], {})
        boundaries = [e for e in events if e.get("is_version_boundary")]
        self.assertEqual(len(boundaries), 1)
        self.assertEqual(boundaries[0]["version_id"], "2.7")
        self.assertEqual(boundaries[0]["date_local"], "2025-10-09")


if __name__ == "__main__":
    unittest.main()
