-- v3 指标视图：所有页面与自助查询都从这里取数，口径只在这里定义一次。
-- 每次连接数据库时重建（DROP + CREATE），视图随代码走，不走迁移。
--
-- "今天"一律指 UTC+8 业务日：date('now', '+8 hours')。在浏览器里执行时就是看的人当天的日期，
-- 所以"最新版本开放到今天""数据是否过期"会随时间自然变化，不需要重新发布。

DROP VIEW IF EXISTS v_source_status;
DROP VIEW IF EXISTS v_official_news;
DROP VIEW IF EXISTS v_steamcharts_monthly;
DROP VIEW IF EXISTS v_video_latest;
DROP VIEW IF EXISTS v_video_obs;
DROP VIEW IF EXISTS v_video;
DROP VIEW IF EXISTS v_steam_daily;
DROP VIEW IF EXISTS v_online;
DROP VIEW IF EXISTS v_review_daily;
DROP VIEW IF EXISTS v_review;
DROP VIEW IF EXISTS v_review_base;
DROP VIEW IF EXISTS v_version_window;

-- 版本窗口：本次 Steam 开放日 → 下个已开放版本前一天；最新版本开放到今天
CREATE VIEW v_version_window AS
WITH released AS (
  SELECT game_id, version_id, start_date,
         LEAD(start_date) OVER w AS next_start,
         LEAD(version_id) OVER w AS next_version,
         LAG(version_id)  OVER w AS prev_version,
         ROW_NUMBER()     OVER w AS seq
  FROM version
  WHERE status = 'released'
  WINDOW w AS (PARTITION BY game_id ORDER BY start_date)
)
SELECT game_id, version_id, seq, prev_version, next_version, start_date,
       COALESCE(date(next_start, '-1 day'), date('now', '+8 hours')) AS end_date,
       next_start IS NULL AS is_open,
       CAST(julianday(COALESCE(date(next_start, '-1 day'), date('now', '+8 hours')))
            - julianday(start_date) AS INTEGER) + 1 AS days
FROM released;

-- 评测 × 版本：评测落在哪个版本窗口、更新后第几天。这是评测类查询里唯一耗时的部分（区间连接），
-- 发布时存成按"游戏 + 日期"聚簇的表（见 store/export.py），上层的 v_review 只做简单换算。
CREATE VIEW v_review_base AS
SELECT r.review_id, r.game_id, r.created_date, r.voted_up, r.language, r.playtime_at_review,
       -- 评测后又玩了多久：距最后一次见到这条评测不满 14 天的，结果还不稳定，不参与计算
       CASE WHEN r.playtime_forever IS NULL OR r.playtime_at_review IS NULL
              OR julianday(date(r.last_seen_at, '+8 hours')) - julianday(r.created_date) < 14 THEN NULL
            ELSE MAX(r.playtime_forever - r.playtime_at_review, 0) END AS post_review_minutes,
       w.version_id,
       CAST(julianday(r.created_date) - julianday(w.start_date) AS INTEGER) AS day_index,
       CAST(julianday(r.created_date) - julianday(g.steam_release) AS INTEGER) AS game_day_index
FROM review r
JOIN game g USING (game_id)
LEFT JOIN v_version_window w
  ON w.game_id = r.game_id AND r.created_date BETWEEN w.start_date AND w.end_date;

-- 一条评测一行，附所属版本、更新后第几天、上线后第几天、自然周、时长段
CREATE VIEW v_review AS
SELECT b.*,
       date(b.created_date, '-' || ((CAST(strftime('%w', b.created_date) AS INTEGER) + 6) % 7) || ' days') AS week_start,
       b.day_index / 7 AS version_week,
       CASE WHEN b.playtime_at_review IS NULL THEN NULL
            WHEN b.playtime_at_review < 120  THEN '0-2h'
            WHEN b.playtime_at_review < 1200 THEN '2-20h'
            WHEN b.playtime_at_review < 6000 THEN '20-100h'
            ELSE '100h+' END AS playtime_band,
       b.playtime_at_review / 60.0 AS playtime_hours
FROM v_review_base b;

-- 每游戏每天的评测数。覆盖范围内没有评测的日子记 0（这是真实的 0，不是缺失）；
-- 最后一次回填当天只采到运行时刻为止，标 complete_day = 0
CREATE VIEW v_review_daily AS
WITH RECURSIVE
  bounds AS (
    SELECT r.game_id, MIN(r.created_date) AS first_date,
           CASE WHEN EXISTS (SELECT 1 FROM review_window_run wr WHERE wr.game_id = r.game_id)
                THEN (SELECT MAX(covered_through) FROM review_run rr WHERE rr.game_id = r.game_id)
                ELSE MAX(MAX(r.created_date), COALESCE(
                  (SELECT MAX(covered_through) FROM review_run rr WHERE rr.game_id = r.game_id), '')) END AS last_date
    FROM review r
    WHERE NOT EXISTS (SELECT 1 FROM review_window_run wr WHERE wr.game_id = r.game_id)
       OR EXISTS (SELECT 1 FROM review_run rr WHERE rr.game_id = r.game_id)
    GROUP BY r.game_id
    UNION
    SELECT game_id, cutoff, covered_through FROM review_window_run
  ),
  calendar (game_id, date, last_date) AS (
    SELECT game_id, first_date, last_date FROM bounds
    UNION ALL
    SELECT game_id, date(date, '+1 day'), last_date FROM calendar WHERE date < last_date
  ),
  counts AS (
    SELECT game_id, created_date AS date, COUNT(*) AS reviews,
           SUM(voted_up = 1) AS positive, SUM(voted_up = 0) AS negative
    FROM review GROUP BY game_id, created_date
  ),
  days AS (
    SELECT game_id, date, MAX(date < last_date) AS complete_day
    FROM calendar GROUP BY game_id, date
  )
SELECT c.game_id, c.date,
       COALESCE(n.reviews, 0) AS reviews,
       COALESCE(n.positive, 0) AS positive,
       COALESCE(n.negative, 0) AS negative,
       c.complete_day,
       w.version_id,
       CAST(julianday(c.date) - julianday(w.start_date) AS INTEGER) AS day_index,
       CAST(julianday(c.date) - julianday(g.steam_release) AS INTEGER) AS game_day_index,
       date(c.date, '-' || ((CAST(strftime('%w', c.date) AS INTEGER) + 6) % 7) || ' days') AS week_start
FROM days c
JOIN game g USING (game_id)
LEFT JOIN counts n USING (game_id, date)
LEFT JOIN v_version_window w
  ON w.game_id = c.game_id AND c.date BETWEEN w.start_date AND w.end_date;

-- SteamDB 日均在线（唯一的可比在线口径）
CREATE VIEW v_online AS
SELECT o.game_id, o.date, o.avg_players,
       w.version_id,
       CAST(julianday(o.date) - julianday(w.start_date) AS INTEGER) AS day_index,
       CAST(julianday(o.date) - julianday(g.steam_release) AS INTEGER) AS game_day_index
FROM online_daily o
JOIN game g USING (game_id)
LEFT JOIN v_version_window w
  ON w.game_id = o.game_id AND o.date BETWEEN w.start_date AND w.end_date;

-- Steam 官方存量：全局累计好评率、总评测数与相邻两次采集之间的净变化
CREATE VIEW v_steam_daily AS
SELECT game_id, date, total_reviews, total_positive, review_score_desc,
       100.0 * total_positive / NULLIF(total_reviews, 0) AS cumulative_positive_rate,
       total_reviews - LAG(total_reviews) OVER w AS net_change,
       CAST(julianday(date) - julianday(LAG(date) OVER w) AS INTEGER) AS net_change_span_days
FROM steam_daily
WHERE total_reviews IS NOT NULL
WINDOW w AS (PARTITION BY game_id ORDER BY date);

CREATE VIEW v_official_news AS
SELECT game_id, date, category AS news_category, title, url, excerpt, date_basis, observed_at
FROM official_news;

CREATE VIEW v_steamcharts_monthly AS
SELECT game_id, month_start, avg_players, peak_players, observed_at, source_url FROM steamcharts_monthly;

-- 视频：已人工确认的版本优先；未确认的按发布日落在哪个版本窗口归属
CREATE VIEW v_video AS
SELECT v.platform, v.video_id, v.game_id, v.pair_id, v.pair_id IS NOT NULL AS curated,
       COALESCE(v.observed_title, v.title) AS title,
       COALESCE(v.observed_channel, v.channel_name) AS channel, v.locale,
       COALESCE(date(v.published_at, '+8 hours'), v.published_date) AS pub_date,
       v.content_type, v.character_name, v.identity_verified, v.registered,
       CASE WHEN v.version_confirmed = 1 THEN v.version_id ELSE w.version_id END AS version_id,
       CASE WHEN v.version_confirmed = 1 THEN 'confirmed'
            WHEN w.version_id IS NOT NULL THEN 'pub_date' END AS version_basis
FROM video v
LEFT JOIN v_version_window w
  ON w.game_id = v.game_id
 AND COALESCE(date(v.published_at, '+8 hours'), v.published_date) BETWEEN w.start_date AND w.end_date;

-- 视频每日观测：累计值、与上一次观测之差、发布后第几天。
-- 相邻两次观测跨了几天记在 span_days；跨多天的差值不能当作单日增量。
CREATE VIEW v_video_obs AS
WITH o AS (
  SELECT o.*,
         views - LAG(views) OVER w AS views_delta,
         likes - LAG(likes) OVER w AS likes_delta,
         comments - LAG(comments) OVER w AS comments_delta,
         CAST(julianday(date) - julianday(LAG(date) OVER w) AS INTEGER) AS span_days,
         ROW_NUMBER() OVER (PARTITION BY platform, video_id ORDER BY date DESC) = 1 AS is_latest
  FROM video_obs o
  WINDOW w AS (PARTITION BY platform, video_id ORDER BY date)
),
j AS (
  SELECT o.platform, o.video_id, o.date, o.views, o.likes, o.comments, o.coins, o.favorites, o.shares,
         o.danmaku, o.views_delta, o.likes_delta, o.comments_delta, o.span_days, o.is_latest,
         v.game_id, v.pair_id, v.curated, v.title, v.channel, v.locale, v.pub_date, v.content_type,
         v.character_name, v.version_id, v.version_basis,
         CAST(julianday(o.date) - julianday(v.pub_date) AS INTEGER) AS days_since_pub
  FROM o JOIN v_video v USING (platform, video_id)
)
SELECT j.*,
       -- 首次采到时视频已发布几天：大于 1 说明缺少发布初期（起跑段）的数据
       MIN(days_since_pub) OVER (PARTITION BY platform, video_id) AS first_obs_age
FROM j;

CREATE VIEW v_video_latest AS
SELECT * FROM v_video_obs WHERE is_latest;

-- 每个来源的状态：最近一次尝试、有效数据截至哪天、是否过期
CREATE VIEW v_source_status AS
WITH sources (source, label, attempt_sources, stale_days) AS (
  VALUES ('steam',       'Steam 官方汇总', ',steam,',                               2),
         ('reviews',     'Steam 评测明细', ',reviews_incremental,reviews_full,reviews_window,', 2),
         ('steamdb',     'SteamDB 在线',   ',steamdb,',                             8),
         ('steam_build', 'Steam 构建号',   ',steam_build,',                         2),
         ('bilibili',    'B 站视频',       ',bilibili,',                            2),
         ('youtube',     'YouTube 视频',   ',youtube,',                             2),
         ('official_news', '国服官网公告观测', ',official_news,',                    2),
         ('steamcharts', 'SteamCharts 月均在线观测', ',steamcharts,',                8)
),
through AS (
  SELECT g.game_id, s.source, s.label, s.attempt_sources, s.stale_days,
         CASE s.source
           WHEN 'steam'       THEN (SELECT MAX(date) FROM steam_daily x WHERE x.game_id = g.game_id)
           WHEN 'reviews'     THEN (SELECT MAX(day) FROM (
             SELECT covered_through AS day FROM review_run x WHERE x.game_id = g.game_id
             UNION ALL SELECT covered_through FROM review_window_run x WHERE x.game_id = g.game_id))
           WHEN 'steamdb'     THEN (SELECT MAX(date) FROM online_daily x WHERE x.game_id = g.game_id)
           WHEN 'steam_build' THEN (SELECT MAX(date) FROM steam_build x WHERE x.game_id = g.game_id)
           -- 公告的有效观测日与发布日期不同；没有新文章也可以是成功观测。
           WHEN 'official_news' THEN (SELECT MAX(date) FROM collection_attempt x WHERE x.game_id = g.game_id
                                     AND x.source = 'official_news' AND x.succeeded > 0)
           WHEN 'steamcharts' THEN (SELECT MAX(date) FROM collection_attempt x WHERE x.game_id = g.game_id
                                   AND x.source = 'steamcharts' AND x.succeeded > 0)
           ELSE (SELECT MAX(o.date) FROM video_obs o JOIN video v USING (platform, video_id)
                 WHERE v.game_id = g.game_id AND o.platform = s.source)
         END AS data_through
  FROM game g CROSS JOIN sources s
  WHERE g.active = 1
    AND (s.source <> 'official_news' OR EXISTS (
      SELECT 1 FROM collection_attempt a WHERE a.game_id = g.game_id AND a.source = 'official_news' AND a.expected > 0
    ))
    AND (s.source <> 'steamcharts' OR EXISTS (
      SELECT 1 FROM collection_attempt a WHERE a.game_id = g.game_id AND a.source = 'steamcharts' AND a.expected > 0
    ))
),
latest AS (
  SELECT a.game_id, t.source, a.status, a.attempted_at, a.expected, a.succeeded, a.detail,
         ROW_NUMBER() OVER (PARTITION BY a.game_id, t.source ORDER BY a.attempted_at DESC, a.attempt_id DESC) AS rn
  FROM collection_attempt a
  JOIN through t ON t.game_id = a.game_id AND instr(t.attempt_sources, ',' || a.source || ',') > 0
),
success AS (
  SELECT a.game_id, t.source, MAX(a.attempted_at) AS last_success_at
  FROM collection_attempt a
  JOIN through t ON t.game_id = a.game_id AND instr(t.attempt_sources, ',' || a.source || ',') > 0
  WHERE a.status = 'success'
  GROUP BY a.game_id, t.source
)
SELECT t.game_id, t.source, t.label, t.data_through, t.stale_days,
       CAST(julianday(date('now', '+8 hours')) - julianday(t.data_through) AS INTEGER) AS age_days,
       l.status AS last_attempt_status, l.attempted_at AS last_attempt_at,
       l.expected, l.succeeded, l.detail, s.last_success_at,
       -- 有意未配置（例如没有 YouTube Key）、或者这款游戏没有要采的内容，都不算异常
       CASE WHEN l.status = 'disabled' THEN 'disabled'
            WHEN l.status = 'skipped' AND t.data_through IS NULL THEN 'skipped'
            WHEN t.data_through IS NULL THEN 'missing'
            WHEN l.status IN ('failed', 'partial') THEN l.status
            WHEN julianday(date('now', '+8 hours')) - julianday(t.data_through) >= t.stale_days THEN 'stale'
            ELSE 'healthy' END AS status
FROM through t
LEFT JOIN latest l ON l.game_id = t.game_id AND l.source = t.source AND l.rn = 1
LEFT JOIN success s ON s.game_id = t.game_id AND s.source = t.source;
