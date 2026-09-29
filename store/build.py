"""构建：同步配置 → 刷新派生表 → 校验 → 导出发布包 → 备份。

    python -m store.build                 # 读 data/gamepulse.sqlite，输出到 dist/
    python -m store.build --out site      # 指定输出目录
    python -m store.build --db X --config-dir Y --no-backup   # 测试用

任何一步校验失败都会停止，已有的发布包保持不变。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from store import catalog, checks, config_sync, db, derive, export

DIST_DIR = db.ROOT / "dist"


def build(db_path: Path = db.DB_PATH, out_dir: Path = DIST_DIR, *, config_dir: Path = config_sync.CONFIG_DIR,
          backup: bool = True, web_dir: Path = export.WEB_DIR) -> dict:
    conn = db.connect(db_path)
    try:
        dims = config_sync.sync(conn, config_dir)
        derived = derive.refresh(conn)
        cat = catalog.check(conn, config_dir / "metrics.yml")
        checks.require(conn)
        manifest = export.export(conn, out_dir, cat, web_dir=web_dir)
        backup_path = db.backup(conn) if backup else None
    finally:
        conn.close()
    return {"dimensions": dims, "derived": derived, "manifest": manifest,
            "backup": str(backup_path) if backup_path else None}


def main() -> int:
    parser = argparse.ArgumentParser(description="校验数据并生成发布包")
    parser.add_argument("--db", type=Path, default=db.DB_PATH)
    parser.add_argument("--out", type=Path, default=DIST_DIR)
    parser.add_argument("--config-dir", type=Path, default=config_sync.CONFIG_DIR)
    parser.add_argument("--no-backup", action="store_true")
    args = parser.parse_args()
    if not args.db.exists():
        print(f"找不到数据库 {args.db}。首次使用请先运行 python -m store.migrate_v2 或 python collect.py")
        return 1
    try:
        result = build(args.db, args.out, config_dir=args.config_dir, backup=not args.no_backup)
    except (catalog.CatalogError, checks.CheckFailed, ValueError) as exc:
        print(exc)
        return 1
    m = result["manifest"]
    print(f"已发布 {m['build_id']}：{m['database']['file']}（{m['database']['gzip_bytes'] / 1e6:.2f} MB）→ {args.out}")
    print(f"派生：{result['derived']}；维度：{result['dimensions']}")
    if result["backup"]:
        print(f"备份：{result['backup']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
