"""Import SteamDB chart exports as a daily online-player series.

SteamDB CSV exports mix one daily summary row with recent intraday samples.
The daily summary is the row whose ``Average Players`` value is populated.
This importer keeps the latest summary row for each local date and leaves the
existing hourly ``steam_online.jsonl`` series untouched.

Usage:
    python pipeline/import_steamdb_chart.py \
      --game-file wuthering_waves=D:/Download/steamdb_chart_3513350.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import load_games, series_path  # noqa: E402


DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
APP_ID_PATTERN = re.compile(r"steamdb_chart_(\d+)(?: \(\d+\))?\.csv$", re.I)


def parse_game_file(spec: str) -> tuple[str, Path]:
    if "=" not in spec:
        raise ValueError(f"--game-file must be GAME_ID=CSV_PATH: {spec}")
    game_id, raw_path = spec.split("=", 1)
    if not game_id or not raw_path:
        raise ValueError(f"--game-file must be GAME_ID=CSV_PATH: {spec}")
    return game_id, Path(raw_path)


def daily_rows(path: Path, game_id: str, app_id: int) -> list[dict]:
    """Return one normalized SteamDB summary row per local date."""
    summaries: dict[str, tuple[datetime, dict]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        required = {"DateTime", "Players", "Average Players"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path}: missing columns {sorted(missing)}")

        for line_no, row in enumerate(reader, start=2):
            raw_datetime = (row.get("DateTime") or "").strip()
            raw_average = (row.get("Average Players") or "").strip()
            if not raw_datetime or not raw_average:
                # Rows without Average Players are intraday samples, not the
                # daily summary rows this importer is intended to use.
                continue
            try:
                sampled_at = datetime.strptime(raw_datetime, DATE_FORMAT)
                average_players = int(raw_average)
                players = int((row.get("Players") or "").strip())
            except ValueError as exc:
                raise ValueError(f"{path}:{line_no}: invalid summary row") from exc
            if players < 0 or average_players < 0:
                raise ValueError(f"{path}:{line_no}: player counts cannot be negative")

            date_local = sampled_at.date().isoformat()
            record = {
                "date_local": date_local,
                "current_players": players,
                "current_players_status": "observed",
                "current_players_note": "steamdb_chart_daily_point",
                "average_players": average_players,
                "source_datetime": raw_datetime,
                "game_id": game_id,
                "steam_app_id": app_id,
                "source": "steamdb_chart",
            }
            previous = summaries.get(date_local)
            if previous is None or sampled_at > previous[0]:
                summaries[date_local] = (sampled_at, record)

    return [summaries[d][1] for d in sorted(summaries)]


def write_jsonl(path: Path, rows: list[dict], replace: bool = False) -> int:
    """默认按日期合并：导出只覆盖部分日期时，其余历史保持不变。

    SteamDB 的「完整历史」导出与「最近一段」导出文件名相同，误传一份
    只有几行的 CSV 曾会整段替换 500 多天的历史。只有显式 --replace
    才整段替换，并保留一份 .bak。返回写入后的总行数。
    """
    from collectors.common import file_lock, atomic_write_text
    if not rows:
        raise ValueError("没有有效日汇总记录，保留原有历史")
    with file_lock(path):
        existing = []
        if path.exists():
            text = path.read_text(encoding="utf-8")
            atomic_write_text(path.with_suffix(path.suffix + ".bak"), text)
            existing = [json.loads(line) for line in text.splitlines() if line.strip()]
        merged = {} if replace else {r["date_local"]: r for r in existing}
        merged.update({r["date_local"]: r for r in rows})
        ordered = [merged[d] for d in sorted(merged)]
        atomic_write_text(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in ordered))
    return len(ordered)


def main() -> int:
    parser = argparse.ArgumentParser(description="导入 SteamDB 历史在线人数日序列")
    parser.add_argument(
        "--game-file", action="append", required=True,
        help="GAME_ID=CSV_PATH，可重复传入多个游戏",
    )
    parser.add_argument(
        "--replace", action="store_true",
        help="用 CSV 整段替换该游戏的 SteamDB 历史（默认按日期合并）",
    )
    args = parser.parse_args()

    games = {g["game_id"]: g for g in load_games()}
    for spec in args.game_file:
        game_id, path = parse_game_file(spec)
        game = games.get(game_id)
        if not game:
            raise SystemExit(f"unknown game_id: {game_id}")
        if not path.exists():
            raise SystemExit(f"CSV not found: {path}")

        app_id = int(game["steam_app_id"])
        match = APP_ID_PATTERN.search(path.name)
        if match and int(match.group(1)) != app_id:
            raise SystemExit(
                f"{path.name}: app id {match.group(1)} does not match "
                f"{game_id} ({app_id})"
            )

        rows = daily_rows(path, game_id, app_id)
        out = series_path(game_id, "steamdb_online")
        total = write_jsonl(out, rows, replace=args.replace)
        mode = "替换" if args.replace else "合并"
        print(f"{game_id}: {mode} {len(rows)} 个日汇总，历史共 {total} 天 → {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
