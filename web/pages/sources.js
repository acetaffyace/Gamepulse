// 数据来源：每个来源最近一次尝试、有效数据截至哪天、是否过期，以及质量提示与口径说明。
// 状态由视图在浏览器里按今天的日期计算，所以旧的发布包打开时也会如实显示"已过期"。

import { el, tableCard } from '../lib/ui.js';
import { dimText, header } from './shared.js';

const STATUS_LABEL = { healthy: '正常', stale: '已过期', failed: '最近一次失败', partial: '部分成功', missing: '没有数据',
                       disabled: '未配置', success: '成功', skipped: '没有要采的' };
const LEVEL_LABEL = { error: '错误', warn: '注意', info: '说明' };
const SOURCE_LABEL = { steam: 'Steam 官方汇总', steam_build: 'Steam 构建号', bilibili: 'B 站视频', youtube: 'YouTube 视频',
                       steamdb: 'SteamDB 导入', reviews_full: '评测全量回填', reviews_incremental: '评测增量回填',
                       steam_online: 'Steam 小时在线（v2，已停用）' };
const KIND_LABEL = { observed: '直接采集', reconstructed: '回填重建', third_party: '第三方', manual: '人工登记' };

const status = value => el('span', { class: `status ${value || ''}` }, STATUS_LABEL[value] || value || '—');
const time = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—');

export function render({ store, root }) {
  const game = id => (id ? dimText(store, 'game_id', id) : '全部');
  root.append(...header('数据来源', '每个来源的采集状态、有效数据截至哪天，以及口径说明。时间为北京时间。'));

  const rows = store.rows('SELECT * FROM v_source_status ORDER BY game_id, source');
  root.append(tableCard({ title: '来源状态', sub: '"有效数据截至"是最后一天有成功数据的日期；最近一次失败不会抹掉之前的数据',
    filename: 'source-status',
    caveat: 'SteamDB 没有可用的自动接口，需要手动导出后放进收件箱导入，超过 8 天未更新标为过期；其他来源超过 2 天标为过期。',
    columns: [{ key: 'game_id', label: '游戏', format: game }, { key: 'label', label: '来源' },
              { key: 'status', label: '状态', format: status, csv: v => STATUS_LABEL[v] || v },
              { key: 'data_through', label: '有效数据截至' }, { key: 'age_days', label: '距今天数', num: true },
              { key: 'last_attempt_at', label: '最近一次尝试', format: time },
              { key: 'last_attempt_status', label: '尝试结果', format: v => STATUS_LABEL[v] || v || '—' },
              { key: 'succeeded', label: '成功 / 期望', num: true, format: (v, r) => (r.expected ? `${v ?? 0} / ${r.expected}` : '—') },
              { key: 'detail', label: '失败原因', format: v => v || '' }],
    rows }));

  const issues = store.rows("SELECT game_id, level, code, message FROM quality_issue ORDER BY CASE level WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, game_id");
  root.append(tableCard({ title: '数据质量提示', sub: '构建时自动检查：缺采、数值倒退、版本表与公告不一致等', filename: 'quality-issues',
    columns: [{ key: 'game_id', label: '游戏', format: game }, { key: 'level', label: '级别', format: v => LEVEL_LABEL[v] || v },
              { key: 'message', label: '说明' }],
    rows: issues }));

  const kinds = store.rows('SELECT fact_table, source_kind, label, note FROM fact_source ORDER BY fact_table');
  root.append(tableCard({ title: '数据是怎么来的', sub: '每张数据表的来源类别', filename: 'fact-sources',
    columns: [{ key: 'label', label: '来源' }, { key: 'source_kind', label: '类别', format: v => KIND_LABEL[v] || v },
              { key: 'note', label: '说明', format: v => v || '' }, { key: 'fact_table', label: '数据表' }],
    rows: kinds }));

  root.append(el('section', { class: 'card' }, el('h2', {}, '读数时的边界'),
    el('ul', {},
      el('li', {}, 'Steam 同时在线只是 Steam 平台某一时段的人数，不代表全平台玩家数，也不是 DAU。'),
      el('li', {}, '评测数按创建日统计当前仍存在的评测，删除的评测不计入；好评率与 Steam 商店显示的累计好评率口径不同。'),
      el('li', {}, '评测者不是全部玩家的随机样本；评测语种是写评测时选择的语言，不等于玩家所在地区。'),
      el('li', {}, '视频播放是累计观看次数。B 站和 YouTube 的受众与统计口径不同，不合成一个"综合热度"；同一内容的各语区版本不相加。'),
      el('li', {}, '多数视频是发布后才登记采集的，缺少发布初期的数据，不从累计值倒推。'),
      el('li', {}, '缺失的数据保持为空，不当作 0；时间轴上的事件只标记时间，不推断因果。'))));

  const attempts = store.rows('SELECT attempted_at, source, game_id, status, expected, succeeded, detail FROM collection_attempt '
    + 'ORDER BY attempted_at DESC, attempt_id DESC LIMIT 60');
  root.append(tableCard({ title: '最近的采集记录', sub: '最近 60 次', filename: 'collection-attempts',
    columns: [{ key: 'attempted_at', label: '时间', format: time },
              { key: 'source', label: '来源', format: v => SOURCE_LABEL[v] || v },
              { key: 'game_id', label: '游戏', format: game },
              { key: 'status', label: '结果', format: v => STATUS_LABEL[v] || v },
              { key: 'succeeded', label: '成功 / 期望', num: true, format: (v, r) => (r.expected ? `${v ?? 0} / ${r.expected}` : '—') },
              { key: 'detail', label: '说明', format: v => v || '' }],
    rows: attempts }));
}
