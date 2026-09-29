"""把 dist/ 发布到 gh-pages 分支（GitHub Pages 的站点）。

每次发布生成一个没有父提交的新提交，gh-pages 分支只保留最新一份，仓库不会随数据变大。
不切换分支、不碰当前工作区：用临时索引把 dist/ 写成一棵树再提交（git plumbing）。

    python tools/publish_pages.py            # 只在本地更新 gh-pages 分支，打印将要推送的内容
    python tools/publish_pages.py --push     # 更新并强制推送到 origin/gh-pages
    python tools/publish_pages.py --auto     # 计划任务用：.env 里 GAMEPULSE_AUTO_PUBLISH=1 时才推送

首次使用前需要在 GitHub 仓库 Settings → Pages 里把来源设为 gh-pages 分支的根目录。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from collectors.common import load_local_env  # noqa: E402  —— 导入时读取 .env


def git(*args: str, cwd: Path = ROOT, env: dict | None = None) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{result.stderr.strip()}")
    return result.stdout.strip()


def commit_dist(dist: Path, branch: str, repo: Path = ROOT) -> dict:
    manifest_path = dist / "data" / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError(f"{dist} 里没有发布包（缺少 data/manifest.json），先运行 python -m store.build")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    db_file = dist / "data" / manifest["database"]["file"]
    if not db_file.exists():
        raise RuntimeError(f"manifest 指向的数据库 {db_file.name} 不存在")
    (dist / ".nojekyll").write_text("", encoding="utf-8")   # 让 Pages 原样提供文件，不经过 Jekyll

    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        git("--work-tree", str(dist), "add", "--all", "--force", ".", cwd=repo, env=env)
        tree = git("write-tree", cwd=repo, env=env)
    message = f"Publish {manifest['build_id']}\n\n数据库 {manifest['database']['file']}（{manifest['database']['gzip_bytes']} 字节）"
    commit = git("commit-tree", tree, "-m", message, cwd=repo)
    git("update-ref", f"refs/heads/{branch}", commit, cwd=repo)
    files = git("ls-tree", "-r", "--name-only", commit, cwd=repo).splitlines()
    return {"commit": commit, "build_id": manifest["build_id"], "files": len(files),
            "database": manifest["database"]["file"]}


def main() -> int:
    parser = argparse.ArgumentParser(description="把 dist/ 发布到 gh-pages 分支")
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--branch", default="gh-pages")
    parser.add_argument("--remote", default="origin")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--push", action="store_true", help="强制推送到远程的 gh-pages 分支")
    group.add_argument("--auto", action="store_true", help="GAMEPULSE_AUTO_PUBLISH=1 时才更新并推送")
    args = parser.parse_args()

    load_local_env()
    if args.auto and os.environ.get("GAMEPULSE_AUTO_PUBLISH") != "1":
        print("未开启自动发布（.env 里没有 GAMEPULSE_AUTO_PUBLISH=1），跳过推送。")
        return 0
    try:
        result = commit_dist(args.dist, args.branch)
    except RuntimeError as exc:
        print(exc)
        return 1
    print(f"{args.branch} → {result['commit'][:12]}：发布 {result['build_id']}，{result['files']} 个文件，数据库 {result['database']}")
    if not (args.push or args.auto):
        print(f"只更新了本地分支。确认无误后运行：python tools/publish_pages.py --push")
        return 0
    try:
        # 每次都是没有父提交的新提交，必须强制推送；只影响 gh-pages 分支
        git("push", "--force", args.remote, f"refs/heads/{args.branch}:refs/heads/{args.branch}")
    except RuntimeError as exc:
        print(exc)
        return 1
    print(f"已推送到 {args.remote}/{args.branch}。GitHub Pages 通常在一两分钟内更新。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
