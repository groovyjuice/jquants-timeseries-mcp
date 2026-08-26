from __future__ import annotations

import csv
import io
import unittest

from jquants_client import (
    DAILY_BARS_PATH,
    MASTER_PATH,
    JQuantsClient,
    JQuantsError,
    daily_bars_to_csv,
    make_csv_filename,
    normalize_date,
)


MASTER = [
    {
        "Code": "285A0",
        "CoName": "キオクシアホールディングス",
        "CoNameEn": "Kioxia Holdings Corporation",
        "MktNm": "プライム",
    },
    {
        "Code": "83060",
        "CoName": "三菱ＵＦＪフィナンシャル・グループ",
        "CoNameEn": "Mitsubishi UFJ Financial Group, Inc.",
        "MktNm": "プライム",
    },
]


class FakeAPI:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, path: str, params: dict[str, str]):
        self.calls.append((path, dict(params)))
        if path == MASTER_PATH:
            code = params.get("code")
            if code:
                return {
                    "data": [
                        row
                        for row in MASTER
                        if row["Code"] in {code, f"{code}0"}
                    ]
                }
            return {"data": MASTER}
        if path == DAILY_BARS_PATH and "pagination_key" not in params:
            return {
                "data": [
                    {
                        "Date": "2026-01-05",
                        "Code": "285A0",
                        "O": 1000,
                        "H": 1100,
                        "L": 990,
                        "C": 1080,
                        "Vo": 12345,
                        "AdjO": 1000,
                        "AdjH": 1100,
                        "AdjL": 990,
                        "AdjC": 1080,
                        "AdjVo": 12345,
                    }
                ],
                "pagination_key": "next-page",
            }
        if path == DAILY_BARS_PATH:
            return {
                "data": [
                    {
                        "Date": "2026-01-06",
                        "Code": "285A0",
                        "O": 1085,
                        "H": 1120,
                        "L": 1070,
                        "C": 1110,
                        "Vo": 15000,
                        "AdjO": 1085,
                        "AdjH": 1120,
                        "AdjL": 1070,
                        "AdjC": 1110,
                        "AdjVo": 15000,
                    }
                ]
            }
        raise AssertionError(path)


class JQuantsClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeAPI()
        self.client = JQuantsClient("test-key", fetcher=self.api)

    def test_resolves_japanese_partial_name(self):
        matches = self.client.search_companies("キオクシア")
        self.assertEqual(matches[0].code, "285A0")
        self.assertEqual(matches[0].name, "キオクシアホールディングス")

    def test_resolves_four_character_code(self):
        matches = self.client.search_companies("8306")
        self.assertEqual([match.code for match in matches], ["83060"])
        self.assertEqual(self.api.calls[0], (MASTER_PATH, {"code": "8306"}))

    def test_paginates_and_sorts_daily_bars(self):
        rows = self.client.get_daily_bars(
            "285A0", from_date="20260101", to_date="2026-01-31"
        )
        self.assertEqual([row["Date"] for row in rows], ["2026-01-05", "2026-01-06"])
        daily_calls = [call for call in self.api.calls if call[0] == DAILY_BARS_PATH]
        self.assertEqual(daily_calls[0][1]["from"], "2026-01-01")
        self.assertEqual(daily_calls[1][1]["pagination_key"], "next-page")

    def test_csv_is_excel_friendly_and_contains_adjusted_prices(self):
        rows = self.client.get_daily_bars("285A0")
        text = daily_bars_to_csv(rows, "キオクシアホールディングス")
        self.assertTrue(text.startswith("\ufeff"))
        parsed = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))
        self.assertEqual(parsed[0]["CompanyName"], "キオクシアホールディングス")
        self.assertEqual(parsed[0]["AdjustmentClose"], "1080")

    def test_date_validation(self):
        self.assertEqual(normalize_date("20260826"), "2026-08-26")
        with self.assertRaises(JQuantsError):
            normalize_date("2026-02-30")
        with self.assertRaises(JQuantsError):
            self.client.get_daily_bars(
                "285A0", from_date="2026-02-01", to_date="2026-01-01"
            )

    def test_filename_is_safe(self):
        self.assertEqual(
            make_csv_filename("A/B:Test", "2026-01-01", "2026-01-31"),
            "JQ_A_B_Test_2026-01-01_2026-01-31.csv",
        )


if __name__ == "__main__":
    unittest.main()
