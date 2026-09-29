"""Durable page checkpoints. Cursor advances only after the corresponding page is durable."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from collectors.common import now_iso, write_json


class ReviewCheckpoint:
    def __init__(self, path: Path | None, query: dict):
        self.path, self.query = path, query
        self.state = {}
        self.rows = []
        if path and path.exists():
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(state["created_at"])).total_seconds()
                if state.get("query") == query and 0 <= age < 48 * 3600 and not state.get("complete"):
                    self.rows = [row for filename in state["files"] for row in
                                 json.loads((path.parent / filename).read_text(encoding="utf-8"))]
                    self.state = state
            except (ValueError, KeyError, OSError, TypeError):
                self.rows, self.state = [], {}
        if not self.state:
            self.state = {"query": query, "created_at": now_iso(), "run": uuid.uuid4().hex,
                          "cursor": "*", "seen_cursors": [], "files": [], "pages": 0,
                          "total_expected": None}

    def commit(self, rows: list[dict], cursor: str, seen: set[str], pages: int, expected) -> None:
        if not self.path:
            return
        filename = f"{self.state['run']}/page-{pages:06d}.json"
        write_json(self.path.parent / filename, rows)
        self.state = {**self.state, "cursor": cursor, "seen_cursors": sorted(seen),
                      "pages": pages, "total_expected": expected,
                      "files": self.state["files"] + [filename], "updated_at": now_iso()}
        write_json(self.path, self.state)

    @staticmethod
    def finish(path: Path) -> None:
        if path.exists():
            state = json.loads(path.read_text(encoding="utf-8"))
            write_json(path, {**state, "complete": True})
