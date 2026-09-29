"""指标目录（config/metrics.yml）的加载与校验。

构建时逐条校验：视图存在、声明的维度都是视图里的列、每个指标的聚合 SQL 能执行、
规则引用的维度都属于这个事实。任何一条失败都停止发布。
这替代了 v2"轨道字段能在快照里取到值"的检查。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import yaml

from store import db

CATALOG_PATH = db.ROOT / "config" / "metrics.yml"
FORMATS = {"integer", "decimal1", "percent"}
DIMENSION_TYPES = {"category", "integer", "date", "boolean"}
KINDS = {None, "share"}


class CatalogError(ValueError):
    pass


def load(path: Path = CATALOG_PATH) -> dict:
    catalog = yaml.safe_load(path.read_text(encoding="utf-8"))
    for key in ("facts", "dimensions", "metrics"):
        if not isinstance(catalog.get(key), dict) or not catalog[key]:
            raise CatalogError(f"metrics.yml: missing section {key}")
    # YAML 会把 {1: 好评} 的键读成整数，统一成字符串，与 JSON 和浏览器端一致
    for dim in catalog["dimensions"].values():
        if "values" in dim:
            dim["values"] = {str(k): v for k, v in dim["values"].items()}
    return catalog


def validate(conn: sqlite3.Connection, catalog: dict) -> list[str]:
    """返回错误列表；空列表表示通过。"""
    errors: list[str] = []
    dims = catalog["dimensions"]
    for name, dim in dims.items():
        if dim.get("type") not in DIMENSION_TYPES:
            errors.append(f"dimension {name}: unknown type {dim.get('type')!r}")
        if not dim.get("label"):
            errors.append(f"dimension {name}: missing label")

    for fact_id, fact in catalog["facts"].items():
        try:
            cols = set(db.columns(conn, fact["view"]))
        except ValueError:
            errors.append(f"fact {fact_id}: view {fact.get('view')!r} does not exist")
            continue
        for dim in fact.get("dimensions", []):
            if dim not in dims:
                errors.append(f"fact {fact_id}: dimension {dim} is not declared under dimensions")
            if dim not in cols:
                errors.append(f"fact {fact_id}: {fact['view']} has no column {dim}")
        if fact.get("date_dimension") not in fact.get("dimensions", []):
            errors.append(f"fact {fact_id}: date_dimension must be one of its dimensions")
        for dim in (fact.get("default_filters") or {}):
            if dim not in fact.get("dimensions", []):
                errors.append(f"fact {fact_id}: default filter on unknown dimension {dim}")
        if not fact.get("label") or not fact.get("note"):
            errors.append(f"fact {fact_id}: label and note are required")

    for metric_id, metric in catalog["metrics"].items():
        fact = catalog["facts"].get(metric.get("fact"))
        if fact is None:
            errors.append(f"metric {metric_id}: unknown fact {metric.get('fact')!r}")
            continue
        for key in ("label", "agg", "unit", "format"):
            if not metric.get(key):
                errors.append(f"metric {metric_id}: missing {key}")
        if metric.get("format") not in FORMATS:
            errors.append(f"metric {metric_id}: unknown format {metric.get('format')!r}")
        if metric.get("kind") not in KINDS:
            errors.append(f"metric {metric_id}: unknown kind {metric.get('kind')!r}")
        allowed = set(fact.get("dimensions", []))
        for dim in metric.get("must_group_by", []):
            if dim not in allowed:
                errors.append(f"metric {metric_id}: must_group_by {dim} is not a dimension of {metric['fact']}")
        for group in metric.get("must_group_by_one_of", []):
            if not isinstance(group, list) or not group:
                errors.append(f"metric {metric_id}: must_group_by_one_of entries must be non-empty lists")
                continue
            for dim in group:
                if dim not in allowed:
                    errors.append(f"metric {metric_id}: must_group_by_one_of {dim} is not a dimension of {metric['fact']}")
        try:
            conn.execute(f"SELECT {metric['agg']} FROM {fact['view']} WHERE 0").fetchall()
        except sqlite3.Error as exc:
            errors.append(f"metric {metric_id}: agg does not run: {exc}")
    return errors


def check(conn: sqlite3.Connection, path: Path = CATALOG_PATH) -> dict:
    catalog = load(path)
    errors = validate(conn, catalog)
    if errors:
        raise CatalogError("metrics.yml 校验失败：\n  " + "\n  ".join(errors))
    return catalog
