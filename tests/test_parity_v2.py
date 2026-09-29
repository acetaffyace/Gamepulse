"""迁移口径对照：v3 数据库算出的数字必须与 v2 已发布的数字一致。

需要 v2 目录（默认 ../game-ops-radar，可用环境变量 GAMEPULSE_V2 指定）；
没有 v2 数据时整组跳过，例如在 CI 的干净 clone 里。只在过渡期保留，切换完成后删除。
"""
from __future__ import annotations

import json
import os
import statistics
import tempfile
import unittest
from pathlib import Path

from store import db, migrate_v2

V2 = Path(os.environ.get("GAMEPULSE_V2") or Path(__file__).resolve().parents[2] / "game-ops-radar")
GAMES = ("wuthering_waves", "zenless_zone_zero", "neverness_to_everness")
HAS_V2 = (V2 / "data" / "index.json").exists() and (V2 / "data" / "raw" / "backfill").is_dir()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


@unittest.skipUnless(HAS_V2, f"v2 data not found at {V2}")
class ParityWithV2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.conn = db.connect(Path(cls.tmp.name) / "parity.sqlite")
        cls.result = migrate_v2.migrate(V2, cls.conn)
        cls.index = json.loads((V2 / "data" / "index.json").read_text(encoding="utf-8"))
        cls.snapshots = {}
        for entry in cls.index["games"]:
            release = V2 / "data" / "releases" / cls.index["build_id"] / f"snapshot_{entry['game_id']}.json"
            cls.snapshots[entry["game_id"]] = json.loads(release.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        cls.tmp.cleanup()

    def test_daily_review_counts_match_v2_history_on_every_day(self):
        for gid in GAMES:
            history = read_jsonl(V2 / "data" / "series" / gid / "review_history.jsonl")
            got = {r["date"]: (r["reviews"], r["positive"], r["negative"]) for r in self.conn.execute(
                "SELECT date, reviews, positive, negative FROM v_review_daily WHERE game_id = ?", (gid,))}
            want = {h["date_local"]: (h["new_reviews"], h["new_positive"], h["new_negative"]) for h in history}
            with self.subTest(gid):
                self.assertEqual(got, want)

    def test_version_windows_match_v2_catalog(self):
        for entry in self.index["games"]:
            gid = entry["game_id"]
            got = {r["version_id"]: (r["start_date"], r["end_date"], r["is_open"]) for r in self.conn.execute(
                "SELECT version_id, start_date, end_date, is_open FROM v_version_window WHERE game_id = ?", (gid,))}
            for v in entry["versions"]:
                with self.subTest(game=gid, version=v["version_id"]):
                    start, end, is_open = got[v["version_id"]]
                    self.assertEqual(start, v["date_local"])
                    if v["open_ended"]:
                        self.assertEqual(is_open, 1)   # v2 截到快照日，v3 开放到今天
                    else:
                        self.assertEqual((end, is_open), (v["end_local"], 0))
            self.assertEqual(len(got), len(entry["versions"]), gid)

    def test_version_comparison_numbers_shown_on_the_v2_page(self):
        rows = self.conn.execute(
            "SELECT version_id, COUNT(*) AS n, SUM(voted_up = 1) AS pos FROM v_review "
            "WHERE game_id = 'wuthering_waves' AND version_id IN ('3.5', '3.6') AND day_index BETWEEN 0 AND 13 "
            "GROUP BY version_id ORDER BY version_id").fetchall()
        self.assertEqual([tuple(r) for r in rows], [("3.5", 1475, 1234), ("3.6", 1017, 828)])
        online = self.conn.execute(
            "SELECT version_id, ROUND(AVG(avg_players)) FROM v_online WHERE game_id = 'wuthering_waves' "
            "AND version_id IN ('3.5', '3.6') AND day_index BETWEEN 0 AND 13 GROUP BY version_id ORDER BY version_id")
        self.assertEqual([tuple(r) for r in online], [("3.5", 18084.0), ("3.6", 12256.0)])

    def test_steamdb_daily_average_matches_v2_online_series(self):
        for gid, snap in self.snapshots.items():
            want = {r["date_local"]: r["value"] for r in snap["online_series"] if r.get("value") is not None}
            got = {r[0]: r[1] for r in self.conn.execute(
                "SELECT date, avg_players FROM v_online WHERE game_id = ?", (gid,)) if r[0] in want}
            with self.subTest(gid):
                self.assertEqual(got, want)

    def test_steam_cumulative_rate_matches_v2(self):
        for gid, snap in self.snapshots.items():
            want = {r["date_local"]: r["value"] for r in snap["review_series"] if r.get("value") is not None}
            got = {r[0]: round(r[1], 2) for r in self.conn.execute(
                "SELECT date, cumulative_positive_rate FROM v_steam_daily WHERE game_id = ?", (gid,))}
            with self.subTest(gid):
                self.assertEqual(got, want)

    def test_latest_video_views_and_version_attribution_match_v2(self):
        for gid, snap in self.snapshots.items():
            videos = [("bilibili", v) for v in snap["bilibili"]["videos"]]
            videos += [("youtube", v) for loc in snap["youtube"]["locales"].values() for v in loc["videos"]]
            latest = {(r["platform"], r["video_id"]): (r["views"], r["version_id"]) for r in self.conn.execute(
                "SELECT platform, video_id, views, version_id FROM v_video_latest WHERE game_id = ?", (gid,))}
            for platform, v in videos:
                if not v.get("latest"):
                    continue
                vid = v.get("bvid") or v.get("video_id")
                with self.subTest(game=gid, video=vid):
                    self.assertEqual(latest[(platform, vid)], (v["latest"]["stats"]["view"], v.get("version_id")))

    def test_playtime_median_uses_the_same_samples_as_v2(self):
        """v2 用"按位置四舍五入取值"，v3 用标准中位数。

        先用 v2 的取值规则在 v3 的评测行上重算，证明两边用的是同一组样本；
        再核对 v3 的 quantile 等于标准中位数（statistics.median，与被测代码无关）。
        """
        checked = 0
        for gid, snap in self.snapshots.items():
            runs = {r["mode"]: r for r in self.conn.execute(
                "SELECT mode, cutoff FROM review_run WHERE game_id = ?", (gid,))}
            cutoff = (runs.get("incremental") or {})["cutoff"] if "incremental" in runs else "9999-12-31"
            for window in snap["review_profile"]["version_windows"]:
                comparison = next(c for c in window["comparisons"] if c["field"] == "playtime_at_review_median")
                pivot = window["date_local"]
                sides = {
                    "before": ("date(?, '-' || ? || ' days')", "date(?, '-1 day')"),
                    "after": ("?", "date(?, '+' || (? - 1) || ' days')"),
                }
                for side, (lo, hi) in sides.items():
                    lo_args = (pivot, window["window"]) if side == "before" else (pivot,)
                    hi_args = (pivot,) if side == "before" else (pivot, window["window"])
                    rng = self.conn.execute(f"SELECT {lo}, {hi}", lo_args + hi_args).fetchone()
                    if rng[1] >= cutoff:
                        continue   # v2 的玩家结构只读全量回填，增量区间内样本不同
                    values = sorted(r[0] for r in self.conn.execute(
                        "SELECT playtime_at_review FROM review WHERE game_id = ? AND created_date BETWEEN ? AND ? "
                        "AND playtime_at_review IS NOT NULL", (gid, rng[0], rng[1])))
                    if not values:
                        continue
                    v2_rule = values[min(int(.5 * (len(values) - 1) + .5), len(values) - 1)]
                    v3 = self.conn.execute(
                        "SELECT quantile(playtime_at_review, 0.5) FROM review WHERE game_id = ? "
                        "AND created_date BETWEEN ? AND ?", (gid, rng[0], rng[1])).fetchone()[0]
                    with self.subTest(game=gid, version=window["version_id"], side=side):
                        self.assertEqual(v2_rule, comparison[side])
                        self.assertAlmostEqual(v3, statistics.median(values))
                    checked += 1
        self.assertGreater(checked, 20)

    def test_nothing_observed_was_left_out(self):
        """v2 里 observed 的视频观测都应导入；被跳过的只能是采集失败。"""
        self.assertEqual(set(self.result["skipped"]) - {"video_not_observed"}, set())
        observed = 0
        for gid in GAMES:
            for platform in ("bilibili", "youtube"):
                for day in read_jsonl(V2 / "data" / "series" / gid / f"{platform}.jsonl"):
                    observed += sum(v.get("status") == "observed" and v.get("view") is not None
                                    and v.get("identity_verified") is not False for v in day["videos"])
        self.assertEqual(self.result["imported"]["video_obs"], observed)


if __name__ == "__main__":
    unittest.main()
