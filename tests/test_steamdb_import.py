from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import mock_open, patch

from pipeline.import_steamdb_chart import daily_rows


class TestSteamDbImport(unittest.TestCase):
    def test_daily_summary_uses_latest_partial_day_row(self):
        csv_text = (
            '"DateTime","Players","Average Players"\n'
            '"2026-09-15 00:00:00",8003,9430\n'
            '"2026-09-16 00:00:00",7277,9650\n'
            '"2026-09-16 01:00:00",7417,9621\n'
            '"2026-09-16 01:10:00",7420,9620\n'
            '"2026-09-16 01:20:00",7425,\n'
        )
        path = Path("steamdb_chart_3513350.csv")
        with patch.object(Path, "open", mock_open(read_data=csv_text)):
            rows = daily_rows(path, "wuthering_waves", 3513350)

        self.assertEqual([r["date_local"] for r in rows],
                         ["2026-09-15", "2026-09-16"])
        self.assertEqual(rows[-1]["current_players"], 7420)
        self.assertEqual(rows[-1]["average_players"], 9620)


if __name__ == "__main__":
    unittest.main()
