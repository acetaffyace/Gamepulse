// quantile(x, p)：线性插值分位数（与 PERCENTILE_CONT 相同），p = 0.5 即标准中位数。
// 与 store/db.py 的 Quantile 同一口径，两端用 tests/fixtures/quantile-cases.json 交叉核对。

export function quantile(values, p) {
  const xs = values.filter(v => v !== null && v !== undefined).map(Number).sort((a, b) => a - b);
  if (!xs.length || p === null || p === undefined) return null;
  const h = (xs.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, xs.length - 1);
  return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}

// 注册到 sql.js 数据库。没有任何行时 sql.js 传入的 state 是 undefined，结果为 NULL。
export function registerQuantile(db) {
  db.create_aggregate('quantile', {
    init: () => ({ values: [], p: null }),
    step: (state, value, p) => {
      if (p === null || p === undefined || p < 0 || p > 1) throw new Error('quantile p must be between 0 and 1');
      state.p = p;
      if (value !== null && value !== undefined) state.values.push(value);
      return state;
    },
    finalize: state => (state ? quantile(state.values, state.p) : null),
  });
}
