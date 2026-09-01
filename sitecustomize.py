from __future__ import annotations

import os
import secrets

from mcp.server import MCPServer
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

from jquants_client import (
    JQuantsClient,
    aggregate_minute_bars_30m,
    intraday_bars_to_csv,
)

_original_run = MCPServer.run


def _patched_run(self, *args, **kwargs):
    @self.custom_route("/temp-export", methods=["GET"])
    async def temp_export(request: Request):
        expected = os.environ.get("TEMP_EXPORT_TOKEN", "").strip()
        supplied = request.query_params.get("token", "")
        if not expected or not secrets.compare_digest(supplied, expected):
            return PlainTextResponse("forbidden", status_code=403)

        stock = request.query_params.get("stock", "5803").strip()
        from_date = request.query_params.get("from", "").strip() or None
        to_date = request.query_params.get("to", "").strip() or None

        try:
            client = JQuantsClient(os.environ.get("JQUANTS_API_KEY", ""))
            candidates = client.search_companies(stock, limit=10)
            if not candidates:
                return PlainTextResponse("stock not found", status_code=404)
            best_rank = candidates[0].rank
            best = [c for c in candidates if c.rank == best_rank]
            if len(best) != 1:
                return PlainTextResponse("ambiguous stock", status_code=409)

            company = best[0]
            minute_rows = client.get_minute_bars(
                company.code,
                from_date=from_date,
                to_date=to_date,
            )
            if not minute_rows:
                return PlainTextResponse("no minute data", status_code=404)

            rows = aggregate_minute_bars_30m(minute_rows)
            if not rows:
                return PlainTextResponse("no aggregated data", status_code=404)

            csv_text = intraday_bars_to_csv(rows, company.name)
            return Response(
                csv_text.encode("utf-8"),
                media_type="text/csv; charset=utf-8",
                headers={
                    "Cache-Control": "private, no-store",
                    "X-Company-Code": str(company.code),
                    "X-First-Date": str(rows[0]["Date"]),
                    "X-Last-Date": str(rows[-1]["Date"]),
                    "X-Row-Count": str(len(rows)),
                },
            )
        except Exception as exc:
            return PlainTextResponse(
                f"{type(exc).__name__}: {exc}", status_code=500
            )

    return _original_run(self, *args, **kwargs)


MCPServer.run = _patched_run
