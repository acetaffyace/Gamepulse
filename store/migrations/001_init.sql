-- v3 初始表结构。设计见 docs/v3-data-layer.md 第 4 节。
--
-- 约定：日期列为 UTC+8 业务日 'YYYY-MM-DD'；*_at 列为 UTC ISO 时间戳。
-- 拿不到的值存 NULL，不存 0；计数列不允许为负。

-- ── 维度表：由 config/*.yml 同步 ─────────────────────────────────

CREATE TABLE game (
  game_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  short_name    TEXT,
  developer     TEXT,
  steam_app_id  INTEGER NOT NULL UNIQUE,
  steam_release TEXT CHECK (steam_release IS NULL OR steam_release GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  color         TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- 版本窗口不存：由视图从开放日推出。本表没有外键引用，同步时整表替换。
CREATE TABLE version (
  game_id       TEXT NOT NULL REFERENCES game,
  version_id    TEXT NOT NULL,
  start_date    TEXT CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),  -- Steam 端开放日
  start_at      TEXT,                       -- 有精确开放时刻时填写
  cn_start_date TEXT,                       -- 国服与 Steam 不同日时填写
  status        TEXT NOT NULL CHECK (status IN ('released', 'scheduled')),
  source        TEXT,
  source_url    TEXT,
  cn_source_url TEXT,
  note          TEXT,
  PRIMARY KEY (game_id, version_id),
  CHECK (status = 'scheduled' OR start_date IS NOT NULL)   -- 已开放的版本必须有 Steam 开放日
) WITHOUT ROWID;

-- 同一内容在 B 站与 YouTube 各语区的一组视频（config/video_pairs.yml）
CREATE TABLE video_pair (
  pair_id           TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES game,
  content_type      TEXT NOT NULL,
  version_id        TEXT,
  version_confirmed INTEGER CHECK (version_confirmed IN (0, 1)),
  character_id      TEXT,
  character_name    TEXT,
  published_date    TEXT
) WITHOUT ROWID;

-- 视频被观测数据引用，同步时只增改、不删除；登记表移除的视频标 registered = 0
CREATE TABLE video (
  platform          TEXT NOT NULL CHECK (platform IN ('bilibili', 'youtube')),
  video_id          TEXT NOT NULL,
  game_id           TEXT NOT NULL REFERENCES game,
  pair_id           TEXT REFERENCES video_pair,
  title             TEXT,
  channel_id        TEXT,
  channel_name      TEXT,
  locale            TEXT,                   -- 频道语区，不是观众所在地区
  published_date    TEXT,
  content_type      TEXT,
  version_id        TEXT,
  version_confirmed INTEGER CHECK (version_confirmed IN (0, 1)),
  character_id      TEXT,
  character_name    TEXT,
  identity_verified INTEGER CHECK (identity_verified IN (0, 1)),
  registered        INTEGER NOT NULL DEFAULT 1 CHECK (registered IN (0, 1)),
  -- 以下由采集器根据接口返回填写，登记表同步不覆盖
  observed_title    TEXT,
  observed_channel  TEXT,
  published_at      TEXT,                   -- 接口给出的精确发布时刻（UTC）
  PRIMARY KEY (platform, video_id)
) WITHOUT ROWID;

-- ── 事实表：采集器写入 ───────────────────────────────────────────

-- 一条 Steam 评测一行。每周全量回填在一个事务里替换某游戏的整个集合（存续评测口径）
CREATE TABLE review (
  review_id          INTEGER PRIMARY KEY,   -- Steam recommendationid
  game_id            TEXT NOT NULL REFERENCES game,
  created_at         INTEGER NOT NULL,      -- Unix 秒
  created_date       TEXT NOT NULL CHECK (created_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  voted_up           INTEGER CHECK (voted_up IN (0, 1)),   -- NULL = 未知，不能当作差评
  language           TEXT,
  playtime_at_review INTEGER CHECK (playtime_at_review >= 0),   -- 分钟
  playtime_forever   INTEGER CHECK (playtime_forever >= 0),
  steam_purchase     INTEGER CHECK (steam_purchase IN (0, 1)),
  received_for_free  INTEGER CHECK (received_for_free IN (0, 1)),
  last_seen_at       TEXT NOT NULL          -- 最后一次在回填中见到它；算"评测后又玩了多久"
);
CREATE INDEX review_game_date ON review (game_id, created_date);

-- 每次评测回填运行：覆盖范围（每日评测补 0 的截止日）从这里取
CREATE TABLE review_run (
  run_id         INTEGER PRIMARY KEY,
  game_id        TEXT NOT NULL REFERENCES game,
  mode           TEXT NOT NULL CHECK (mode IN ('full', 'incremental')),
  finished_at    TEXT NOT NULL,
  covered_through TEXT NOT NULL,            -- 本次运行后评测覆盖到的业务日
  cutoff         TEXT,                      -- 增量模式：从哪天开始重新拉取
  pages          INTEGER,
  fetched        INTEGER,
  total_expected INTEGER,
  stop_reason    TEXT
);
CREATE INDEX review_run_game ON review_run (game_id, finished_at);

-- SteamDB 日汇总：在线人数唯一的可比口径
CREATE TABLE online_daily (
  game_id      TEXT NOT NULL REFERENCES game,
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  avg_players   INTEGER CHECK (avg_players >= 0),     -- 全天平均同时在线
  point_players INTEGER CHECK (point_players >= 0),   -- 日汇总行的 Players：某一时点的值，不是峰值（有的日子低于日均）
  source_file  TEXT,
  imported_at  TEXT NOT NULL,
  PRIMARY KEY (game_id, date)
) WITHOUT ROWID;

-- v2 的小时级 Steam 在线采样（v3 已停采，只保留历史，看板不展示）
CREATE TABLE online_hourly (
  game_id    TEXT NOT NULL REFERENCES game,
  date       TEXT NOT NULL,
  hour       INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  players    INTEGER CHECK (players >= 0),
  sampled_at TEXT NOT NULL,
  PRIMARY KEY (game_id, date, hour)
) WITHOUT ROWID;

-- Steam 官方每日汇总（存量）。current_players 为采集时刻的瞬时值，只作参考
CREATE TABLE steam_daily (
  game_id           TEXT NOT NULL REFERENCES game,
  date              TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  total_reviews     INTEGER CHECK (total_reviews >= 0),
  total_positive    INTEGER CHECK (total_positive >= 0),
  review_score_desc TEXT,
  current_players   INTEGER CHECK (current_players >= 0),
  observed_at       TEXT NOT NULL,
  PRIMARY KEY (game_id, date)
) WITHOUT ROWID;

-- 视频累计计数的每日观测；平台不提供或被隐藏的计数保持 NULL
CREATE TABLE video_obs (
  platform    TEXT NOT NULL,
  video_id    TEXT NOT NULL,
  date        TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  views       INTEGER CHECK (views >= 0),
  likes       INTEGER CHECK (likes >= 0),
  comments    INTEGER CHECK (comments >= 0),
  coins       INTEGER CHECK (coins >= 0),
  favorites   INTEGER CHECK (favorites >= 0),
  shares      INTEGER CHECK (shares >= 0),
  danmaku     INTEGER CHECK (danmaku >= 0),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (platform, video_id, date),
  FOREIGN KEY (platform, video_id) REFERENCES video
) WITHOUT ROWID;

CREATE TABLE steam_news (
  game_id      TEXT NOT NULL REFERENCES game,
  gid          TEXT NOT NULL,
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  published_at INTEGER,                     -- Unix 秒
  title        TEXT,
  url          TEXT,
  feed_label   TEXT,
  feed_name    TEXT,
  is_official  INTEGER CHECK (is_official IN (0, 1)),
  observed_at  TEXT NOT NULL,
  PRIMARY KEY (game_id, gid)
) WITHOUT ROWID;

CREATE TABLE steam_build (
  game_id            TEXT NOT NULL REFERENCES game,
  date               TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  buildid            TEXT,
  build_updated_at   TEXT,
  build_updated_date TEXT,
  observed_at        TEXT NOT NULL,
  PRIMARY KEY (game_id, date)
) WITHOUT ROWID;

-- ── 派生表：每次构建重新生成 ─────────────────────────────────────

CREATE TABLE event (
  event_id            INTEGER PRIMARY KEY,
  game_id             TEXT NOT NULL REFERENCES game,
  date                TEXT NOT NULL,
  type                TEXT NOT NULL,        -- version_update | version_preview | build_update | content …
  version_id          TEXT,
  label               TEXT,
  evidence            TEXT,                 -- 证据来源：版本表 / 公告 / 构建号 / 视频登记
  source_url          TEXT,
  is_version_boundary INTEGER NOT NULL DEFAULT 0 CHECK (is_version_boundary IN (0, 1))
);
CREATE INDEX event_game_date ON event (game_id, date);

CREATE TABLE quality_issue (
  issue_id INTEGER PRIMARY KEY,
  game_id  TEXT REFERENCES game,            -- NULL = 全局问题
  level    TEXT NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  code     TEXT NOT NULL,
  message  TEXT NOT NULL,
  detail   TEXT                             -- JSON
);

-- ── 运行记录 ─────────────────────────────────────────────────────

-- 采集失败只写这里，不碰事实表
CREATE TABLE collection_attempt (
  attempt_id   INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  game_id      TEXT REFERENCES game,
  date         TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'skipped', 'disabled')),
  expected     INTEGER CHECK (expected >= 0),
  succeeded    INTEGER CHECK (succeeded >= 0),
  detail       TEXT
);
CREATE INDEX collection_attempt_source ON collection_attempt (source, game_id, attempted_at);

CREATE TABLE build_meta (
  build_id       TEXT PRIMARY KEY,
  generated_at   TEXT NOT NULL,
  schema_version INTEGER NOT NULL
) WITHOUT ROWID;

-- 每张事实表的来源类别；同一张表的来源类别相同，所以按表登记
CREATE TABLE fact_source (
  fact_table  TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('observed', 'reconstructed', 'third_party', 'manual')),
  label       TEXT NOT NULL,
  note        TEXT
) WITHOUT ROWID;

INSERT INTO fact_source VALUES
  ('review',       'reconstructed', 'Steam 评测回填',   '按创建日统计仍存续的评测；删评和改评在每周全量时更新'),
  ('online_daily', 'third_party',   'SteamDB 日汇总',   '手动导出的 SteamDB Charts CSV'),
  ('steam_daily',  'observed',      'Steam 官方汇总',   '每日采集时刻的存量；current_players 是瞬时值'),
  ('video_obs',    'observed',      'B 站 / YouTube',   '登记视频的累计计数，事后登记的视频缺少发布初期数据'),
  ('steam_news',   'observed',      'Steam 公告',       NULL),
  ('steam_build',  'third_party',   'steamcmd.net',     '构建号与构建更新时间'),
  ('online_hourly','observed',      'Steam 小时在线',   'v2 历史，仅保留不展示');
