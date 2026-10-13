"""Edge 启动流程（模拟）与导出后的 CSV 校验，不启动浏览器、不访问真实数据。"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from tools.steamdb_edge_export import ExportError, ready_edge_window, launch_edge, stage_download


class EdgeStartup(unittest.TestCase):
    @patch("tools.steamdb_edge_export.launch_edge")
    @patch("tools.steamdb_edge_export.edge_windows")
    def test_existing_steamdb_window_is_reused(self, windows, launch):
        other, steamdb = Mock(), Mock()
        other.window_text.return_value = "New tab - Microsoft Edge"
        steamdb.window_text.return_value = "SteamDB - Microsoft Edge"
        windows.return_value = [other, steamdb]
        self.assertIs(ready_edge_window(Mock()), steamdb)
        launch.assert_not_called()

    @patch("tools.steamdb_edge_export.time.sleep")
    @patch("tools.steamdb_edge_export.launch_edge")
    @patch("tools.steamdb_edge_export.edge_windows")
    def test_missing_window_launches_and_waits(self, windows, launch, sleep):
        window = Mock()
        window.window_text.return_value = "New tab - Microsoft Edge"
        windows.side_effect = [[], [], [window]]
        self.assertIs(ready_edge_window(Mock()), window)
        launch.assert_called_once_with()
        sleep.assert_called_once_with(.5)

    @patch("tools.steamdb_edge_export.launch_edge")
    @patch("tools.steamdb_edge_export.edge_windows", return_value=[])
    def test_startup_timeout_is_actionable(self, windows, launch):
        with self.assertRaisesRegex(ExportError, "未出现可操作窗口"):
            ready_edge_window(Mock(), timeout=0)
        launch.assert_called_once_with()

    @patch("tools.steamdb_edge_export.subprocess.Popen")
    @patch("tools.steamdb_edge_export.shutil.which", return_value="C:/Edge/msedge.exe")
    def test_launch_uses_default_profile_without_shell(self, which, popen):
        launch_edge()
        popen.assert_called_once_with(["C:/Edge/msedge.exe", "--new-window", "about:blank"])

    @patch.dict("os.environ", {}, clear=True)
    @patch("tools.steamdb_edge_export.shutil.which", return_value=None)
    def test_missing_installation_reports_error(self, which):
        with self.assertRaisesRegex(ExportError, "未找到 Edge"):
            launch_edge()


class ExportValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.game = {"game_id": "test", "display_name": "测试游戏", "steam_app_id": 123}
        self.today = datetime.now(timezone.utc).date()

    def csv(self, offsets):
        path = self.root / "steamdb_chart_123.csv"
        rows = ['"DateTime","Players","Average Players"']
        for offset in offsets:
            day = (self.today - timedelta(days=offset)).isoformat()
            rows.append(f'"{day} 00:00:00",100,80')
        # 当前 UTC 日只有时点值，应被排除；不能当日平均导入。
        rows.append(f'"{self.today.isoformat()} 12:00:00",110,90')
        path.write_text("\n".join(rows), encoding="utf-8")
        return path

    def test_valid_export_is_copied_with_original_retained_and_today_excluded(self):
        source = self.csv([3, 2, 1])
        result = stage_download(source, self.game, self.root / "inbox")
        self.assertEqual(result["days"], 3)
        self.assertEqual(result["last"], (self.today - timedelta(days=1)).isoformat())
        self.assertTrue(source.exists())
        self.assertEqual(Path(result["file"]).read_bytes(), source.read_bytes())

    def test_missing_daily_mean_is_rejected_before_staging(self):
        with self.assertRaisesRegex(ExportError, "缺少 1 个日汇总"):
            stage_download(self.csv([3, 1]), self.game, self.root / "inbox")
        self.assertFalse((self.root / "inbox").exists())

    def test_stale_export_is_rejected_without_touching_existing_inbox(self):
        inbox = self.root / "inbox"
        inbox.mkdir()
        existing = inbox / "steamdb_chart_123.csv"
        existing.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ExportError, "尚未更新"):
            stage_download(self.csv([3, 2]), self.game, inbox)
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()
