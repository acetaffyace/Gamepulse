"""A same-day retry must not replace a valid review observation with nulls."""

import unittest

from collectors.steam import retain_same_day_reviews


class TestSameDayReviewRetry(unittest.TestCase):
    def test_failed_retry_preserves_observed_review_fields(self):
        existing = {
            "total_reviews": 160, "total_positive": 140,
            "total_negative": 20, "review_score_desc": "Very Positive",
            "reviews_status": "observed", "reviews_note": "",
        }
        retry = {
            "total_reviews": None, "total_positive": None,
            "total_negative": None, "review_score_desc": None,
            "reviews_status": "unavailable", "reviews_note": "ConnectTimeout",
        }
        self.assertTrue(retain_same_day_reviews(retry, existing))
        self.assertEqual(retry["total_reviews"], 160)
        self.assertEqual(retry["total_positive"], 140)
        self.assertEqual(retry["reviews_status"], "observed")
        self.assertIn("ConnectTimeout", retry["reviews_note"])

    def test_successful_retry_replaces_earlier_sample(self):
        retry = {"total_reviews": 170, "reviews_status": "observed"}
        self.assertFalse(retain_same_day_reviews(retry, {
            "total_reviews": 160, "reviews_status": "observed",
        }))
        self.assertEqual(retry["total_reviews"], 170)
