-- SteamCharts 自然月汇总独立保存，不能冒充 SteamDB 逐日平均在线。
CREATE TABLE steamcharts_monthly (
  game_id TEXT NOT NULL REFERENCES game,
  month_start TEXT NOT NULL,
  avg_players REAL NOT NULL CHECK (avg_players >= 0),
  peak_players INTEGER NOT NULL CHECK (peak_players >= 0),
  observed_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY (game_id, month_start)
) WITHOUT ROWID;
INSERT INTO fact_source VALUES (
  'steamcharts_monthly', 'third_party', 'SteamCharts 月均在线',
  '来源自然月汇总，排除 Last 30 Days 滚动窗口；仅 Steam 平台，不是 DAU，不与 SteamDB 逐日在线拼接'
);
