/* Pure video comparison rules, shared by the browser and node tests. */
(function (root) {
  'use strict';
  const METRICS = {
    view: { label: '播放 / 观看量', unit: '次' },
    like: { label: '点赞数', unit: '次' },
    comment: { label: '评论数', unit: '条' },
    like_rate: { label: '点赞 / 播放', unit: '%' },
    engagement: { label: '平台互动率', unit: '%' },
    coin: { label: '投币数 · B 站', unit: '次', biliOnly: true },
    favorite: { label: '收藏数 · B 站', unit: '次', biliOnly: true },
    share: { label: '分享数 · B 站', unit: '次', biliOnly: true },
    danmaku: { label: '弹幕数 · B 站', unit: '条', biliOnly: true },
  };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
  function metric(point, field, platform) {
    if (!point || (METRICS[field]?.biliOnly && platform !== 'bilibili')) return null;
    const s = point.stats || {};
    if (field === 'like_rate') {
      return number(s.like) != null && number(s.view) > 0 ? s.like / s.view * 100 : null;
    }
    if (field === 'engagement') {
      // Derive from explicit counters; old snapshots used different YouTube formulas.
      const fields = platform === 'bilibili' ? ['like', 'coin', 'favorite'] : ['like', 'comment'];
      return number(s.view) > 0 && fields.every(k => number(s[k]) != null)
        ? fields.reduce((n, k) => n + s[k], 0) / s.view * 100 : null;
    }
    return number(s[field === 'comment' && platform === 'bilibili' ? 'reply' : field]);
  }
  function samples(record, field) {
    const v = record.video;
    const byDate = new Map();
    for (const p of [...(v.points || []), v.latest].filter(Boolean)) {
      const value = metric(p, field, record.platform);
      if (p.date_local && value != null) byDate.set(p.date_local, {
        date: p.date_local, age: daysBetween(v.pubdate, p.date_local), value,
      });
    }
    return [...byDate.values()].filter(p => Number.isFinite(p.age) && p.age >= 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  function pairKey(record) {
    // No title/date guessing: unmatched uploads must remain separate.
    return record.gameId + ':' + (record.video.pair_id ||
      record.source + ':' + (record.video.bvid || record.video.video_id));
  }
  function series(record, view) {
    const list = samples(record, view.metric);
    if (!list.length) return { points: [], reason: '该指标无有效观测', samples: list };
    if (view.mode === 'snapshot') return { points: [{ ...list.at(-1), x: record.video.pubdate }], samples: list };
    if (view.mode === 'daily') {
      const byDate = new Map(list.map(p => [p.date, p]));
      return { points: list.map(p => {
        const previousDate = new Date(Date.parse(p.date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        const previous = byDate.get(previousDate);
        return { ...p, x: p.date, value: previous ? p.value - previous.value : null };
      }).filter(p => (!record.observationStart || p.date >= record.observationStart) &&
        (!record.observationEnd || p.date <= record.observationEnd)), samples: list };
    }
    const limit = view.compareDays;
    if (view.mode === 'age') {
      const byAge = new Map(list.map(p => [p.age, p]));
      const complete = Array.from({ length: limit }, (_, i) => byAge.has(i)).every(Boolean);
      if (!complete) return { points: [], reason: `首 ${limit} 天缺采`, samples: list };
      return { points: Array.from({ length: limit }, (_, i) => ({ ...byAge.get(i), x: i })), samples: list };
    }
    const first = list[0];
    const lastDay = Math.min(limit - 1, daysBetween(first.date, list.at(-1).date));
    const byDay = new Map(list.map(p => [daysBetween(first.date, p.date), p]));
    const points = Array.from({ length: lastDay + 1 }, (_, x) => {
      const p = byDay.get(x);
      return { x, value: p ? p.value - first.value : null, date: p?.date, age: p?.age };
    });
    return { points, samples: list, baseline: first };
  }
  function prepare(records, view) {
    return records.map(record => {
      const result = { ...record, pair: pairKey(record), ...series(record, view) };
      if (view.mode === 'snapshot' && view.metric === 'view' && view.scale === 'index') {
        result.points = result.points.filter(p => record.referenceMedian > 0)
          .map(p => ({ ...p, rawValue: p.value, value: p.value / record.referenceMedian }));
      }
      return result;
    });
  }
  function exportRows(prepared, view) {
    return prepared.filter(r => !view.focusPair || r.pair === view.focusPair).flatMap(r => r.points.map(p => ({
      game: r.gameId, subject: r.subjectLabel, platform: r.platform, locale: r.locale || 'zh-cn',
      video_id: r.video.bvid || r.video.video_id, pair_id: r.video.pair_id || '',
      title: r.video.title, content_type: r.type, published: r.video.pubdate,
      mode: view.mode, metric: view.metric,
      unit: view.mode === 'snapshot' && view.metric === 'view' && view.scale === 'index' ? 'ratio'
        : ['tracking', 'daily'].includes(view.mode) && METRICS[view.metric].unit === '%' ? 'pp' : METRICS[view.metric].unit,
      x: p.x, sampled: p.date || '', age_days: p.age ?? '', value: p.value,
      raw_value: p.rawValue ?? p.value, reference_median: r.referenceMedian ?? '',
      baseline_date: r.baseline?.date || '', baseline_value: r.baseline?.value ?? '',
      snapshot_date: r.snapshotDate,
    })));
  }
  const api = { METRICS, metric, samples, pairKey, series, prepare, exportRows, daysBetween };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VideoModel = api;
})(globalThis);
