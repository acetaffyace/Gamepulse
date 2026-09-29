"""导出发布包：公开数据库 + manifest + 网页文件。

发布包目录结构（整个目录就是 GitHub Pages 的站点根）：
    index.html, app.css, lib/, pages/, vendor/     ← 从 web/ 复制
    data/gamepulse.<哈希>.sqlite.gz                 ← 公开数据库
    data/manifest.json                              ← 最后写入；网页先读它再按文件名取数据库

manifest 最后写、数据库文件名带内容哈希，所以网页不会读到"新 manifest + 旧数据库"的混合状态。
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from store import db

WEB_DIR = db.ROOT / "web"
# 数据量大、依赖窗口函数或递归的视图，在公开库里存成表（spike 实测查询快约一倍）。
# 依赖"今天"的视图（版本窗口、来源状态）保持为视图，在浏览器里按看的人当天的日期计算。
#
# 评测明细只存一份：v_review_base（评测 × 版本，唯一耗时的区间连接）存成按"游戏 + 日期"聚簇的表，
# 然后删掉 review 原表；上层 v_review 仍是视图，只做周、时长段这类换算。
# 顺序有讲究：依赖 review 原表的 v_review_daily 必须先物化。
MATERIALIZE = {
    "v_review_daily": ["game_id, date"],
    "v_video_obs": ["game_id, locale, date", "platform, video_id, date"],
}
REVIEW_BASE_COLUMNS = ("review_id, game_id, created_date, voted_up, language, playtime_at_review, "
                       "post_review_minutes, version_id, day_index, game_day_index")
REVIEW_BASE_DDL = """
CREATE TABLE v_review_base (
  review_id INTEGER NOT NULL, game_id TEXT NOT NULL, created_date TEXT NOT NULL, voted_up INTEGER,
  language TEXT, playtime_at_review INTEGER, post_review_minutes INTEGER, version_id TEXT,
  day_index INTEGER, game_day_index INTEGER,
  PRIMARY KEY (game_id, created_date, review_id)
) WITHOUT ROWID"""
# 只在本机保留、不公开的表（review 原表在物化后删除，见上）
PRIVATE_TABLES = ("online_hourly",)
_SECRETS = re.compile(
    r"([a-z][a-z0-9+.-]*://\S+"                                            # 任何带协议的地址（含 user:pw@）
    r"|\[[0-9a-f:]+\](?::\d+)?"                                            # [::1]:7890
    r"|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"                                # 10.0.0.2:7890
    r"|\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{2,5}\b"               # proxy.lan:1080
    r"|\b(?:host|port|proxy|key|api_?key|token|secret|password)\b['\"]?\s*[:=]\s*['\"]?[^\s,'\")]+"  # key=…、'key': '…'
    r"|\bAIza[0-9A-Za-z_-]{20,})", re.I)


def sanitize(detail: str | None) -> str | None:
    """失败原因里可能带请求地址、本机代理或密钥参数，公开前去掉。"""
    if not detail:
        return detail
    return _SECRETS.sub("…", detail)


def _materialize(pub: sqlite3.Connection) -> None:
    for view, indexes in MATERIALIZE.items():
        pub.execute(f"CREATE TABLE _m AS SELECT * FROM {view}")
        pub.execute(f"DROP VIEW {view}")
        # 不用 ALTER TABLE RENAME：它会重新解析所有视图，而依赖这个视图的 v_video_latest 此刻找不到对象
        pub.execute(f"CREATE TABLE {view} AS SELECT * FROM _m")
        pub.execute("DROP TABLE _m")
        for i, cols in enumerate(indexes):
            pub.execute(f"CREATE INDEX {view}_{i} ON {view} ({cols})")
    pub.execute("CREATE TABLE _m AS SELECT * FROM v_review_base")
    pub.execute("DROP VIEW v_review_base")
    pub.execute(REVIEW_BASE_DDL)
    pub.execute(f"INSERT INTO v_review_base ({REVIEW_BASE_COLUMNS}) SELECT {REVIEW_BASE_COLUMNS} FROM _m")
    pub.execute("DROP TABLE _m")
    pub.execute("DROP TABLE review")


def public_database(conn: sqlite3.Connection, target: Path, catalog: dict, build: dict) -> None:
    target.unlink(missing_ok=True)
    conn.execute("VACUUM INTO ?", (str(target),))
    pub = sqlite3.connect(target, isolation_level=None)
    try:
        pub.execute("PRAGMA journal_mode = DELETE")
        pub.execute("BEGIN")
        _materialize(pub)
        for table in PRIVATE_TABLES:
            pub.execute(f"DROP TABLE IF EXISTS {table}")
        pub.executemany("UPDATE collection_attempt SET detail = ? WHERE attempt_id = ?",
                        [(sanitize(d), i) for i, d in pub.execute("SELECT attempt_id, detail FROM collection_attempt")])
        pub.execute("INSERT INTO build_meta VALUES (?, ?, ?)",
                    (build["build_id"], build["generated_at"], build["schema_version"]))
        pub.execute("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        pub.executemany("INSERT INTO app_config VALUES (?, ?)", [
            ("catalog", json.dumps(catalog, ensure_ascii=False)),
            ("build", json.dumps(build, ensure_ascii=False)),
        ])
        pub.execute("COMMIT")
        pub.execute("ANALYZE")
        pub.execute("VACUUM")
    finally:
        pub.close()


def _copy_web(web_dir: Path, out_dir: Path) -> None:
    for item in web_dir.iterdir():
        if item.name in {"package.json", "node_modules"}:
            continue
        dest = out_dir / item.name
        if item.is_dir():
            shutil.rmtree(dest, ignore_errors=True)
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)


def export(conn: sqlite3.Connection, out_dir: Path, catalog: dict, *, web_dir: Path = WEB_DIR,
           keep_previous: bool = True) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    data_dir = out_dir / "data"
    data_dir.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)
    build = {"build_id": f"{now:%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}",
             "generated_at": now.isoformat(timespec="seconds"),
             "schema_version": db.schema_version(conn)}

    tmp = data_dir / f".public-{uuid.uuid4().hex}.sqlite"
    public_database(conn, tmp, catalog, build)
    raw = tmp.read_bytes()
    tmp.unlink()
    digest = hashlib.sha256(raw).hexdigest()
    packed = gzip.compress(raw, 9, mtime=0)
    name = f"gamepulse.{digest[:12]}.sqlite.gz"
    (data_dir / name).write_bytes(packed)

    games = [dict(r) for r in conn.execute(
        "SELECT game_id, display_name, short_name, developer, color, steam_release FROM game WHERE active = 1 "
        "ORDER BY rowid")]
    sources = [dict(r) for r in conn.execute(
        "SELECT game_id, source, label, data_through, status, last_attempt_status, last_attempt_at "
        "FROM v_source_status ORDER BY game_id, source")]
    manifest_path = data_dir / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    manifest = {**build, "database": {"file": name, "bytes": len(raw), "gzip_bytes": len(packed), "sha256": digest},
                "games": games, "sources_at_build": sources}

    _copy_web(web_dir, out_dir)
    tmp_manifest = data_dir / f".manifest-{uuid.uuid4().hex}.json"
    tmp_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_manifest.replace(manifest_path)

    # 保留上一份数据库：发布切换的那一刻正在打开页面的人还能读完旧文件
    keep = {name}
    if keep_previous and previous.get("database", {}).get("file"):
        keep.add(previous["database"]["file"])
    for old in data_dir.glob("gamepulse.*.sqlite.gz"):
        if old.name not in keep:
            old.unlink()
    return manifest
