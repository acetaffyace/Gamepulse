"""指标目录校验：真实目录能通过，各类错误都会被发现。"""
from __future__ import annotations

import copy
import unittest

from store import catalog, db


class CatalogValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = db.connect(":memory:")
        cls.real = catalog.load()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def errors(self, mutate):
        broken = copy.deepcopy(self.real)
        mutate(broken)
        return "\n".join(catalog.validate(self.conn, broken))

    def test_project_catalog_is_valid(self):
        self.assertEqual(catalog.validate(self.conn, self.real), [])

    def test_value_label_keys_are_strings(self):
        self.assertEqual(self.real["dimensions"]["voted_up"]["values"], {"1": "好评", "0": "差评"})

    def test_missing_view_is_reported(self):
        self.assertIn("does not exist", self.errors(lambda c: c["facts"]["review"].update(view="v_nope")))

    def test_dimension_that_is_not_a_column_is_reported(self):
        def mutate(c):
            c["facts"]["online"]["dimensions"].append("language")
        self.assertIn("v_online has no column language", self.errors(mutate))

    def test_undeclared_dimension_is_reported(self):
        def mutate(c):
            c["facts"]["review"]["dimensions"].append("review_id")
        self.assertIn("review_id is not declared", self.errors(mutate))

    def test_broken_aggregation_sql_is_reported(self):
        def mutate(c):
            c["metrics"]["review_count"]["agg"] = "SUM(no_such_column)"
        self.assertIn("metric review_count: agg does not run", self.errors(mutate))

    def test_rule_on_foreign_dimension_is_reported(self):
        def mutate(c):
            c["metrics"]["avg_players"]["must_group_by"] = ["locale"]
        self.assertIn("must_group_by locale is not a dimension of online", self.errors(mutate))

    def test_unknown_format_is_reported(self):
        def mutate(c):
            c["metrics"]["avg_players"]["format"] = "money"
        self.assertIn("unknown format", self.errors(mutate))

    def test_default_filter_must_be_a_dimension(self):
        def mutate(c):
            c["facts"]["online"]["default_filters"] = {"curated": 1}
        self.assertIn("default filter on unknown dimension curated", self.errors(mutate))


if __name__ == "__main__":
    unittest.main()
