"""Run the maintained offline fault regressions for the backend audit.

The original pre-fix observations remain in
 docs/backend-code-review-repros-2026-09-29.json.
This command uses temporary directories and mocked HTTP, and exits nonzero on failure.
"""
from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    raise SystemExit(subprocess.run([
        sys.executable, "-m", "unittest", "discover", "-s", "tests",
        "-p", "test_backend_reliability.py", "-v",
    ], cwd=Path(__file__).resolve().parents[1]).returncode)
