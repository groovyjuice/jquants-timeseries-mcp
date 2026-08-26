from __future__ import annotations

import os
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from jquants_client import (
    JQuantsClient,
    JQuantsError,
    daily_bars_to_csv,
    make_csv_filename,
    normalize_date,
)


DRIVE_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip()
DRIVE_FOLDER_URL = (
    f"https://drive.google.com/drive/folders/{DRIVE_FOLDER_ID}"
    if DRIVE_FOLDER_ID
    else ""
)
DRIVE_FOLDER_REFERENCE = (
    f"（folder_id={DRIVE_FOLDER_ID}）" if DRIVE_FOLDER_ID else ""
)

SERVER_INSTRUCTIONS = f"""
日本株の時系列データ取得にはget_stock_timeseriesを使う。成功時は返された
csv_textを返されたfilenameでCSVファイルとして保存し、Google Driveの
「時系列データ」フォルダ{DRIVE_FOLDER_REFERENCE}へアップロードする。
ユーザーが保存不要と明示した場合だけアップロードを省略する。銘柄候補が
ambiguousなら候補を示して確認し、推測で選ばない。J-Quants Freeでは直近
12週間を除く過去2年分に制限されうるため、実際のfirst_date/last_dateを伝える。
APIキーやMCP接続URLの秘密部分は会話・ツール結果・ファイルへ出力しない。
""".strip()

mcp = MCPServer(
    name="jquants-timeseries",
    title="J-Quants時系列データ",
    description="J-Quants API V2から日本株の日足を取得してCSV化します。",
    instructions=SERVER_INSTRUCTIONS,
    version="1.0.0",
)


READ_ONLY = ToolAnnotations(
    title="J-Quantsの日足を取得",
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)


@mcp.custom_route("/health", methods=["GET"])
async def health(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


@mcp.tool(
    name="get_stock_timeseries",
    title="日本株の時系列データを取得",
    description=(
        "銘柄名または4/5桁の銘柄コードからJ-Quants API V2の日足を取得し、"
        "Google Driveへ保存できるUTF-8 CSVを返す。日本株の時系列データ、"
        "OHLCV、日足CSVを求められたときに使う。銘柄が曖昧なら候補だけ返す。"
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def get_stock_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict[str, Any]:
    """J-Quantsの日足を取得し、CSV本文と保存先情報を返します。"""
    try:
        client = JQuantsClient(os.environ.get("JQUANTS_API_KEY", ""))
        candidates = client.search_companies(stock, limit=10)
        if not candidates:
            return {
                "status": "not_found",
                "query": stock,
                "message": "一致する上場銘柄が見つからへんかったで。銘柄コードも試してな。",
                "candidates": [],
            }

        best_rank = candidates[0].rank
        best = [candidate for candidate in candidates if candidate.rank == best_rank]
        if len(best) != 1:
            return {
                "status": "ambiguous",
                "query": stock,
                "message": "候補が複数あるため、銘柄コードを選んでな。",
                "candidates": [candidate.public_dict() for candidate in best],
            }

        company = best[0]
        rows = client.get_daily_bars(
            company.code,
            from_date=from_date,
            to_date=to_date,
        )
        if not rows:
            return {
                "status": "no_data",
                "query": stock,
                "company": company.public_dict(),
                "message": "指定範囲で取得できる日足がなかったで。プランの期間制限も確認してな。",
            }

        first_date = str(rows[0].get("Date") or "unknown")
        last_date = str(rows[-1].get("Date") or "unknown")
        csv_text = daily_bars_to_csv(rows, company.name)
        requested_to = normalize_date(to_date)
        warnings: list[str] = []
        if requested_to and last_date != "unknown" and last_date < requested_to:
            warnings.append(
                "指定した終了日より取得最終日が古いで。休場日またはプランの遅延・期間制限を確認してな。"
            )

        return {
            "status": "ok",
            "query": stock,
            "company": company.public_dict(),
            "row_count": len(rows),
            "first_date": first_date,
            "last_date": last_date,
            "filename": make_csv_filename(company.name, first_date, last_date),
            "mime_type": "text/csv; charset=utf-8",
            "csv_text": csv_text,
            "preview_first": rows[:3],
            "preview_last": rows[-3:],
            "drive_destination": {
                "folder_id": DRIVE_FOLDER_ID,
                "folder_url": DRIVE_FOLDER_URL,
                "folder_name": "時系列データ",
            },
            "warnings": warnings,
            "source": "https://jpx-jquants.com/ja/spec/eq-bars-daily",
        }
    except JQuantsError as exc:
        raise ToolError(str(exc)) from exc


def _transport_security() -> TransportSecuritySettings:
    external_host = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "").strip()
    allowed_hosts = ["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*"]
    if external_host:
        allowed_hosts.extend([external_host, f"{external_host}:*"])
    return TransportSecuritySettings(
        allowed_hosts=allowed_hosts,
        allowed_origins=["https://chatgpt.com"],
    )


def main() -> None:
    access_token = os.environ.get("MCP_ACCESS_TOKEN", "").strip()
    if len(access_token) < 32:
        raise RuntimeError("MCP_ACCESS_TOKENは32文字以上の秘密文字列にしてな。")
    if not DRIVE_FOLDER_ID:
        raise RuntimeError("GOOGLE_DRIVE_FOLDER_IDを設定してな。")
    port = int(os.environ.get("PORT", "8000"))
    mcp.run(
        transport="streamable-http",
        host="0.0.0.0",
        port=port,
        streamable_http_path=f"/mcp/{access_token}",
        stateless_http=True,
        json_response=True,
        transport_security=_transport_security(),
    )


if __name__ == "__main__":
    main()
