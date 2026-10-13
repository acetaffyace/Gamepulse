// 配色：参考配色的分类色顺序（已用 dataviz 校验脚本验证浅色、深色两套）。
// 颜色跟着对象走，不跟排名走：同一个游戏、语区、时长段在所有图里都是同一个颜色，筛掉别的也不会变色。

export const CATEGORICAL = [
  { light: '#2a78d6', dark: '#3987e5' },   // 蓝
  { light: '#eb6834', dark: '#d95926' },   // 橙
  { light: '#1baf7a', dark: '#199e70' },   // 青
  { light: '#eda100', dark: '#c98500' },   // 黄
  { light: '#e87ba4', dark: '#d55181' },   // 品红
  { light: '#008300', dark: '#008300' },   // 绿
  { light: '#4a3aa7', dark: '#9085e9' },   // 紫
  { light: '#e34948', dark: '#e66767' },   // 红
];
const DARK_OF = Object.fromEntries(CATEGORICAL.map(c => [c.light, c.dark]));
export const OTHER = { light: '#b5b3aa', dark: '#6b6a64' };   // "其他"用中性灰，明确不属于分类色序列

// 有序类别（时长段）：单一蓝色，由浅到深；浅端对背景仍 ≥ 2:1
export const ORDINAL_BLUE = { light: ['#86b6ef', '#3987e5', '#256abf', '#184f95'],
                             dark: ['#184f95', '#256abf', '#3987e5', '#86b6ef'] };

export const isDark = () => document.documentElement.dataset.theme === 'dark';

export function themed(color) {
  if (!isDark()) return color;
  return DARK_OF[color] || color;
}

export const slot = i => (isDark() ? CATEGORICAL[i % CATEGORICAL.length].dark : CATEGORICAL[i % CATEGORICAL.length].light);
export const otherColor = () => (isDark() ? OTHER.dark : OTHER.light);

// 固定顺序的类别（语区、平台）：按目录里的 order 取色位，不按当前出现的顺序
export function colorByOrder(order, value) {
  const i = order.indexOf(value);
  return i < 0 ? otherColor() : slot(i);
}

export function ordinal(order, value) {
  const ramp = isDark() ? ORDINAL_BLUE.dark : ORDINAL_BLUE.light;
  const i = order.indexOf(value);
  return i < 0 ? otherColor() : ramp[Math.min(i, ramp.length - 1)];
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
