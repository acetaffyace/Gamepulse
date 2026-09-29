"""发布前的阻断性校验：任何一项失败都不发布。

这里只放"数据库本身坏了"或"口径自相矛盾"的检查。数据缺采、过期这类
真实世界的状况不阻止发布，由 quality_issue 和 v_source_status 如实展示。
"""

from __future__ import annotations

import sqlite3


class CheckFailed(RuntimeError):
    pass


def run(conn: sqlite3.Connection) -> list[str]:
    errors: list[str] = []

    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        errors.append(f"integrity_check: {integrity}")
    for row in conn.execute("PRAGMA foreign_key_check"):
        errors.append(f"foreign key violation in {row[0]} (rowid {row[1]}) → {row[2]}")

    # 每日评测（补 0 后）的合计必须等于评测明细的行数
    for r in conn.execute(
            "SELECT r.game_id, r.n, d.total FROM (SELECT game_id, COUNT(*) AS n FROM review GROUP BY game_id) r "
            "LEFT JOIN (SELECT game_id, SUM(reviews) AS total FROM v_review_daily GROUP BY game_id) d USING (game_id) "
            "WHERE d.total IS NOT r.n"):
        errors.append(f"{r[0]}: v_review_daily sums to {r[2]} but review has {r[1]} rows")

    # 已开放版本的窗口必须首尾相接、互不重叠
    for r in conn.execute(
            "SELECT game_id, version_id, end_date, next_version FROM v_version_window w "
            "WHERE next_version IS NOT NULL AND date(end_date, '+1 day') <> "
            "(SELECT start_date FROM v_version_window n WHERE n.game_id = w.game_id AND n.version_id = w.next_version)"):
        errors.append(f"{r[0]} {r[1]}: window ends {r[2]} but {r[3]} does not start the next day")
    for r in conn.execute("SELECT game_id, start_date, COUNT(*) FROM version WHERE status = 'released' "
                          "GROUP BY game_id, start_date HAVING COUNT(*) > 1"):
        errors.append(f"{r[0]}: {r[2]} released versions share start date {r[1]}")

    # 每条评测最多属于一个版本窗口
    for r in conn.execute("SELECT review_id, COUNT(*) FROM v_review GROUP BY review_id HAVING COUNT(*) > 1 LIMIT 5"):
        errors.append(f"review {r[0]} falls into {r[1]} version windows")

    # 比率类视图列必须在 0–100 之间
    bad = conn.execute("SELECT COUNT(*) FROM v_steam_daily WHERE cumulative_positive_rate NOT BETWEEN 0 AND 100").fetchone()[0]
    if bad:
        errors.append(f"v_steam_daily: {bad} rows have a positive rate outside 0–100")
    bad = conn.execute("SELECT COUNT(*) FROM steam_daily WHERE total_positive > total_reviews").fetchone()[0]
    if bad:
        errors.append(f"steam_daily: {bad} rows have more positive reviews than reviews")

    # 精选视频必须有语区（指标目录要求按语区分开统计）
    bad = conn.execute("SELECT COUNT(*) FROM video WHERE pair_id IS NOT NULL AND locale IS NULL").fetchone()[0]
    if bad:
        errors.append(f"video: {bad} curated videos have no locale")
    return errors


def require(conn: sqlite3.Connection) -> None:
    errors = run(conn)
    if errors:
        raise CheckFailed("发布前校验失败：\n  " + "\n  ".join(errors))
