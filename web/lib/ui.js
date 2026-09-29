// 页面小部件：元素创建、筛选控件、指标卡、带"数据表 / 导出"的图表卡。
// 数据一律用 textContent 放进页面，不拼接 HTML。

import { exportPng, renderChart } from './chart.js';

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
    group.append(el('button', { type: 'button', 'aria-pressed': String(String(o.value) === String(current)),
      onclick: () => onChange(o.value) }, o.label));
  }
  return field(label, group);
}

// 按钮组的外层不能用 <label>：点到文字时浏览器会把点击转给里面的第一个按钮
function field(label, control) {
  return el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), control);
}

export function select(label, options, current, onChange, attrs = {}) {
  const box = el('select', { ...attrs, onchange: e => onChange(e.target.value) });
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
    group.append(el('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), onclick: () => {
      const next = new Set(set);
      if (on) next.delete(String(o.value)); else next.add(String(o.value));
      if (!next.size) return;   // 至少保留一个
      onChange(options.map(x => x.value).filter(v => next.has(String(v))));
    } }, o.color ? el('span', { class: 'swatch', style: { background: o.color } }) : null, o.label));
  }
  return field(label, group);
}

export function tile({ label, value, unit, delta, note }) {
  return el('div', { class: 'tile' },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, value, unit ? el('small', {}, unit) : null),
    delta ? el('div', { class: 'tile-delta' }, delta) : null,
    note ? el('div', { class: 'tile-note' }, note) : null);
}

// 表格：columns = [{ key, label, num, format }]
// 页面上最多画这么多行：再多浏览器会明显变慢，完整结果用"导出 CSV"
export const TABLE_ROW_LIMIT = 500;

export function table(columns, rows) {
  const head = el('tr', {}, columns.map(c => el('th', { class: c.num ? 'num' : undefined, scope: 'col' }, c.label)));
  const body = rows.slice(0, TABLE_ROW_LIMIT).map(r => el('tr', {}, columns.map(c => {
    const v = r[c.key];
    return el('td', { class: c.num ? 'num' : undefined }, c.format ? c.format(v, r) : (v ?? '—'));
  })));
  return el('div', {},
    el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('thead', {}, head), el('tbody', {}, body))),
    rows.length > TABLE_ROW_LIMIT
      ? el('p', { class: 'note' }, `共 ${rows.length} 行，页面上只显示前 ${TABLE_ROW_LIMIT} 行；完整结果请导出 CSV。`) : null);
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
export function chartCard({ title, sub, caveat, chart, columns, rows, filename, small, empty }) {
  const chartBox = el('div', { class: small ? 'chart chart-small' : 'chart', role: 'img', 'aria-label': `${title}（可切换为数据表查看具体数值）` });
  const tableBox = el('div', { hidden: true });
  const toggle = el('button', { type: 'button', 'aria-pressed': 'false' }, '数据表');
  toggle.addEventListener('click', () => {
    const showing = tableBox.hidden;
    tableBox.hidden = !showing;
    chartBox.hidden = showing;
    toggle.setAttribute('aria-pressed', String(showing));
    toggle.textContent = showing ? '图表' : '数据表';
    if (showing && !tableBox.childElementCount) tableBox.append(table(columns, rows));
  });
  const actions = el('div', { class: 'card-actions' }, toggle,
    el('button', { type: 'button', onclick: () => download(`${filename}.csv`, toCsv(columns, rows)) }, '导出 CSV'),
    el('button', { type: 'button', onclick: () => exportPng(chartBox, `${filename}.png`) }, '导出 PNG'));
  const card = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, title), sub ? el('div', { class: 'card-sub' }, sub) : null),
      empty ? null : actions),
    empty ? el('div', { class: 'empty' }, empty) : chartBox, tableBox,
    caveat ? el('div', { class: 'caveat' }, caveat) : null);
  if (!empty) requestAnimationFrame(() => renderChart(chartBox, chart));
  return card;
}

export function tableCard({ title, sub, caveat, columns, rows, filename }) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, title), sub ? el('div', { class: 'card-sub' }, sub) : null),
      el('div', { class: 'card-actions' },
        el('button', { type: 'button', onclick: () => download(`${filename}.csv`, toCsv(columns, rows)) }, '导出 CSV'))),
    rows.length ? table(columns, rows) : el('div', { class: 'empty' }, '没有符合条件的数据'),
    caveat ? el('div', { class: 'caveat' }, caveat) : null);
}
