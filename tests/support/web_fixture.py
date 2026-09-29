"""为浏览器端测试生成一份完整的发布包（合成数据）。

    python -m tests.support.web_fixture OUT_DIR   # 打印 {"dist": …, "db": …}
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from store import build
from tests.support import fixture


def make(folder: Path) -> dict:
    folder.mkdir(parents=True, exist_ok=True)
    db_path = fixture.build(folder)
    dist = folder / "dist"
    result = build.build(db_path, dist, config_dir=folder / "config", backup=False)
    return {"dist": str(dist), "db": str(db_path), "build_id": result["manifest"]["build_id"],
            "database": str(dist / "data" / result["manifest"]["database"]["file"])}


if __name__ == "__main__":
    print(json.dumps(make(Path(sys.argv[1]))))
