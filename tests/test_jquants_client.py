from __future__ import annotations

import csv
import io
import unittest

from jquants_client import (
    DAILY_BARS_PATH,
    MASTER_PATH,
    MINUTE_BARS_PATH,
    JQuantsClient,
    JQuantsError,
    aggregate_minute_bars_30m,
    daily_bars_to_csv,
    intraday_bars_to_csv,
    make_csv_filename,
    make_intraday_csv_filename,
    make_minute_csv_filename,
    minute_bars_to_csv,
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
        if path == MINUTE_BARS_PATH and "pagination_key" not in params:
            return {
                "data": [
                    {
                        "Date": "2026-01-05",
                        "Time": "09:29",
                        "Code": "285A0",
                        "O": 1010,
                        "H": 1030,
                        "L": 1005,
                        "C": 1025,
                        "Vo": 200,
                        "Va": 204000,
                    },
                    {
                        "Date": "2026-01-05",
                        "Time": "09:00",
                        "Code": "285A0",
                        "O": 1000,
                        "H": 1020,
                        "L": 990,
                        "C": 1010,
                        "Vo": 100,
                        "Va": 100500,
                    },
                ],
                "pagination_key": "minute-next",
            }
        if path == MINUTE_BARS_PATH:
            return {
                "data": [
                    {
                        "Date": "2026-01-05",
                        "Time": "09:30",
                        "Code": "285A0",
                        "O": 1025,
                        "H": 1040,
                        "L": 1020,
                        "C": 1035,
                        "Vo": 300,
                        "Va": 309000,
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

    def test_paginates_and_sorts_minute_bars(self):
        rows = self.client.get_minute_bars(
            "285A0", from_date="20260101", to_date="2026-01-31"
        )
        self.assertEqual(
            [row["Time"] for row in rows], ["09:00", "09:29", "09:30"]
        )
        minute_calls = [call for call in self.api.calls if call[0] == MINUTE_BARS_PATH]
        self.assertEqual(minute_calls[0][1]["from"], "2026-01-01")
        self.assertEqual(minute_calls[1][1]["pagination_key"], "minute-next")

    def test_aggregates_30m_without_crossing_lunch_break(self):
        rows = [
            {"Date": "2026-01-05", "Time": "09:00", "Code": "285A0", "O": 100, "H": 102, "L": 99, "C": 101, "Vo": 10, "Va": 1000},
            {"Date": "2026-01-05", "Time": "09:29", "Code": "285A0", "O": 101, "H": 105, "L": 100, "C": 104, "Vo": 20, "Va": 2000},
            {"Date": "2026-01-05", "Time": "09:30", "Code": "285A0", "O": 104, "H": 106, "L": 103, "C": 105, "Vo": 30, "Va": 3000},
            {"Date": "2026-01-05", "Time": "11:30", "Code": "285A0", "O": 108, "H": 109, "L": 107, "C": 109, "Vo": 40, "Va": 4000},
            {"Date": "2026-01-05", "Time": "12:30", "Code": "285A0", "O": 110, "H": 112, "L": 109, "C": 111, "Vo": 50, "Va": 5000},
            {"Date": "2026-01-05", "Time": "15:30", "Code": "285A0", "O": 115, "H": 116, "L": 114, "C": 116, "Vo": 60, "Va": 6000},
        ]
        bars = aggregate_minute_bars_30m(rows)
        self.assertEqual(
            [bar["StartTimeJST"] for bar in bars],
            ["09:00", "09:30", "11:00", "12:30", "15:00"],
        )
        self.assertEqual(bars[0]["O"], 100)
        self.assertEqual(bars[0]["H"], 105)
        self.assertEqual(bars[0]["L"], 99)
        self.assertEqual(bars[0]["C"], 104)
        self.assertEqual(bars[0]["Vo"], 30)
        self.assertEqual(bars[0]["SourceMinuteCount"], 2)
        self.assertEqual(bars[2]["EndTimeJST"], "11:30")
        self.assertEqual(bars[-1]["EndTimeJST"], "15:30")

    def test_intraday_csv_and_filename(self):
        bars = aggregate_minute_bars_30m(
            [{"Date": "2026-01-05", "Time": "09:00", "Code": "285A0", "O": 100, "H": 102, "L": 99, "C": 101, "Vo": 10, "Va": 1000}]
        )
        text = intraday_bars_to_csv(bars, "キオクシアホールディングス")
        parsed = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))
        self.assertEqual(parsed[0]["StartTimeJST"], "09:00")
        self.assertEqual(parsed[0]["CompanyName"], "キオクシアホールディングス")
        self.assertEqual(
            make_intraday_csv_filename(
                "キオクシアホールディングス", 30, "2026-01-05", "2026-01-06"
            ),
            "JQ_キオクシアホールディングス_30min_2026-01-05_2026-01-06.csv",
        )

    def test_minute_csv_preserves_one_minute_rows_and_filename(self):
        rows = self.client.get_minute_bars("285A0")
        text = minute_bars_to_csv(rows, "キオクシアホールディングス")
        parsed = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))
        self.assertEqual(
            [row["TimeJST"] for row in parsed],
            ["09:00", "09:29", "09:30"],
        )
        self.assertEqual(parsed[0]["CompanyName"], "キオクシアホールディングス")
        self.assertEqual(
            make_minute_csv_filename(
                "キオクシアホールディングス",
                "2026-01-05",
                "2026-01-06",
            ),
            "JQ_キオクシアホールディングス_1min_2026-01-05_2026-01-06.csv",
        )

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
