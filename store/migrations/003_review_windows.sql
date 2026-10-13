-- 有界评测回填：到达 cutoff 才写入；不会冒充全历史回填。
CREATE TABLE review_window_run (
  run_id INTEGER PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES game,
  cutoff TEXT NOT NULL,
  covered_through TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  pages INTEGER NOT NULL,
  fetched INTEGER NOT NULL,
  stop_reason TEXT NOT NULL
);
CREATE INDEX review_window_game ON review_window_run (game_id, cutoff, covered_through);
