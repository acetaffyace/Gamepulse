// 玩家结构：写评测的人是什么样的——写评测时玩了多久、用什么语言、评测后还玩不玩。
// 这些只描述"写评测的人"，不是全部玩家的随机样本。

import { formatValue } from '../lib/format.js';
import { ordinal, otherColor, slot } from '../lib/palette.js';
import { chartCard, el, segmented } from '../lib/ui.js';
import { currentGame, dimText, f, gameColor, gameSelect, header, metricText, scopeLine, sortedVersions } from './shared.js';

const TOP_LANGUAGES = 5;

export function render({ store, root, params, set }) {
  const game = currentGame(store, params);
  const versions = sortedVersions(store, game);
  const recentOptions = [{ value: 6, label: '最近 6 个' }, { value: 12, label: '最近 12 个' }, { value: 'all', label: '全部' }];
  const count = params.get('versions') === 'all' ? 'all' : (Number(params.get('versions')) || 6);
  const shown = count === 'all' ? versions : versions.slice(-count);
  const ids = shown.map(v => v.version_id);

  root.append(...header('玩家结构', '写评测的人：写评测时玩了多久、用什么语言、评测后还在不在玩。按版本窗口统计。'));
  root.append(el('div', { class: 'filters' }, gameSelect(store, game, set),
    segmented('版本', recentOptions, count, v => set({ versions: v }))));
  if (!ids.length) {
    root.append(el('div', { class: 'empty' }, '这款游戏还没有已开放的版本。'));
    return;
  }
  root.append(scopeLine(`每个版本窗口内创建的评测（${ids[0]} 至 ${ids[ids.length - 1]}）`,
    '评测者不是全部玩家的随机样本', '最新版本的窗口仍在进行中'));

  const scope = [f.eq('game_id', game), f.in('version_id', ids)];
  const label = v => v;
  const bands = store.catalog.dimensions.playtime_band.order;
  const bandRows = store.query({ metrics: ['review_share', 'review_count'], dims: ['version_id', 'playtime_band'],
    filters: [...scope, { dim: 'playtime_band', op: 'notnull' }], shareDim: 'playtime_band' }).rows;
  const bandValue = (v, band) => bandRows.find(r => r.version_id === v && r.playtime_band === band)?.review_share ?? 0;

  const medianRows = store.query({ metrics: ['playtime_median_h', 'playtime_p25_h', 'playtime_p75_h', 'review_count', 'positive_rate'],
    dims: ['version_id'], filters: scope }).rows;
  const byVersion = Object.fromEntries(medianRows.map(r => [r.version_id, r]));
  const color = gameColor(store, game);

  const grid = el('div', { class: 'grid-2' },
    chartCard({ title: '写评测时的游戏时长构成', sub: '各版本窗口内的评测，按写评测时已玩的时长分段', filename: `${game}-playtime-bands`,
      chart: { type: 'stacked100', x: ids.map(label),
               series: bands.map(band => ({ name: dimText(store, 'playtime_band', band), color: ordinal(bands, band),
                                            data: ids.map(v => bandValue(v, band)) })),
               format: v => metricText(store, 'review_share', v), axisFormat: v => `${v}%` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'playtime_band', label: '时长段', format: v => dimText(store, 'playtime_band', v) },
                { key: 'review_count', label: '评测数', num: true },
                { key: 'review_share', label: '占比', num: true, format: v => metricText(store, 'review_share', v) }],
      rows: bandRows }),
    chartCard({ title: '写评测时游戏时长（中位数）', sub: '数据表里有 25 / 75 分位数', filename: `${game}-playtime-median`,
      chart: { type: 'bar', x: ids.map(label), series: [{ name: '中位数', color, data: ids.map(v => byVersion[v]?.playtime_median_h ?? null) }],
               format: v => `${formatValue(v, 'decimal1')} 小时`, axisFormat: v => `${v} h`,
               tooltipExtra: i => `${byVersion[ids[i]]?.review_count ?? 0} 条评测` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'review_count', label: '评测数', num: true },
                ...['playtime_p25_h', 'playtime_median_h', 'playtime_p75_h'].map(id => ({ key: id, label: store.catalog.metrics[id].label,
                  num: true, format: v => metricText(store, id, v) }))],
      rows: medianRows }),
  );
  root.append(grid);

  // 语种：前几种按全部所选版本的评测总数选出，颜色跟语种固定
  const langRows = store.query({ metrics: ['review_share', 'review_count'], dims: ['version_id', 'language'],
    filters: scope, shareDim: 'language' }).rows;
  const totals = {};
  for (const r of langRows) totals[r.language] = (totals[r.language] || 0) + r.review_count;
  const top = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, TOP_LANGUAGES);
  const langShare = (v, lang) => langRows.find(r => r.version_id === v && r.language === lang)?.review_share ?? 0;
  const langSeries = top.map((lang, i) => ({ name: dimText(store, 'language', lang), color: slot(i), data: ids.map(v => langShare(v, lang)) }));
  langSeries.push({ name: '其他', color: otherColor(), data: ids.map(v => Math.max(0, 100 - top.reduce((s, l) => s + langShare(v, l), 0))) });

  const bandRate = store.query({ metrics: ['positive_rate', 'review_count'], dims: ['version_id', 'playtime_band'],
    filters: [...scope, { dim: 'playtime_band', op: 'notnull' }] }).rows;
  const rateValue = (v, band) => bandRate.find(r => r.version_id === v && r.playtime_band === band)?.positive_rate ?? null;
  const grid2 = el('div', { class: 'grid-2' },
    chartCard({ title: '评测语种构成', sub: `前 ${TOP_LANGUAGES} 种语言按所选版本的评测总数选出，其余合并为"其他"`,
      caveat: '语种是写评测时选择的语言，不等于玩家所在地区。', filename: `${game}-languages`,
      chart: { type: 'stacked100', x: ids.map(label), series: langSeries, format: v => metricText(store, 'review_share', v), axisFormat: v => `${v}%` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'language', label: '语种', format: v => dimText(store, 'language', v) },
                { key: 'review_count', label: '评测数', num: true },
                { key: 'review_share', label: '占比', num: true, format: v => metricText(store, 'review_share', v) }],
      rows: langRows }),
    chartCard({ title: '不同时长段的好评率', sub: '同一版本里，玩得久的人和刚上手的人评价是否不同', filename: `${game}-rate-by-band`,
      chart: { type: 'bar', x: ids.map(label), series: bands.map(band => ({ name: dimText(store, 'playtime_band', band),
               color: ordinal(bands, band), data: ids.map(v => rateValue(v, band)) })),
               format: v => metricText(store, 'positive_rate', v), axisFormat: v => `${v}%` },
      columns: [{ key: 'version_id', label: '版本' }, { key: 'playtime_band', label: '时长段', format: v => dimText(store, 'playtime_band', v) },
                { key: 'review_count', label: '评测数', num: true },
                { key: 'positive_rate', label: '好评率', num: true, format: v => metricText(store, 'positive_rate', v) }],
      rows: bandRate }),
  );
  root.append(grid2);

  const retention = store.query({ metrics: ['still_playing_share', 'post_review_median_h'], dims: ['version_id'], filters: scope }).rows;
  const retentionBy = Object.fromEntries(retention.map(r => [r.version_id, r]));
  root.append(chartCard({ title: '评测后仍在玩的比例', sub: '评测后又玩了 60 分钟以上的评测者占比',
    caveat: '只统计距最后一次回填已满 14 天的评测，最近的版本可能还没有值。这是留存的参考，不是留存率。',
    filename: `${game}-still-playing`,
    chart: { type: 'bar', x: ids.map(label), series: [{ name: '仍在玩的比例', color, data: ids.map(v => retentionBy[v]?.still_playing_share ?? null) }],
             format: v => metricText(store, 'still_playing_share', v), axisFormat: v => `${v}%` },
    columns: [{ key: 'version_id', label: '版本' },
              { key: 'still_playing_share', label: '仍在玩的比例', num: true, format: v => metricText(store, 'still_playing_share', v) },
              { key: 'post_review_median_h', label: '评测后又玩的时长（中位数）', num: true, format: v => metricText(store, 'post_review_median_h', v) }],
    rows: retention }));
}
