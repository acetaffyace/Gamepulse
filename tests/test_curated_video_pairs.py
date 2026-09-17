"""Validation for the manually curated cross-platform video set."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import CONFIG_DIR, official_mids  # noqa: E402
from collectors.bilibili import fetch_video  # noqa: E402
from pipeline.build_snapshot import build_events  # noqa: E402
from unittest.mock import patch


class TestCuratedVideoPairs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = yaml.safe_load(
            (CONFIG_DIR / "video_pairs.yml").read_text(encoding="utf-8"))
        cls.bilibili = yaml.safe_load(
            (CONFIG_DIR / "bilibili_videos.yml").read_text(encoding="utf-8"))
        cls.youtube = yaml.safe_load(
            (CONFIG_DIR / "youtube_videos.yml").read_text(encoding="utf-8"))

    def test_pairs_are_unique_registered_and_in_scope(self):
        rows = self.manifest["videos"]
        self.assertEqual(len(rows), len({row["pair_id"] for row in rows}))
        self.assertEqual(len(rows), len({row["bvid"] for row in rows}))
        registered_bvids = {row["bvid"] for row in self.bilibili["videos"]}
        self.assertTrue({row["bvid"] for row in rows} <= registered_bvids)

        scope = self.manifest["scope"]
        self.assertTrue({row["content_type"] for row in rows} <=
                        set(scope["content_types"]))
        for row in rows:
            self.assertLessEqual(scope["start_date"], row["pubdate"])
            self.assertLessEqual(row["pubdate"], scope["end_date"])

    def test_youtube_pairs_are_unique_registered_and_locale_consistent(self):
        rows = self.manifest["videos"]
        registry = {row["video_id"]: row for row in self.youtube["videos"]}
        seen = set()
        for pair in rows:
            self.assertEqual(set(pair["youtube"]), {"global", "ja", "ko", "zh-tw"})
            for locale, video_id in pair["youtube"].items():
                if not video_id:
                    self.assertIn(locale, pair.get("missing_locale_reason", {}))
                    continue
                self.assertNotIn(video_id, seen)
                self.assertIn(video_id, registry)
                self.assertEqual(registry[video_id]["locale"], locale)
                seen.add(video_id)

    def test_excluded_video_titles_are_not_in_curated_set(self):
        excluded = self.manifest["scope"]["excluded_titles"]
        titles = [row.get("title", "") for row in self.bilibili["videos"]]
        titles.extend(row.get("title", "") for row in self.youtube["videos"])
        for phrase in excluded:
            self.assertFalse(any(phrase in title for title in titles), phrase)

    def test_approved_music_subaccount_is_part_of_official_bilibili_allowlist(self):
        accepted = official_mids("wuthering_waves")
        self.assertEqual(accepted, {1955897084, 3493090606188642})

        payload = {"code": 0, "data": {
            "title": "《鸣潮》先约电台EP3.5——秧秧·玄翎《风之所在》",
            "owner": {"mid": 3493090606188642, "name": "鸣潮先行公约"},
            "pubdate": 1783569600,
            "stat": {"view": 1, "like": 1, "reply": 1},
        }}
        with patch("collectors.bilibili.get_json",
                   return_value=(payload, "ok")):
            measured, _ = fetch_video(None, "BV1NbM36aEtm", accepted)
        self.assertEqual(measured["owner_mid"], 3493090606188642)
        self.assertEqual(measured["note"], "")


class TestManualVersionUpdateDates(unittest.TestCase):
    def test_official_post_date_is_overridden_by_confirmed_live_date(self):
        news = [{"items": [{
            "gid": "zzz-32",
            "title": 'Version 3.2 "Their Secret Histories" Update Announcement',
            "feedname": "steam_community_announcements",
            "date_local": "2026-09-08",
            "url": "https://example.com/announcement",
        }]}]
        events = build_events(news, [], {}, version_updates={
            "3.2": {
                "steam_start_at": "2026-09-09T06:00:00+08:00",
                "steam_source_url": "https://example.com/official-update",
            },
        })
        boundary = next(event for event in events
                        if event.get("is_version_boundary"))
        self.assertEqual(boundary["date_local"], "2026-09-09")
        self.assertEqual(boundary["announcement_date_local"], "2026-09-08")
        self.assertEqual(boundary["update_at"], "2026-09-09T06:00:00+08:00")
        self.assertEqual(boundary["source_url"],
                         "https://example.com/official-update")

    def test_missing_official_post_gets_confirmed_release_boundary(self):
        events = build_events([], [], {}, version_updates={
            "3.5": {"steam_start_date": "2026-07-10"},
        })
        boundaries = [event for event in events
                      if event.get("is_version_boundary")]
        self.assertEqual(len(boundaries), 1)
        self.assertEqual(boundaries[0]["date_local"], "2026-07-10")
        self.assertEqual(boundaries[0]["evidence"], "manual")


if __name__ == "__main__":
    unittest.main()
