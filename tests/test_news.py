"""Steam 公告识别：版本号提取、类型判断、官方来源过滤（三家发行商的标题写法各不相同）。"""
from __future__ import annotations

import unittest

from store import news


class ExtractVersion(unittest.TestCase):
    def test_publisher_styles(self):
        cases = {
            'Version 3.2 "Their Secret Histories" Update Announcement': "3.2",     # 米哈游
            "New Content in Wuthering Waves Version 3.6: Lamplight": "3.6",       # 库洛
            "New Content in Wuthering Waves V2.6: X": "2.6",                      # 库洛缩写
            'Ver. 1.3 "Rising from the Moonlit Fog" Patch Notes': "1.3",          # 完美世界
            "《绝区零》3.2版本PV": "3.2",
            "Server Maintenance Notice": None,
        }
        for title, expected in cases.items():
            with self.subTest(title):
                self.assertEqual(news.extract_version(title), expected)


class Classify(unittest.TestCase):
    def test_update_styles(self):
        for title in ('Version 3.2 "X" Update Announcement', "New Content in Wuthering Waves Version 3.6: X",
                      'Ver. 1.3 "X" Patch Notes', 'Wuthering Waves V3.3 "X" Now Live!'):
            with self.subTest(title):
                self.assertEqual(news.classify(title), "version_update")

    def test_preview_wins_over_update(self):
        # 同时含 Preview 与 Special Program：是前瞻节目，不能当作版本分界
        self.assertEqual(news.classify("NTE Version 1.4 Preview Special Program丨Airing Soon"), "version_preview")

    def test_plain_announcement(self):
        self.assertEqual(news.classify("Version 2.0 something else entirely"), "version_news")


class OfficialFeed(unittest.TestCase):
    def test_feed_name_decides(self):
        self.assertTrue(news.is_official("steam_community_announcements", None))
        self.assertFalse(news.is_official("GamingOnLinux", "GamingOnLinux"))
        self.assertFalse(news.is_official("CGMagazine", "Community Announcements"))

    def test_old_items_without_feed_name_fall_back_to_label(self):
        self.assertTrue(news.is_official(None, "Community Announcements"))
        self.assertFalse(news.is_official(None, "CGMagazine"))


if __name__ == "__main__":
    unittest.main()
