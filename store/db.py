"""SQLite 存储：连接、表结构升级、写入与备份。

v3 的唯一数据源。设计见 docs/v3-data-layer.md。几条写入规则：

- 采集成功才写事实表；失败只调用 record_attempt()，已有数据不受影响。
- 同一主键再次写入时，传入的列整体覆盖旧值，包括 NULL：平台隐藏的计数就是未知，
  不和旧计数混在一起。没传入的列保持不变。
- 所有写入都在事务里完成，中途出错整体回滚。
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "gamepulse.sqlite"
BACKUP_DIR = ROOT / "data" / "backups"
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
BUSY_TIMEOUT_MS = 30_000

_MIGRATION_NAME = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path | str = DB_PATH, *, migrate: bool = True) -> sqlite3.Connection:
    """打开数据库并升级到最新表结构。

    isolation_level=None 关闭 sqlite3 模块的隐式事务，事务边界只由 transaction() 决定。
    """
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    if str(path) != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    if migrate:
        apply_migrations(conn)
    return conn


def migrations() -> list[tuple[int, Path]]:
    found = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        match = _MIGRATION_NAME.match(path.name)
        if not match:
            raise ValueError(f"migration file name must look like 001_name.sql: {path.name}")
        found.append((int(match.group(1)), path))
    numbers = [n for n, _ in found]
    if numbers != list(range(1, len(numbers) + 1)):
        raise ValueError(f"migrations must be numbered 1..N without gaps: {numbers}")
    return found


def schema_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def apply_migrations(conn: sqlite3.Connection) -> int:
    """按编号执行尚未执行的迁移，每个迁移一个事务。返回升级后的版本号。"""
    current = schema_version(conn)
    available = migrations()
    if current > len(available):
        raise RuntimeError(f"database schema {current} is newer than this code ({len(available)})")
    for number, path in available[current:]:
        with transaction(conn):
            _execute_script(conn, path.read_text(encoding="utf-8"))
            conn.execute(f"PRAGMA user_version = {number}")
    return schema_version(conn)


def _execute_script(conn: sqlite3.Connection, script: str) -> None:
    # executescript() 会先提交当前事务，这里逐条执行以留在调用方的事务里
    buffer = ""
    for line in script.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            if buffer.strip():
                conn.execute(buffer)
            buffer = ""
    if buffer.strip() and not buffer.strip().startswith("--"):
        raise ValueError(f"incomplete SQL statement at end of migration: {buffer[:80]!r}")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """写事务。BEGIN IMMEDIATE 一开始就拿写锁，其他写入者排队等待 busy_timeout。

    可以嵌套：内层只是外层事务的一部分，由最外层统一提交或回滚。
    """
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def columns(conn: sqlite3.Connection, table: str) -> list[str]:
    cols = [row["name"] for row in conn.execute("SELECT name FROM pragma_table_info(?)", (table,))]
    if not cols:
        raise ValueError(f"unknown table: {table}")
    return cols


def primary_key(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    rows = conn.execute("SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", (table,))
    key = tuple(row["name"] for row in rows)
    if not key:
        raise ValueError(f"table has no primary key: {table}")
    return key


def upsert(conn: sqlite3.Connection, table: str, rows: Iterable[Mapping[str, object]]) -> int:
    """按主键插入或更新。返回写入行数。

    列名以表结构为准校验，拼错的字段直接报错，而不是被悄悄丢掉。
    同一批的每一行必须提供相同的列，避免"这一行没传所以没更新"的歧义。
    """
    rows = list(rows)
    if not rows:
        return 0
    known = set(columns(conn, table))
    key = primary_key(conn, table)
    cols = list(rows[0].keys())
    unknown = [c for c in cols if c not in known]
    if unknown:
        raise ValueError(f"{table}: unknown columns {unknown}")
    missing_key = [k for k in key if k not in cols]
    if missing_key:
        raise ValueError(f"{table}: rows must include primary key columns {missing_key}")
    for index, row in enumerate(rows):
        if list(row.keys()) != cols:
            raise ValueError(f"{table}: row {index} has columns {list(row.keys())}, expected {cols}")
    updates = [c for c in cols if c not in key]
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) "
           f"ON CONFLICT ({', '.join(key)}) DO "
           + (f"UPDATE SET {', '.join(f'{c} = excluded.{c}' for c in updates)}" if updates else "NOTHING"))
    with transaction(conn):
        conn.executemany(sql, [tuple(row[c] for c in cols) for row in rows])
    return len(rows)


def replace_where(conn: sqlite3.Connection, table: str, where: Mapping[str, object],
                  rows: Sequence[Mapping[str, object]]) -> int:
    """在一个事务里删除满足条件的旧行并写入新行，例如整体替换某游戏的评测集合。

    每行都必须满足同一条件，防止误把别的游戏的数据写进来。
    """
    known = set(columns(conn, table))
    bad = [c for c in where if c not in known]
    if bad or not where:
        raise ValueError(f"{table}: invalid replace condition {list(where)}")
    for index, row in enumerate(rows):
        for col, value in where.items():
            if row.get(col) != value:
                raise ValueError(f"{table}: row {index} has {col}={row.get(col)!r}, expected {value!r}")
    clause = " AND ".join(f"{c} = ?" for c in where)
    with transaction(conn):
        conn.execute(f"DELETE FROM {table} WHERE {clause}", tuple(where.values()))
        upsert(conn, table, rows)
    return len(rows)


ATTEMPT_STATUSES = ("success", "partial", "failed", "skipped", "disabled")


def record_attempt(conn: sqlite3.Connection, source: str, game_id: str | None, date_local: str,
                   status: str, *, expected: int | None = None, succeeded: int | None = None,
                   detail: str | None = None, attempted_at: str | None = None) -> None:
    """记一次采集尝试。成功、失败都要记；数据来源页和"截至日期"从这里算。"""
    if status not in ATTEMPT_STATUSES:
        raise ValueError(f"unknown attempt status: {status}")
    with transaction(conn):
        conn.execute(
            "INSERT INTO collection_attempt (source, game_id, date, attempted_at, status, expected, succeeded, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (source, game_id, date_local, attempted_at or now_iso(), status, expected, succeeded, detail))


def backup(conn: sqlite3.Connection, dest_dir: Path = BACKUP_DIR, *, keep: int = 7,
           today: date | None = None) -> Path:
    """每天一份完整副本，只保留最近 keep 份。同一天重复运行会覆盖当天的副本。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    day = (today or datetime.now(timezone.utc).date()).isoformat()
    target = dest_dir / f"gamepulse-{day}.sqlite"
    tmp = target.with_suffix(".sqlite.tmp")
    tmp.unlink(missing_ok=True)
    with sqlite3.connect(tmp) as dest:
        conn.backup(dest)
    dest.close()
    tmp.replace(target)
    copies = sorted(dest_dir.glob("gamepulse-*.sqlite"))
    for old in copies[:-keep] if keep > 0 else []:
        old.unlink()
    return target
