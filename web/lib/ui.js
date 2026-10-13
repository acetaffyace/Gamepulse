// 页面小部件：元素创建、筛选控件、指标卡、带"数据表 / 导出"的图表卡。
// 数据一律用 textContent 放进页面，不拼接 HTML。

import { exportPng, renderChart, toggleSeries } from './chart.js';

// 临时菜单统一处理外部点击和Escape；不为每张卡重复添加全局监听器。
if (typeof document !== 'undefined') {
  const place = box => {
    if (!box.open || !box.isConnected) return;
    const panel = box.querySelector(':scope > .menu-items');
    if (!panel) return;
    panel.style.transform = ''; panel.style.top = ''; panel.style.bottom = ''; panel.style.maxHeight = '';
    const anchor = box.getBoundingClientRect();
    const below = innerHeight - anchor.bottom - 22;
    const above = anchor.top - 22;
    const up = below < Math.min(panel.scrollHeight, 180) && above > below;
    if (up) { panel.style.top = 'auto'; panel.style.bottom = 'calc(100% + 6px)'; }
    panel.style.maxHeight = `${Math.max(80, Math.min(innerHeight * .65, up ? above : below))}px`;
    const rect = panel.getBoundingClientRect();
    const shift = rect.right > innerWidth - 16 ? innerWidth - 16 - rect.right : rect.left < 16 ? 16 - rect.left : 0;
    panel.style.transform = `translateX(${shift}px)`;
  };
  document.addEventListener('toggle', e => { if (e.target.matches('details.menu')) place(e.target); }, true);
  window.addEventListener('resize', () => document.querySelectorAll('details.menu[open]').forEach(place));
  document.addEventListener('pointerdown', e => {
    const current = e.target.closest?.('details.menu');
    document.querySelectorAll('details.menu[open]').forEach(menu => { if (menu !== current) menu.open = false; });
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('details.menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
  });
}

export function menu(label, actions) {
  const box = el('details', { class: 'menu', 'data-state-key': `menu:${label}` }, el('summary', {}, label));
  box.append(el('div', { class: 'menu-items' }, actions.map(action => el('button', {
    type: 'button', class: 'ghost', onclick: async () => {
      box.open = false;
      try { await action.run(); } catch { toast(`${action.label}失败，请重试`); }
    },
  }, action.label))));
  return box;
}

export function infoMenu(label, ...content) {
  return el('details', { class: 'menu info-menu', 'data-state-key': `info:${label}` },
    el('summary', {}, label), el('div', { class: 'menu-items menu-info' }, ...content));
}

export function emptyState(message = '暂无数据', actions = []) {
  const label = /异常/.test(message) ? '无异常' : /样本/.test(message) ? '样本不足' : /覆盖/.test(message) ? '覆盖不足' : /观测/.test(message) ? '暂无观测' : '暂无数据';
  return el('div', { class: 'empty empty-state', role: 'status' }, el('strong', {}, label),
    el('div', { class: 'empty-actions' }, actions.map(a => el('a', { href: a.href, class: 'action-link' }, a.label)),
      infoMenu('详情', el('p', {}, message))));
}

export function disclosure(label, ...content) {
  return el('details', { class: 'explanation', 'data-state-key': `detail:${label}` }, el('summary', {}, label), ...content);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(message) {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 2200);
}

// 分段按钮：options = [{ value, label }]
export function segmented(label, options, current, onChange) {
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': label });
  for (const o of options) {
    group.append(el('button', { type: 'button', 'data-value': o.value, 'aria-pressed': String(String(o.value) === String(current)),
      onclick: () => onChange(o.value) }, o.label));
  }
  return field(label, group);
}

// 按钮组的外层不能用 <label>：点到文字时浏览器会把点击转给里面的第一个按钮
function field(label, control) {
  return el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), control);
}

export function select(label, options, current, onChange, attrs = {}) {
  const box = el('select', { 'aria-label': label || '数据表', ...attrs, onchange: e => onChange(e.target.value) });
  for (const o of options) {
    box.append(el('option', { value: o.value, selected: String(o.value) === String(current) }, o.label));
  }
  return el('label', {}, label, box);
}

// 多选标签：options = [{ value, label, color }]
export function chips(label, options, selected, onChange) {
  const set = new Set(selected.map(String));
  const group = el('div', { class: 'chips', role: 'group', 'aria-label': label });
  for (const o of options) {
    const on = set.has(String(o.value));
    group.append(el('button', { type: 'button', class: 'chip', 'data-value': o.value, 'aria-pressed': String(on), onclick: () => {
      const next = new Set(set);
      if (on) next.delete(String(o.value)); else next.add(String(o.value));
      if (!next.size) return;   // 至少保留一个
      onChange(options.map(x => x.value).filter(v => next.has(String(v))));
    } }, o.color ? el('span', { class: 'swatch', style: { background: o.color } }) : null, o.label));
  }
  return field(label, group);
}

export function tile({ label, value, unit, delta, note, metric, status }) {
  return el('div', { class: `tile${status ? ' '+status : ''}`, 'data-metric': metric, role: 'group', 'aria-label': label, 'aria-description': note },
    el('div', { class: 'tile-heading' }, el('span', { class: 'tile-label' }, label),
      delta ? el('span', { class: 'tile-delta', 'aria-label': delta }, delta.replace(' 个百分点', '点')) : null),
    el('div', { class: 'tile-value' }, value, unit ? el('small', {}, unit) : null));
}

// 表格：columns = [{ key, label, num, format }]
// 页面上最多画这么多行：再多浏览器会明显变慢，完整结果用"导出 CSV"
export const TABLE_ROW_LIMIT = 50;

export function table(columns, rows, { label = '数据表' } = {}) {
  let page = 0, sort = null, descending = false;
  const headers = columns.map(c => el('th', { class: c.num ? 'num' : undefined, scope: 'col' },
    c.sort === false ? c.label : el('button', { type: 'button', class: 'sort-button', 'aria-label': `按${c.label}排序`, onclick: () => {
      descending = sort === c ? !descending : false; sort = c; page = 0; render();
    } }, c.label)));
  const body = el('tbody');
  const wrap = el('div', { class: 'table-wrap', tabindex: '0', 'aria-label': `${label}，宽表可左右滚动` },
    el('table', { class: 'data' }, el('thead', {}, el('tr', {}, headers)), body));
  const search = el('input', { type: 'search', placeholder: '搜索表格', 'aria-label': `搜索${label}`, oninput: () => { page = 0; render(); } });
  const status = el('span', { class: 'table-count', 'aria-live': 'polite' });
  const prev = el('button', { type: 'button', 'aria-label': `${label}上一页`, onclick: () => { page--; render(); } }, '上一页');
  const next = el('button', { type: 'button', 'aria-label': `${label}下一页`, onclick: () => { page++; render(); } }, '下一页');
  const navigation = el('div', { class: 'table-pagination' }, prev, status, next);
  const tools = el('div', { class: 'table-tools', hidden: rows.length <= 12 }, search);
  const box = el('div', { class: 'table-view', 'data-state-key': `table:${label}` }, tools, wrap, navigation);
  const formatted = (c, row) => c.format ? c.format(row[c.key], row) : (row[c.key] ?? '—');
  let searchIndex;
  function render() {
    const term = search.value.trim().toLocaleLowerCase();
    if (term && !searchIndex) searchIndex = rows.map(r => columns.map(c => {
      const text = formatted(c, r); return text instanceof Node ? text.textContent : String(text);
    }).join(' ').toLocaleLowerCase());
    let visible = rows.map((row, index) => ({ row, index })).filter(({ index }) => !term || searchIndex[index].includes(term));
    if (sort) visible.sort((a, b) => {
      const av = sort.sortValue ? sort.sortValue(a.row) : a.row[sort.key];
      const bv = sort.sortValue ? sort.sortValue(b.row) : b.row[sort.key];
      if (av == null || bv == null) return av == null ? (bv == null ? a.index-b.index : 1) : -1;
      const result = typeof av === 'number' && typeof bv === 'number' ? av-bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true });
      return (descending ? -result : result) || a.index-b.index;
    });
    headers.forEach((h, i) => {
      if (sort === columns[i]) h.setAttribute('aria-sort', descending ? 'descending' : 'ascending'); else h.removeAttribute('aria-sort');
    });
    const totalPages = Math.max(1, Math.ceil(visible.length / TABLE_ROW_LIMIT));
    page = Math.max(0, Math.min(page, totalPages-1));
    body.replaceChildren(...visible.slice(page*TABLE_ROW_LIMIT, (page+1)*TABLE_ROW_LIMIT).map(({ row }) =>
      el('tr', {}, columns.map(c => el('td', { class: `${c.num ? 'num' : ''}${c.wrap ? ' wrap-cell' : ''}` }, formatted(c, row))))));
    if (!visible.length) body.append(el('tr', {}, el('td', { colspan: columns.length }, '没有匹配的行')));
    prev.disabled = page === 0; next.disabled = page === totalPages-1;
    navigation.hidden = rows.length <= TABLE_ROW_LIMIT && !term;
    status.textContent = `第 ${page+1}/${totalPages} 页 · ${visible.length} 行${term ? `（原结果 ${rows.length} 行）` : ''}`;
    wrap.scrollTop = 0;
  }
  render();
  box.uiState = {
    get: () => ({ page, sort: sort?.key, descending, term: search.value, scroll: wrap.scrollTop }),
    restore: saved => {
      page = saved.page; sort = columns.find(c => c.key === saved.sort) || null;
      descending = saved.descending; search.value = saved.term || '';
      tools.hidden = rows.length <= 12 && !search.value;
      render(); wrap.scrollTop = saved.scroll || 0;
    },
  };
  return box;
}

export function toCsv(columns, rows) {
  const cell = v => {
    let s = v === null || v === undefined ? '' : String(v);
    // 以 = + - @ 开头的文字在表格软件里会被当成公式执行（视频标题来自外部），前面加 ' 让它保持为文字
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map(c => cell(c.label)).join(','),
    ...rows.map(r => columns.map(c => cell(c.csv ? c.csv(r[c.key], r) : r[c.key])).join(','))].join('\n');
}

export function download(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 图表卡：每张图都有数据表视图和导出。spec 为 renderChart 的参数；columns/rows 为表格与 CSV 的内容。
export function exportContext({ title, sub, caveat, context }) {
  const selection = [...document.querySelectorAll('main .filters select, main .panel select')].map(select => {
    const label = [...select.parentNode.childNodes].filter(n => n !== select).map(n => n.textContent).join('').trim();
    return `${label ? label+'：' : ''}${select.selectedOptions[0]?.textContent || ''}`;
  });
  document.querySelectorAll('main .filters .segmented, main .filters .chips, main .panel .chips, main .curve-controls .segmented, main .comparison-modes .segmented').forEach(group => {
    const active = [...group.querySelectorAll('[aria-pressed="true"]')].map(n => n.textContent).join('、');
    if (active) selection.push(`${group.getAttribute('aria-label') || group.parentNode.querySelector('.field-label')?.textContent || ''}：${active}`);
  });
  document.querySelectorAll('main input[type="date"], main input[type="number"]').forEach(input => {
    if (input.value) selection.push(`${input.getAttribute('aria-label') || ''}：${input.value}`);
  });
  return { title, description: sub || '', scope: document.querySelector('.scope')?.dataset.fullScope || document.querySelector('.scope')?.textContent || '',
    selection: selection.join(' · '),
    page: document.querySelector('main h1')?.textContent || '', published: document.getElementById('data-status')?.dataset.publishedAt || document.getElementById('data-status')?.textContent || '',
    filters: Object.fromEntries(new URLSearchParams(location.search)), caveat: caveat || '', ...context };
}

// tone 是页面指定的模块标识色；省略时沿用页面主题。图形系列颜色由调用方独立提供。
export function chartCard({ title, sub, caveat, chart, columns, rows, filename, small, empty, emptyActions, context, controls, tone }) {
  const chartBox = el('div', { class: small ? 'chart chart-small' : 'chart', role: 'img', 'aria-label': `${title}（可切换为数据表查看具体数值）` });
  const tableBox = el('div', { hidden: true });
  if (chart.height) chartBox.style.height = `${chart.height}px`;
  const toggle = el('button', { type: 'button', 'aria-pressed': 'false' }, '数据表');
  toggle.addEventListener('click', () => {
    const showing = tableBox.hidden;
    tableBox.hidden = !showing;
    chartBox.hidden = showing;
    toggle.setAttribute('aria-pressed', String(showing));
    toggle.textContent = showing ? '图表' : '数据表';
    if (showing && !tableBox.childElementCount) tableBox.append(table(columns, rows, { label: title }));
  });
  const metadata = () => exportContext({ title, sub, caveat: [caveat,
    chart.percent && chart.fitY ? '纵轴按数值范围缩放；请结合百分点差和有效样本数读图。' : ''].filter(Boolean).join('\n'), context });
  const zoomNote = chart.percent && chart.fitY ? '纵轴按数值范围缩放；结合百分点差与有效样本读图。' : '';
  const info = sub || caveat || zoomNote ? infoMenu('口径', sub ? el('p', { class: 'card-sub' }, sub) : null,
    caveat ? el('p', {}, caveat) : null, zoomNote ? el('p', {}, zoomNote) : null) : null;
  const actions = el('div', { class: 'card-actions' }, info, toggle, menu('导出', [
    { label: '导出 CSV', run: () => download(`${filename}.csv`, toCsv(columns, rows)) },
    { label: '导出 PNG', run: () => exportPng(chartBox, `${filename}.png`, metadata()) },
    { label: '下载口径说明', run: () => download(`${filename}-context.json`, JSON.stringify(metadata(), null, 2), 'application/json;charset=utf-8') },
  ]));
  const legend = !empty && chart.series.length > 1 ? el('div', { class: 'chart-legend', role: 'group', 'aria-label': `${title}系列` },
    chart.series.map(s => el('button', { type: 'button', class: 'legend-item', 'aria-pressed': 'true', onclick: e => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on)); toggleSeries(chartBox, s.name);
    } }, el('span', { class: 'swatch', style: { background: s.color } }), s.name))) : null;
  const card = el('section', { class: 'card', 'data-tone': tone, 'data-state-key': `chart:${filename}` },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, title)), empty ? info : actions),
    controls, legend, empty ? emptyState(empty, emptyActions) : chartBox, tableBox);
  card.uiState = {
    get: () => ({ table: !tableBox.hidden, hidden: legend ? [...legend.querySelectorAll('[aria-pressed="false"]')].map(n => n.textContent) : [] }),
    restore: saved => {
      if (saved.table && tableBox.hidden && !empty) toggle.click();
      legend?.querySelectorAll('button').forEach(n => { if (saved.hidden.includes(n.textContent)) n.click(); });
    },
  };
  if (!empty) requestAnimationFrame(() => { if (chartBox.isConnected) renderChart(chartBox, chart); });
  return card;
}

export function tableCard({ title, sub, caveat, columns, rows, filename, context, tone }) {
  const metadata = () => exportContext({ title, sub, caveat, context });
  return el('section', { class: 'card', 'data-tone': tone, 'data-state-key': `card:${filename}` },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, title)),
      el('div', { class: 'card-actions' },
        sub || caveat ? infoMenu('口径', sub ? el('p', { class: 'card-sub' }, sub) : null, caveat ? el('p', {}, caveat) : null) : null,
        menu('导出', [
          { label: '导出 CSV', run: () => download(`${filename}.csv`, toCsv(columns, rows)) },
          { label: '下载口径说明', run: () => download(`${filename}-context.json`, JSON.stringify(metadata(), null, 2), 'application/json;charset=utf-8') },
        ]))),
    rows.length ? table(columns, rows, { label: title }) : emptyState('没有符合条件的数据'));
}
