-- 官网新闻独立于 Steam 公告；date 为发布日，不是更新生效日。
CREATE TABLE official_news (
  game_id TEXT NOT NULL REFERENCES game,
  url TEXT NOT NULL,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  date_basis TEXT NOT NULL,
  excerpt TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (game_id, url)
) WITHOUT ROWID;
CREATE INDEX official_news_game_date ON official_news (game_id, date);
INSERT INTO fact_source VALUES (
  'official_news', 'observed', '国服官网公告',
  '端游官网有限列表页；日期为页面发布日期，分类为标题关键词提示；不代表活动效果或玩家规模'
);
