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

import yaml  # noqa: E402

from collectors.common import CONFIG_DIR  # noqa: E402
from pipeline.build_snapshot import (  # noqa: E402
    build_events,
    classify_news,
    extract_version,
    is_official_news,
    steam_release,
)
from pipeline.quality import version_table_issues  # noqa: E402


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


class TestVersionTable(unittest.TestCase):
    """鸣潮 3.3 曾因公告标题是「Now Live!」而漏识别，被并入 3.2 的 81 天窗口。"""

    def test_anniversary_now_live_title_is_update(self):
        title = 'Wuthering Waves-2nd Anniv. V3.3 "Reverbs From the End of Galaxies" Now Live!'
        self.assertEqual(extract_version(title), "3.3")
        self.assertEqual(classify_news(title)[0], "version_update")

    def test_gap_and_unlisted_versions_are_reported(self):
        events = [
            {"date_local": "2026-03-19", "version_id": "3.2", "is_version_boundary": True},
            {"date_local": "2026-06-08", "version_id": "3.4", "is_version_boundary": True},
        ]
        codes = {i["code"] for i in version_table_issues(events, {"3.2": {}})}
        self.assertEqual(codes, {"version_gap", "version_not_in_table"})

    def test_major_version_bump_is_not_a_gap(self):
        events = [
            {"date_local": "2025-11-20", "version_id": "2.8", "is_version_boundary": True},
            {"date_local": "2025-12-25", "version_id": "3.0", "is_version_boundary": True},
        ]
        self.assertEqual(version_table_issues(events, {"2.8": {}, "3.0": {}}), [])

    def test_scheduled_version_is_not_a_boundary(self):
        self.assertEqual(steam_release({"status": "scheduled", "steam_start_date": "2026-10-01"}),
                         (None, None))
        self.assertEqual(steam_release({"steam_start_at": "2026-07-29T06:00:00+08:00"}),
                         ("2026-07-29T06:00:00+08:00", "2026-07-29"))

    def test_config_table_is_sourced_and_consecutive(self):
        table = yaml.safe_load((CONFIG_DIR / "versions.yml").read_text(encoding="utf-8"))
        for game_id, versions in table.items():
            released = []
            for version, row in versions.items():
                self.assertIn(row.get("status"), ("released", "scheduled"), (game_id, version))
                self.assertTrue(row.get("source_url"), (game_id, version))
                if row["status"] == "released":
                    _, day = steam_release(row)
                    self.assertTrue(day, (game_id, version))
                    released.append({"date_local": day, "version_id": version,
                                     "is_version_boundary": True})
            self.assertEqual(version_table_issues(released, versions), [], game_id)


if __name__ == "__main__":
    unittest.main()
