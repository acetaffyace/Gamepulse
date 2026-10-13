// 玩家结构：写评测的人是什么样的——写评测时玩了多久、用什么语言、评测后还玩不玩。
// 这些只描述"写评测的人"，不是全部玩家的随机样本。

import { formatValue } from '../lib/format.js';
import { ordinal, otherColor, slot } from '../lib/palette.js';
import { chartCard, chips, disclosure, el, segmented } from '../lib/ui.js';
import { availableDays, currentGame, dimText, f, gameColor, gameSelect, header, metricText, scopeLine, sortedVersions } from './shared.js';

const TOP_LANGUAGES = 5;

export function render({ store, root, params, set }) {
  const game = currentGame(store, params);
  const anchor = store.reviewAnchor(game);
  const versions = sortedVersions(store, game).filter(v => availableDays(v, anchor) > 0);
  const recentOptions = [{ value: 6, label: '最近 6 个' }, { value: 12, label: '最近 12 个' }, { value: 'all', label: '全部' }];
  const count = recentOptions.some(o => String(o.value) === params.get('versions'))
    ? (params.get('versions') === 'all' ? 'all' : Number(params.get('versions'))) : 6;
  const candidates = count === 'all' ? versions : versions.slice(-count);
  const picked = (params.get('player_versions') || '').split(',').filter(v => candidates.some(c => c.version_id === v));
  const shown = picked.length ? candidates.filter(v => picked.includes(v.version_id)) : candidates;
  const ids = shown.map(v => v.version_id);
  const stage = ['14', '30'].includes(params.get('stage')) ? params.get('stage') : 'window';
  const effectiveDays = stage === 'window' || !shown.length ? null : Math.min(Number(stage), ...shown.map(v => availableDays(v, anchor)));

  root.append(...header('玩家结构', '比较评测者的时长分布、语言与后续游玩。可按完整窗口或相同阶段查看。'));
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    segmented('版本', recentOptions, count, v => set({ versions: v, player_versions: null })),
    segmented('统计阶段', [{ value: 'window', label: '完整窗口' }, { value: '14', label: '共同前 14 天' }, { value: '30', label: '共同前 30 天' }],
      stage, v => set({ stage: v }))));
  if (!ids.length) {
    root.append(el('div', { class: 'empty' }, '这款游戏还没有已开放的版本。'));
    return;
  }
  root.append(disclosure('选择要看的版本', chips('版本对象', candidates.map(v => ({ value: v.version_id, label: v.version_id })), ids,
    selected => set({ player_versions: selected.length === candidates.length ? null : selected }))));
  root.append(scopeLine(stage === 'window' ? `各版本完整窗口（${ids.join('、')}），统计截至 ${anchor}`
    : `所有选中版本统一按 D0–D${effectiveDays-1}（共 ${effectiveDays} 天）统计`,
    '仅描述写评测的人', stage === 'window' ? '进行中版本的窗口短于历史版本，不能直接当作同阶段比较' : null));

  const scope = [f.eq('game_id', game), f.in('version_id', ids), { dim: 'created_date', op: 'lte', value: anchor },
    ...(effectiveDays ? [f.between('day_index', 0, effectiveDays-1)] : [])];
  const samples = ids => ids.filter(id => store.catalog.metrics[id]);
  const label = v => v;
  const bands = store.catalog.dimensions.playtime_band.order;
  const bandRows = store.query({ metrics: ['review_share', 'review_count'], dims: ['version_id', 'playtime_band'],
    filters: [...scope, { dim: 'playtime_band', op: 'notnull' }], shareDim: 'playtime_band' }).rows;
  const bandValue = (v, band) => bandRows.find(r => r.version_id === v && r.playtime_band === band)?.review_share ?? 0;

  const medianRows = store.query({ metrics: ['playtime_median_h', 'playtime_p25_h', 'playtime_p75_h', 'review_count', 'positive_rate',
    ...samples(['playtime_sample_count', 'rated_count'])],
    dims: ['version_id'], filters: scope }).rows;
  const byVersion = Object.fromEntries(medianRows.map(r => [r.version_id, r]));
  const color = gameColor(store, game);

  const grid = el('div', { class: 'grid-2' },
    chartCard({ title: '时长构成', sub: '各版本窗口内的评测，按写评测时已玩的时长分段', filename: `${game}-playtime-bands`,
      chart: { type: 'stacked100', x: ids.map(label),
               series: bands.map(band => ({ name: dimText(store, 'playtime_band', band), color: ordinal(bands, band),
                                            data: ids.map(v => bandValue(v, band)) })),
               format: v => metricText(store, 'review_share', v), axisFormat: v => `${v}%` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'playtime_band', label: '时长段', format: v => dimText(store, 'playtime_band', v) },
                { key: 'review_count', label: '评测数', num: true },
                { key: 'review_share', label: '占比', num: true, format: v => metricText(store, 'review_share', v) }],
      rows: bandRows }),
    chartCard({ title: '时长分布', sub: '圆点为中位数，线段为 P25–P75 区间；不补最小值或最大值', filename: `${game}-playtime-median`,
      empty: medianRows.some(r => r.playtime_median_h != null) ? null : '当前范围没有有效时长样本，无法计算分位数',
      chart: { type: 'interval', x: ids.map(label), valueIndex: 2, yMin: 0,
        series: [{ name: 'P25–P75 与中位数', color, data: ids.map((v, i) => [i, byVersion[v]?.playtime_p25_h ?? null,
          byVersion[v]?.playtime_median_h ?? null, byVersion[v]?.playtime_p75_h ?? null]) }],
               format: v => `${formatValue(v, 'decimal1')} 小时`, axisFormat: v => `${v} h`,
               tooltipExtra: i => `P25 ${formatValue(byVersion[ids[i]]?.playtime_p25_h, 'decimal1')} / P75 ${formatValue(byVersion[ids[i]]?.playtime_p75_h, 'decimal1')} 小时\n有效时长样本 ${formatValue(byVersion[ids[i]]?.playtime_sample_count, 'integer')} 条（评测总数 ${formatValue(byVersion[ids[i]]?.review_count, 'integer')} 条）` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'review_count', label: '评测数', num: true },
                { key: 'playtime_sample_count', label: '有效时长样本', num: true },
                ...['playtime_p25_h', 'playtime_median_h', 'playtime_p75_h'].map(id => ({ key: id, label: store.catalog.metrics[id].label,
                  num: true, format: v => metricText(store, id, v) }))],
      rows: medianRows }),
  );
  root.append(grid);

  // 语种：前几种按这款游戏全部评测的排名选出，颜色也按这个排名固定——换显示多少个版本，语种不会换颜色
  const langRows = store.query({ metrics: ['review_share', 'review_count'], dims: ['version_id', 'language'],
    filters: scope, shareDim: 'language' }).rows;
  const top = store.query({ metrics: ['review_count'], dims: ['language'], filters: [f.eq('game_id', game)],
    order: [{ key: 'review_count', desc: true }], limit: TOP_LANGUAGES }).rows.map(r => r.language);
  const langShare = (v, lang) => langRows.find(r => r.version_id === v && r.language === lang)?.review_share ?? 0;
  const langSeries = top.map((lang, i) => ({ name: dimText(store, 'language', lang), color: slot(i), data: ids.map(v => langShare(v, lang)) }));
  langSeries.push({ name: '其他', color: otherColor(), data: ids.map(v => Math.max(0, 100 - top.reduce((s, l) => s + langShare(v, l), 0))) });

  const bandRate = store.query({ metrics: ['positive_rate', 'review_count', ...samples(['rated_count'])], dims: ['version_id', 'playtime_band'],
    filters: [...scope, { dim: 'playtime_band', op: 'notnull' }] }).rows;
  const rateValue = (v, band) => bandRate.find(r => r.version_id === v && r.playtime_band === band)?.positive_rate ?? null;
  const grid2 = el('div', { class: 'grid-2' },
    chartCard({ title: '语种构成', sub: `这款游戏评测最多的 ${TOP_LANGUAGES} 种语言，其余合并为"其他"`,
      caveat: '语种是写评测时选择的语言，不等于玩家所在地区。', filename: `${game}-languages`,
      chart: { type: 'stacked100', x: ids.map(label), series: langSeries, format: v => metricText(store, 'review_share', v), axisFormat: v => `${v}%` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'language', label: '语种', format: v => dimText(store, 'language', v) },
                { key: 'review_count', label: '评测数', num: true },
                { key: 'review_share', label: '占比', num: true, format: v => metricText(store, 'review_share', v) }],
      rows: langRows }),
    chartCard({ title: '分组好评率', tone: 'pink', sub: '同一版本里，玩得久的人和刚上手的人评价是否不同', filename: `${game}-rate-by-band`,
      chart: { type: 'bar', percent: true, x: ids.map(label), series: bands.map(band => ({ name: dimText(store, 'playtime_band', band),
               color: ordinal(bands, band), data: ids.map(v => rateValue(v, band)) })),
               format: v => metricText(store, 'positive_rate', v), axisFormat: v => `${v}%`,
               tooltipExtra: i => bands.map(band => `${dimText(store, 'playtime_band', band)}：评价已知 ${formatValue(bandRate.find(r => r.version_id === ids[i] && r.playtime_band === band)?.rated_count, 'integer')} 条`).join('\n') },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'playtime_band', label: '时长段', format: v => dimText(store, 'playtime_band', v) },
                { key: 'review_count', label: '评测数', num: true },
                { key: 'rated_count', label: '评价已知样本', num: true },
                { key: 'positive_rate', label: '好评率', num: true, format: v => metricText(store, 'positive_rate', v) }],
      rows: bandRate }),
  );
  root.append(grid2);

  const retention = store.query({ metrics: ['still_playing_share', 'post_review_median_h', ...samples(['post_review_sample_count'])], dims: ['version_id'], filters: scope }).rows;
  const retentionBy = Object.fromEntries(retention.map(r => [r.version_id, r]));
  root.append(chartCard({ title: '评测后游玩', sub: '合格样本中，评测后又玩了至少 60 分钟的比例',
    empty: retention.some(r => r.still_playing_share != null) ? null : '当前范围尚无满足满14天且时长有效的后续游玩样本',
    caveat: '合格样本须距最后回填已满 14 天且时长有效；各版本后续观察长度仍不同，不做留存排名。这不是留存率。',
    filename: `${game}-still-playing`,
    chart: { type: 'bar', percent: true, x: ids.map(label), series: [{ name: '仍在玩的比例', color, data: ids.map(v => retentionBy[v]?.still_playing_share ?? null) }],
             format: v => metricText(store, 'still_playing_share', v), axisFormat: v => `${v}%`,
             tooltipExtra: i => `合格后续游玩样本 ${formatValue(retentionBy[ids[i]]?.post_review_sample_count, 'integer')} 条` },
    columns: [{ key: 'version_id', label: '版本' },
              { key: 'post_review_sample_count', label: '合格后续游玩样本', num: true },
              { key: 'still_playing_share', label: '仍在玩的比例', num: true, format: v => metricText(store, 'still_playing_share', v) },
              { key: 'post_review_median_h', label: '评测后又玩的时长（中位数）', num: true, format: v => metricText(store, 'post_review_median_h', v) }],
    rows: retention }));
}
