"""SteamDB 在线人数导入：把 SteamDB Charts 导出的 CSV 放进 data/inbox/steamdb/ 即可。

SteamDB 的直接历史接口不可用（403 / API 410）；使用网页导出，Windows 已登录 Edge 可用
tools.steamdb_edge_export 自动点击导出。每次采集开始时扫描收件箱：
  - 按文件名里的 App ID（steamdb_chart_3513350.csv，浏览器重复下载的 "(1)" 后缀也可以）匹配游戏；
  - 只取每天的日汇总行（Average Players 有值的那一行），按日期合并：导出只覆盖部分日期时，
    其余历史保持不变（v2 曾因一份只有几行的导出替换掉 500 多天历史）；
  - 导入成功的文件移到 imported/，无法识别或没有有效行的移到 rejected/，都不删除。

日汇总行的 Players 是某一时点的值，不是峰值（有的日子低于日均），存为 point_players，不作为峰值展示。

SteamDB 的时间是 UTC：日均按 UTC 自然日统计（北京时间当天 08:00 至次日 08:00），与其他数据的北京时间业务日
相差 8 小时。一天的日均无法换算成另一个时区的日均，所以日期原样保存，并在口径说明里写明。
导出文件的最后一天通常还没结束，那一天的"日均"只是部分时段的平均，不导入，等下一次导出。

    python collectors/steamdb_import.py              # 扫描收件箱
    python collectors/steamdb_import.py FILE.csv     # 导入指定文件（文件不移动）
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from collectors.common import DATA_DIR, load_games, now_iso, today_local  # noqa: E402
from store import config_sync, db  # noqa: E402

INBOX = DATA_DIR / "inbox" / "steamdb"
FILE_PATTERN = re.compile(r"steamdb_chart_(\d+)(?:\s*\(\d+\))?\.csv$", re.I)
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class ImportRejected(ValueError):
    pass


def parse(path: Path, game_id: str) -> list[dict]:
    """每个日期保留最后一行日汇总。"""
    daily: dict[str, tuple[datetime, dict]] = {}
    latest: datetime | None = None
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = {"DateTime", "Players", "Average Players"} - set(reader.fieldnames or [])
        if missing:
            raise ImportRejected(f"缺少列 {sorted(missing)}")
        for line, row in enumerate(reader, start=2):
            stamp, average = (row.get("DateTime") or "").strip(), (row.get("Average Players") or "").strip()
            if stamp:
                try:
                    at_any = datetime.strptime(stamp, DATE_FORMAT)
                    latest = at_any if latest is None or at_any > latest else latest
                except ValueError:
                    pass
            if not stamp or not average:
                continue   # 没有 Average Players 的是日内采样，不是日汇总
            try:
                at = datetime.strptime(stamp, DATE_FORMAT)
                avg = int(float(average))
                point = (row.get("Players") or "").strip()
                point = int(float(point)) if point else None
            except ValueError as exc:
                raise ImportRejected(f"第 {line} 行格式不对") from exc
            if avg < 0 or (point is not None and point < 0):
                raise ImportRejected(f"第 {line} 行人数为负")
            day = at.date().isoformat()
            if day not in daily or at > daily[day][0]:
                daily[day] = (at, {"game_id": game_id, "date": day, "avg_players": avg, "point_players": point,
                                   "source_file": path.name})
    # 文件里最后一个时刻所在的那一天还没结束（除非已经到了当天最后一小时），它的日均不完整
    if latest is not None and latest.hour < 23:
        daily.pop(latest.date().isoformat(), None)
    if not daily:
        raise ImportRejected("没有完整的日汇总行（Average Players 为空，或只有尚未结束的当天）")
    return [daily[d][1] for d in sorted(daily)]


def game_for(path: Path) -> str:
    match = FILE_PATTERN.search(path.name)
    if not match:
        raise ImportRejected("文件名里没有 App ID（应为 steamdb_chart_<AppID>.csv）")
    appid = int(match.group(1))
    for g in load_games():
        if int(g.get("steam_app_id") or 0) == appid:
            return g["game_id"]
    raise ImportRejected(f"games.yml 里没有 App ID {appid}")


def import_file(conn, path: Path) -> tuple[str, int]:
    game_id = game_for(path)
    rows = parse(path, game_id)
    imported_at = now_iso()
    db.upsert(conn, "online_daily", [{**r, "imported_at": imported_at} for r in rows])
    return game_id, len(rows)


def _move(path: Path, folder: str) -> Path:
    dest_dir = path.parent / folder
    dest_dir.mkdir(exist_ok=True)
    dest = dest_dir / f"{today_local()}-{path.name}"
    n = 1
    while dest.exists():
        dest = dest_dir / f"{today_local()}-{n}-{path.name}"
        n += 1
    shutil.move(str(path), dest)
    return dest


def import_inbox(conn, inbox: Path = INBOX) -> bool:
    """返回是否有文件被拒绝。收件箱为空时什么都不记录。"""
    inbox.mkdir(parents=True, exist_ok=True)
    rejected = False
    for path in sorted(inbox.glob("*.csv")):
        game_id = None
        try:
            game_id = game_for(path)
            game_id, count = import_file(conn, path)
        except ImportRejected as exc:
            rejected = True
            dest = _move(path, "rejected")
            print(f"  [拒绝] {path.name}：{exc} → {dest.relative_to(inbox)}")
            # 认出了游戏就记在这款游戏名下，数据来源页的 SteamDB 一行会显示失败；认不出的记为全局记录
            db.record_attempt(conn, "steamdb", game_id, today_local(), "failed", expected=1, succeeded=0,
                              detail=f"{path.name}: {exc}")
            continue
        dest = _move(path, "imported")
        latest = conn.execute("SELECT MAX(date) FROM online_daily WHERE game_id = ?", (game_id,)).fetchone()[0]
        print(f"  [导入] {path.name} → {game_id}：{count} 天，在线数据截至 {latest}")
        db.record_attempt(conn, "steamdb", game_id, today_local(), "success", expected=1, succeeded=1,
                          detail=f"{path.name}: {count} days")
    return rejected


def main() -> int:
    parser = argparse.ArgumentParser(description="导入 SteamDB Charts 导出的在线人数 CSV")
    parser.add_argument("files", nargs="*", type=Path, help="指定文件；省略则扫描 data/inbox/steamdb/")
    args = parser.parse_args()
    conn = db.connect()
    try:
        config_sync.sync(conn)
        if not args.files:
            return int(import_inbox(conn))
        failed = False
        for path in args.files:
            try:
                game_id, count = import_file(conn, path)
                print(f"{path.name} → {game_id}：{count} 天")
            except ImportRejected as exc:
                print(f"{path.name}：{exc}")
                failed = True
        return int(failed)
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
