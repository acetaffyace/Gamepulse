// 查询生成器：把"指标 + 维度 + 筛选"变成一条 SQL。
//
// 固定看板和自助查询都只通过这里取数，所以同一个数字在哪里看都一样。
// 表名、列名、聚合表达式只取自指标目录（config/metrics.yml），用户输入的值一律走参数绑定。
// 目录里的规则在这里强制执行：
//   must_group_by          这些维度必须出现在分组里，或被筛选为单个值
//   must_group_by_one_of   至少一组维度满足上面的条件
//   kind: share            占比 = 本行的值 ÷ 同一行其余维度下的合计 × 100

export class QueryError extends Error {}

const OPS = {
  eq: (col, v, params) => { params.push(v); return `${col} = ?`; },
  ne: (col, v, params) => { params.push(v); return `${col} <> ?`; },
  gte: (col, v, params) => { params.push(v); return `${col} >= ?`; },
  lte: (col, v, params) => { params.push(v); return `${col} <= ?`; },
  between: (col, v, params) => {
    if (!Array.isArray(v) || v.length !== 2) throw new QueryError(`${col} 的范围筛选需要起止两个值`);
    params.push(v[0], v[1]);
    return `${col} BETWEEN ? AND ?`;
  },
  in: (col, v, params) => {
    if (!Array.isArray(v) || !v.length) throw new QueryError(`${col} 的多选筛选至少要有一个值`);
    params.push(...v);
    return `${col} IN (${v.map(() => '?').join(', ')})`;
  },
  null: col => `${col} IS NULL`,
  notnull: col => `${col} IS NOT NULL`,
};

const quote = id => `"${id.replace(/"/g, '""')}"`;

// 这个维度是否已被"固定"为单个值：分组里有它，或筛选成了一个值
function pinned(dim, dims, filters) {
  if (dims.includes(dim)) return true;
  return filters.some(f => f.dim === dim && (f.op === 'eq' || (f.op === 'in' && f.value.length === 1)));
}

export function effectiveFilters(catalog, factId, spec) {
  const fact = catalog.facts[factId];
  const filters = [...(spec.filters || [])];
  if (spec.useDefaultFilters !== false) {
    for (const [dim, value] of Object.entries(fact.default_filters || {})) {
      if (!filters.some(f => f.dim === dim)) filters.push({ dim, op: 'eq', value });
    }
  }
  return filters;
}

export function buildQuery(catalog, spec) {
  const metricIds = spec.metrics || [];
  if (!metricIds.length) throw new QueryError('至少选择一个指标');
  const metrics = metricIds.map(id => {
    const m = catalog.metrics[id];
    if (!m) throw new QueryError(`未知指标：${id}`);
    return { id, ...m };
  });
  const factId = metrics[0].fact;
  const other = metrics.find(m => m.fact !== factId);
  if (other) {
    throw new QueryError(`「${metrics[0].label}」和「${other.label}」来自不同的数据表，不能放在同一个查询里`);
  }
  const fact = catalog.facts[factId];
  const allowed = new Set(fact.dimensions);
  const dims = spec.dims || [];
  if (new Set(dims).size !== dims.length) throw new QueryError('维度不能重复');
  for (const d of dims) {
    if (!allowed.has(d)) throw new QueryError(`「${fact.label}」不能按「${catalog.dimensions[d]?.label || d}」拆分`);
  }
  const filters = effectiveFilters(catalog, factId, spec);
  for (const f of filters) {
    if (!allowed.has(f.dim)) throw new QueryError(`「${fact.label}」不能按「${catalog.dimensions[f.dim]?.label || f.dim}」筛选`);
    if (!OPS[f.op]) throw new QueryError(`未知筛选方式：${f.op}`);
  }

  for (const m of metrics) {
    for (const d of m.must_group_by || []) {
      if (!pinned(d, dims, filters)) {
        throw new QueryError(`「${m.label}」必须按「${catalog.dimensions[d].label}」分开看${m.note ? `：${m.note}` : ''}`);
      }
    }
    const groups = m.must_group_by_one_of || [];
    if (groups.length && !groups.some(g => g.every(d => pinned(d, dims, filters)))) {
      const names = groups.map(g => g.map(d => `「${catalog.dimensions[d].label}」`).join('+')).join(' 或 ');
      throw new QueryError(`「${m.label}」必须按 ${names} 分开看${m.note ? `：${m.note}` : ''}`);
    }
  }

  const shareDim = spec.shareDim ?? dims[dims.length - 1];
  const select = dims.map(quote);
  for (const m of metrics) {
    let expr = m.agg;
    if (m.kind === 'share') {
      if (!dims.length || !dims.includes(shareDim)) throw new QueryError(`「${m.label}」需要选一个拆分维度`);
      const partition = dims.filter(d => d !== shareDim).map(quote);
      const over = partition.length ? `OVER (PARTITION BY ${partition.join(', ')})` : 'OVER ()';
      expr = `100.0 * (${m.agg}) / NULLIF(SUM(${m.agg}) ${over}, 0)`;
    }
    select.push(`${expr} AS ${quote(m.id)}`);
  }

  const params = [];
  const where = filters.map(f => OPS[f.op](quote(f.dim), f.value, params));
  let sql = `SELECT ${select.join(', ')} FROM ${quote(fact.view)}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (dims.length) sql += ` GROUP BY ${dims.map(quote).join(', ')}`;
  const order = spec.order || dims.map(d => ({ key: d }));
  if (order.length) {
    const keys = new Set([...dims, ...metricIds]);
    for (const o of order) if (!keys.has(o.key)) throw new QueryError(`不能按「${o.key}」排序：它不在查询结果里`);
    sql += ` ORDER BY ${order.map(o => `${quote(o.key)}${o.desc ? ' DESC' : ''}`).join(', ')}`;
  }
  if (spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || spec.limit <= 0) throw new QueryError('行数上限必须是正整数');
    sql += ` LIMIT ${spec.limit}`;
  }

  const columns = [
    ...dims.map(d => ({ key: d, kind: 'dimension', ...catalog.dimensions[d] })),
    ...metrics.map(m => ({ key: m.id, kind: 'metric', ...m })),
  ];
  return { sql, params, fact: factId, filters, columns };
}

// 自助查询的"直接写 SQL"模式：只允许单条只读语句。
// 数据库是浏览器内存里的副本，就算写入也不会影响发布的文件，这里只是防止误操作把页面弄乱。
export function checkReadOnlySql(sql) {
  const text = sql.trim().replace(/;\s*$/, '');
  // 开头的注释（-- 行注释与 /* 块注释 */）不算语句
  const body = text.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/, '');
  if (!/^(select|with)\b/i.test(body)) throw new QueryError('只能执行 SELECT 或 WITH 开头的查询');
  if (text.includes(';')) throw new QueryError('一次只能执行一条语句');
  return text;
}
