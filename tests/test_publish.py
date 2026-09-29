"""发布到 gh-pages：在临时仓库里验证，不碰项目自己的仓库。"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools import publish_pages


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


class PublishPages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "README.md").write_text("x", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")
        self.dist = root / "dist"
        (self.dist / "data").mkdir(parents=True)
        (self.dist / "index.html").write_text("<h1>hi</h1>", encoding="utf-8")
        self.publish("b1", "gamepulse.aaa.sqlite.gz")

    def tearDown(self):
        self.tmp.cleanup()

    def publish(self, build_id, db_name):
        for old in (self.dist / "data").glob("*.gz"):
            old.unlink()
        (self.dist / "data" / db_name).write_bytes(b"db")
        (self.dist / "data" / "manifest.json").write_text(json.dumps(
            {"build_id": build_id, "database": {"file": db_name, "gzip_bytes": 2}}), encoding="utf-8")
        return publish_pages.commit_dist(self.dist, "gh-pages", repo=self.repo)

    def test_branch_holds_only_the_latest_bundle_without_history(self):
        second = self.publish("b2", "gamepulse.bbb.sqlite.gz")
        files = git(self.repo, "ls-tree", "-r", "--name-only", "gh-pages").splitlines()
        self.assertEqual(sorted(files), [".nojekyll", "data/gamepulse.bbb.sqlite.gz", "data/manifest.json", "index.html"])
        self.assertEqual(git(self.repo, "rev-list", "--count", "gh-pages"), "1")
        self.assertEqual(git(self.repo, "rev-parse", "gh-pages"), second["commit"])

    def test_working_tree_and_current_branch_are_untouched(self):
        self.assertEqual(git(self.repo, "branch", "--show-current"), "main")
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_bundle_with_missing_database_is_refused(self):
        (self.dist / "data" / "manifest.json").write_text(json.dumps(
            {"build_id": "b3", "database": {"file": "gamepulse.missing.sqlite.gz", "gzip_bytes": 2}}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "不存在"):
            publish_pages.commit_dist(self.dist, "gh-pages", repo=self.repo)


if __name__ == "__main__":
    unittest.main()
