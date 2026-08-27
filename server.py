from __future__ import annotations

import os
import secrets
import time
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import (
    CallToolResult,
    EmbeddedResource,
    ResourceLink,
    TextContent,
    TextResourceContents,
    ToolAnnotations,
)
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

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
DOWNLOAD_TTL_SECONDS = 15 * 60
_downloads: dict[str, tuple[float, str, bytes]] = {}

SERVER_INSTRUCTIONS = f"""
日本株の時系列データ取得にはget_stock_timeseriesを使う。成功時はCSVの
resource_linkとembedded resourceを返す。Google Driveのupload_fileにそのCSV
ファイル参照をfile_uriとして渡し、「時系列データ」フォルダ
{DRIVE_FOLDER_REFERENCE}へアップロードする。Google Driveツールが成功を返すまで
保存済みと断定しない。ユーザーが保存不要と明示した場合だけアップロードを
省略する。銘柄候補がambiguousなら候補を示して確認し、推測で選ばない。
J-Quants Freeでは直近12週間を除く過去2年分に制限されうるため、実際の
first_date/last_dateを伝える。
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


@mcp.custom_route("/download/{download_id}", methods=["GET"])
async def download_csv(request: Request) -> Response:
    now = time.monotonic()
    for key, (expires_at, _, _) in list(_downloads.items()):
        if expires_at <= now:
            _downloads.pop(key, None)

    download_id = request.path_params["download_id"]
    item = _downloads.get(download_id)
    if item is None or item[0] <= now:
        return PlainTextResponse("このCSVリンクは期限切れやで。", status_code=404)

    _, filename, body = item
    safe_ascii_name = filename.encode("ascii", "ignore").decode() or "jquants.csv"
    return Response(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'attachment; filename="{safe_ascii_name}"',
        },
    )


def _plain_result(payload: dict[str, Any]) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(text=str(payload.get("message") or payload["status"]))],
        structuredContent=payload,
    )


def _csv_result(payload: dict[str, Any], csv_text: str) -> CallToolResult:
    filename = str(payload["filename"])
    body = csv_text.encode("utf-8")
    download_id = secrets.token_urlsafe(32)
    _downloads[download_id] = (
        time.monotonic() + DOWNLOAD_TTL_SECONDS,
        filename,
        body,
    )
    external_host = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "").strip()
    resource_uri = (
        f"https://{external_host}/download/{download_id}"
        if external_host
        else f"file:///{filename}"
    )
    payload["file_url"] = resource_uri

    return CallToolResult(
        content=[
            TextContent(
                text=(
                    f"{payload['company']['name']}（{payload['company']['code']}）の日足を"
                    f"{payload['row_count']}件取得し、{filename}を作成したで。"
                    "次にこのCSVファイル参照をGoogle Driveのupload_fileへ渡してな。"
                )
            ),
            ResourceLink(
                name=filename,
                title=filename,
                uri=resource_uri,
                description="Google Drive保存用のJ-Quants日足CSV（15分間有効）",
                mimeType="text/csv; charset=utf-8",
                size=len(body),
            ),
            EmbeddedResource(
                resource=TextResourceContents(
                    uri=resource_uri,
                    mimeType="text/csv; charset=utf-8",
                    text=csv_text,
                )
            ),
        ],
        structuredContent=payload,
    )


@mcp.tool(
    name="get_stock_timeseries",
    title="日本株の時系列データを取得",
    description=(
        "銘柄名または4/5桁の銘柄コードからJ-Quants API V2の日足を取得し、"
        "Google Driveへ保存できるUTF-8 CSVを返す。日本株の時系列データ、"
        "OHLCV、日足CSVを求められたときに使う。銘柄が曖昧なら候補だけ返す。"
    ),
    annotations=READ_ONLY,
)
def get_stock_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
    """J-Quantsの日足を取得し、CSVファイル参照と保存先情報を返します。"""
    try:
        client = JQuantsClient(os.environ.get("JQUANTS_API_KEY", ""))
        candidates = client.search_companies(stock, limit=10)
        if not candidates:
            return _plain_result({
                "status": "not_found",
                "query": stock,
                "message": "一致する上場銘柄が見つからへんかったで。銘柄コードも試してな。",
                "candidates": [],
            })

        best_rank = candidates[0].rank
        best = [candidate for candidate in candidates if candidate.rank == best_rank]
        if len(best) != 1:
            return _plain_result({
                "status": "ambiguous",
                "query": stock,
                "message": "候補が複数あるため、銘柄コードを選んでな。",
                "candidates": [candidate.public_dict() for candidate in best],
            })

        company = best[0]
        rows = client.get_daily_bars(
            company.code,
            from_date=from_date,
            to_date=to_date,
        )
        if not rows:
            return _plain_result({
                "status": "no_data",
                "query": stock,
                "company": company.public_dict(),
                "message": "指定範囲で取得できる日足がなかったで。プランの期間制限も確認してな。",
            })

        first_date = str(rows[0].get("Date") or "unknown")
        last_date = str(rows[-1].get("Date") or "unknown")
        csv_text = daily_bars_to_csv(rows, company.name)
        requested_to = normalize_date(to_date)
        warnings: list[str] = []
        if requested_to and last_date != "unknown" and last_date < requested_to:
            warnings.append(
                "指定した終了日より取得最終日が古いで。休場日またはプランの遅延・期間制限を確認してな。"
            )

        payload: dict[str, Any] = {
            "status": "ok",
            "query": stock,
            "company": company.public_dict(),
            "row_count": len(rows),
            "first_date": first_date,
            "last_date": last_date,
            "filename": make_csv_filename(company.name, first_date, last_date),
            "mime_type": "text/csv; charset=utf-8",
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
        return _csv_result(payload, csv_text)
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
