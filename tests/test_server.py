from __future__ import annotations

import os
import unittest
from unittest.mock import Mock
from unittest.mock import patch

from mcp_types import EmbeddedResource, ResourceLink

import server


class ServerResultTests(unittest.TestCase):
    def tearDown(self) -> None:
        server._downloads.clear()

    def test_csv_result_exposes_file_resource_without_copying_csv_to_json(self):
        payload = {
            "status": "ok",
            "company": {"name": "テスト株式会社", "code": "12340"},
            "row_count": 1,
            "filename": "JQ_テスト株式会社_2026-01-05_2026-01-05.csv",
        }
        csv_text = "\ufeffDate,Code\r\n2026-01-05,12340\r\n"

        with patch.dict(
            os.environ,
            {"RENDER_EXTERNAL_HOSTNAME": "example.onrender.com"},
        ):
            result = server._csv_result(payload, csv_text)

        links = [item for item in result.content if isinstance(item, ResourceLink)]
        resources = [
            item for item in result.content if isinstance(item, EmbeddedResource)
        ]
        self.assertEqual(len(links), 1)
        self.assertEqual(len(resources), 1)
        self.assertTrue(links[0].uri.startswith("https://example.onrender.com/download/"))
        self.assertEqual(resources[0].resource.text, csv_text)
        self.assertNotIn("csv_text", result.structured_content)
        self.assertEqual(result.structured_content["file_url"], links[0].uri)
        self.assertEqual(len(server._downloads), 1)

    def test_plain_result_preserves_structured_status(self):
        result = server._plain_result(
            {"status": "not_found", "message": "見つからへんかったで。"}
        )
        self.assertEqual(result.structured_content["status"], "not_found")
        self.assertEqual(result.content[0].text, "見つからへんかったで。")

    def test_daily_tool_routes_30m_marker_to_intraday_tool(self):
        expected = Mock()
        with patch.object(
            server,
            "get_stock_30min_timeseries",
            return_value=expected,
        ) as intraday:
            result = server.get_stock_timeseries("1570 30分足")

        self.assertIs(result, expected)
        intraday.assert_called_once_with(
            "1570",
            from_date=None,
            to_date=None,
        )

    def test_30m_marker_requires_stock(self):
        with self.assertRaises(server.ToolError):
            server.get_stock_timeseries("30分足")

    def test_csv_result_uses_intraday_series_name(self):
        payload = {
            "status": "ok",
            "company": {"name": "テスト株式会社", "code": "12340"},
            "row_count": 2,
            "filename": "JQ_テスト株式会社_30min_2026-01-05_2026-01-05.csv",
            "series_name": "30分足",
        }
        csv_text = "\ufeffDate,StartTimeJST\r\n2026-01-05,09:00\r\n"

        with patch.dict(
            os.environ,
            {"RENDER_EXTERNAL_HOSTNAME": "example.onrender.com"},
        ):
            result = server._csv_result(payload, csv_text)

        self.assertIn("30分足を2件取得", result.content[0].text)


if __name__ == "__main__":
    unittest.main()
