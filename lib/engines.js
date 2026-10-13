// 两个引擎按需并行加载；失败后允许重新请求。
const pending = new Map();
function script(file, ready, label) {
  if (ready()) return Promise.resolve();
  if (pending.has(file)) return pending.get(file);
  const task = new Promise((resolve, reject) => {
    const node = document.createElement('script');
    node.src = new URL(`../vendor/${file}`, import.meta.url).href;
    node.async = true;
    node.onload = () => ready() ? resolve() : fail();
    node.onerror = fail;
    function fail() { node.remove(); pending.delete(file); reject(new Error(`${label}加载失败`)); }
    document.head.append(node);
  });
  pending.set(file, task);
  return task;
}
export const loadQueryEngine = () => script('sql-wasm.js', () => typeof window.initSqlJs === 'function', '查询引擎');
export const loadChartEngine = () => script('echarts.min.js', () => Boolean(window.echarts), '图表引擎');
