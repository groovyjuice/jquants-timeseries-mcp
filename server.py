from __future__ import annotations

import os
import re
import secrets
import time
from typing import Any, Literal

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

from closing_auction import summarize_closing_auction
from jquants_client import (
    JQuantsClient,
    JQuantsError,
    aggregate_minute_bars_30m,
    daily_bars_to_csv,
    intraday_bars_to_csv,
    minute_bars_to_csv,
    make_csv_filename,
    make_intraday_csv_filename,
    make_minute_csv_filename,
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
日本株の日足・30分足取得にはget_stock_timeseriesを使い、intervalへ
日足ならdaily、J-Quantsの1分足から30分足へ集計する場合は30mを指定する。
J-Quantsの1分足を集約せずCSV出力する場合はget_stock_1min_timeseriesを使う。
get_stock_30min_timeseriesも30分足専用の互換ツールとして利用できる。成功時はCSVの
resource_linkとembedded resourceを返す。Google Driveのupload_fileにそのCSV
ファイル参照をfile_uriとして渡し、「時系列データ」フォルダ
{DRIVE_FOLDER_REFERENCE}へアップロードする。Google Driveツールが成功を返すまで
保存済みと断定しない。ユーザーが保存不要と明示した場合だけアップロードを
省略する。銘柄候補がambiguousなら候補を示して確認し、推測で選ばない。
J-Quants Freeでは直近12週間を除く過去2年分に制限されうるため、実際の
first_date/last_dateを伝える。
APIキーやMCP接続URLの秘密部分は会話・ツール結果・ファイルへ出力しない。
クライアント側にintervalまたはget_stock_30min_timeseriesがまだ表示されない場合は、
get_stock_timeseriesのstockへ「1570 30分足」のように30分足指定を含める。
""".strip()

mcp = MCPServer(
    name="jquants-timeseries",
    title="J-Quants時系列データ",
    description="J-Quants API V2から日本株の日足・生1分足・1分足由来の30分足を取得してCSV化します。",
    instructions=SERVER_INSTRUCTIONS,
    version="1.3.0",
)


READ_ONLY = ToolAnnotations(
    title="J-Quantsの日足を取得",
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)

INTRADAY_READ_ONLY = ToolAnnotations(
    title="J-Quantsの分足を取得",
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)


@mcp.custom_route("/health", methods=["GET"])
async def health(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


@mcp.custom_route("/tmp-terra-drone-1min-278a-b4e72d91", methods=["GET"])
async def temp_terra_drone_1min(request: Request) -> Response:
    try:
        client = JQuantsClient(os.environ.get("JQUANTS_API_KEY", ""))
        candidates = client.search_companies("278A", limit=10)
        if not candidates:
            return PlainTextResponse("Terra Drone not found", status_code=404)
        best_rank = candidates[0].rank
        best = [candidate for candidate in candidates if candidate.rank == best_rank]
        if len(best) != 1:
            return PlainTextResponse("Terra Drone ambiguous", status_code=409)
        company = best[0]
        rows = client.get_minute_bars(
            company.code,
            from_date=request.query_params.get("from"),
            to_date=request.query_params.get("to"),
        )
        if not rows:
            return PlainTextResponse("No minute data", status_code=404)

        first_date = str(rows[0].get("Date") or "unknown")
        last_date = str(rows[-1].get("Date") or "unknown")
        filename = make_minute_csv_filename(company.name, first_date, last_date)
        body = minute_bars_to_csv(rows, company.name).encode("utf-8")
        safe_ascii_name = filename.encode("ascii", "ignore").decode() or "terra_drone_1min.csv"
        return Response(
            body,
            media_type="text/csv; charset=utf-8",
            headers={
                "Cache-Control": "private, no-store",
                "Content-Disposition": f'attachment; filename="{safe_ascii_name}"',
            },
        )
    except JQuantsError as exc:
        return PlainTextResponse(str(exc), status_code=502)


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


_THIRTY_MINUTE_MARKER = re.compile(
    r"(?i)(?:30\s*分(?:足)?|30\s*(?:m|min|minute)s?|分足)"
)


def _split_stock_series_query(stock: str) -> tuple[str, bool]:
    wants_30m = _THIRTY_MINUTE_MARKER.search(stock) is not None
    if not wants_30m:
        return stock, False
    cleaned = _THIRTY_MINUTE_MARKER.sub(" ", stock)
    cleaned = re.sub(r"[|/,:：、]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        raise JQuantsError("30分足を取得する銘柄名か銘柄コードも指定してな。")
    return cleaned, True


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
    series_name = str(payload.get("series_name") or "日足")

    return CallToolResult(
        content=[
            TextContent(
                text=(
                    f"{payload['company']['name']}（{payload['company']['code']}）の{series_name}を"
                    f"{payload['row_count']}件取得し、{filename}を作成したで。"
                    "次にこのCSVファイル参照をGoogle Driveのupload_fileへ渡してな。"
                )
            ),
            ResourceLink(
                name=filename,
                title=filename,
                uri=resource_uri,
                description=f"Google Drive保存用のJ-Quants {series_name}CSV（15分間有効）",
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
    title="日本株の日足・30分足データを取得",
    description=(
        "銘柄名または4/5桁の銘柄コードからJ-Quants API V2の日足または30分足を取得し、"
        "Google Driveへ保存できるUTF-8 CSVを返す。intervalは日足ならdaily、"
        "1分足を前場・後場別の30分足OHLCVへ集計するなら30mを指定する。"
        "古いクライアントではstockへ『6857 30分足』と含めても30分足になる。"
        "銘柄が曖昧なら候補だけ返す。"
    ),
    annotations=READ_ONLY,
)
def get_stock_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
    interval: Literal["daily", "30m"] = "daily",
) -> CallToolResult:
    """J-Quantsの日足または1分足由来の30分足CSVを返します。"""
    try:
        stock_query, marker_wants_30m = _split_stock_series_query(stock)
        wants_30m = interval == "30m" or marker_wants_30m
        if wants_30m:
            return get_stock_30min_timeseries(
                stock_query,
                from_date=from_date,
                to_date=to_date,
            )

        client = JQuantsClient(os.environ.get("JQUANTS_API_KEY", ""))
        candidates = client.search_companies(stock_query, limit=10)
        if not candidates:
            return _plain_result({
                "status": "not_found",
                "query": stock_query,
                "message": "一致する上場銘柄が見つからへんかったで。銘柄コードも試してな。",
                "candidates": [],
            })

        best_rank = candidates[0].rank
        best = [candidate for candidate in candidates if candidate.rank == best_rank]
        if len(best) != 1:
            return _plain_result({
                "status": "ambiguous",
                "query": stock_query,
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
            "query": stock_query,
            "company": company.public_dict(),
            "row_count": len(rows),
            "first_date": first_date,
            "last_date": last_date,
            "filename": make_csv_filename(company.name, first_date, last_date),
            "series_name": "日足",
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



@mcp.tool(
    name="get_stock_1min_timeseries",
    title="日本株の1分足データを取得",
    description=(
        "銘柄名または4/5桁の銘柄コードからJ-Quants API V2の1分足OHLCVを取得し、"
        "集計せずそのままUTF-8 CSVとして返す。分足・ティックアドオンの契約が必要。"
    ),
    annotations=INTRADAY_READ_ONLY,
)
def get_stock_1min_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
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
        rows = client.get_minute_bars(
            company.code,
            from_date=from_date,
            to_date=to_date,
        )
        if not rows:
            return _plain_result({
                "status": "no_data",
                "query": stock,
                "company": company.public_dict(),
                "message": (
                    "指定範囲で取得できる1分足がなかったで。"
                    "分足・ティックアドオンと取得期間を確認してな。"
                ),
            })

        first_date = str(rows[0].get("Date") or "unknown")
        last_date = str(rows[-1].get("Date") or "unknown")
        csv_text = minute_bars_to_csv(rows, company.name)
        warnings = [
            "J-Quantsの1分足を集計せずそのままCSV化してるで。",
            "取引がなかった1分間はJ-Quantsの返却対象外やで。",
            "分足APIには調整済み株価がないため、株式分割・併合がある期間は別途補正が必要やで。",
        ]
        payload: dict[str, Any] = {
            "status": "ok",
            "query": stock,
            "company": company.public_dict(),
            "interval_minutes": 1,
            "row_count": len(rows),
            "first_date": first_date,
            "last_date": last_date,
            "first_timestamp_jst": f"{first_date} {rows[0].get('Time') or ''}",
            "last_timestamp_jst": f"{last_date} {rows[-1].get('Time') or ''}",
            "filename": make_minute_csv_filename(
                company.name, first_date, last_date
            ),
            "series_name": "1分足",
            "mime_type": "text/csv; charset=utf-8",
            "preview_first": rows[:3],
            "preview_last": rows[-3:],
            "drive_destination": {
                "folder_id": DRIVE_FOLDER_ID,
                "folder_url": DRIVE_FOLDER_URL,
                "folder_name": "時系列データ",
            },
            "warnings": warnings,
            "source": "https://jpx-jquants.com/ja/spec/eq-bars-minute",
        }
        return _csv_result(payload, csv_text)
    except JQuantsError as exc:
        raise ToolError(str(exc)) from exc

@mcp.tool(
    name="get_stock_30min_timeseries",
    title="日本株の30分足データを取得",
    description=(
        "銘柄名または4/5桁の銘柄コードからJ-Quants API V2の1分足を取得し、"
        "東証の前場・後場ごとに30分足OHLCVへ集計して、Google Driveへ保存できる"
        "UTF-8 CSVを返す。30分足、分足、時間足CSVを求められたときに使う。"
        "分足・ティックアドオンの契約が必要。銘柄が曖昧なら候補だけ返す。"
    ),
    annotations=INTRADAY_READ_ONLY,
)
def get_stock_30min_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
    """J-Quantsの1分足を30分足へ集計。stockに「1分足」があれば生1分足CSVを返す。"""
    try:
        wants_raw_1m = re.search(r"(?:1\\s*分(?:足)?|1\\s*(?:m|min|minute)s?)", stock, re.I) is not None
        stock_query = re.sub(
            r"(?i)(?:1\\s*分(?:足)?|1\\s*(?:m|min|minute)s?)",
            " ",
            stock,
        )
        stock_query = re.sub(r"[|/,:：、]+", " ", stock_query)
        stock_query = re.sub(r"\\s+", " ", stock_query).strip() or stock.strip()

        client = JQuantsClient(os.environ.get("JQUANTS_API_KEY", ""))
        candidates = client.search_companies(stock_query, limit=10)
        if not candidates:
            return _plain_result({
                "status": "not_found",
                "query": stock_query,
                "message": "一致する上場銘柄が見つからへんかったで。銘柄コードも試してな。",
                "candidates": [],
            })

        best_rank = candidates[0].rank
        best = [candidate for candidate in candidates if candidate.rank == best_rank]
        if len(best) != 1:
            return _plain_result({
                "status": "ambiguous",
                "query": stock_query,
                "message": "候補が複数あるため、銘柄コードを選んでな。",
                "candidates": [candidate.public_dict() for candidate in best],
            })

        company = best[0]
        minute_rows = client.get_minute_bars(
            company.code,
            from_date=from_date,
            to_date=to_date,
        )
        if not minute_rows:
            return _plain_result({
                "status": "no_data",
                "query": stock_query,
                "company": company.public_dict(),
                "message": (
                    "指定範囲で取得できる1分足がなかったで。"
                    "分足・ティックアドオンと取得期間を確認してな。"
                ),
            })

        if wants_raw_1m:
            first_date = str(minute_rows[0].get("Date") or "unknown")
            last_date = str(minute_rows[-1].get("Date") or "unknown")
            csv_text = minute_bars_to_csv(minute_rows, company.name)
            payload: dict[str, Any] = {
                "status": "ok",
                "query": stock_query,
                "company": company.public_dict(),
                "interval_minutes": 1,
                "row_count": len(minute_rows),
                "first_date": first_date,
                "last_date": last_date,
                "first_timestamp_jst": f"{first_date} {minute_rows[0].get('Time') or ''}",
                "last_timestamp_jst": f"{last_date} {minute_rows[-1].get('Time') or ''}",
                "filename": make_minute_csv_filename(
                    company.name, first_date, last_date
                ),
                "series_name": "1分足",
                "mime_type": "text/csv; charset=utf-8",
                "preview_first": minute_rows[:3],
                "preview_last": minute_rows[-3:],
                "drive_destination": {
                    "folder_id": DRIVE_FOLDER_ID,
                    "folder_url": DRIVE_FOLDER_URL,
                    "folder_name": "時系列データ",
                },
                "warnings": [
                    "J-Quantsの1分足を集計せずそのままCSV化してるで。",
                    "取引がなかった1分間はJ-Quantsの返却対象外やで。",
                    "分足APIには調整済み株価がないため、株式分割・併合がある期間は別途補正が必要やで。",
                ],
                "source": "https://jpx-jquants.com/ja/spec/eq-bars-minute",
            }
            return _csv_result(payload, csv_text)

        rows = aggregate_minute_bars_30m(minute_rows)
        if not rows:
            return _plain_result({
                "status": "no_data",
                "query": stock_query,
                "company": company.public_dict(),
                "message": "通常取引時間内で30分足に集計できる分足がなかったで。",
            })

        first_date = str(rows[0]["Date"])
        last_date = str(rows[-1]["Date"])
        requested_to = normalize_date(to_date)
        warnings = [
            "分足APIには調整済み株価がないため、株式分割・併合がある期間は別途補正が必要やで。",
            "取引がなかった1分間はJ-Quantsの返却対象外やで。SourceMinuteCountで各30分足の構成分数を確認できるで。",
        ]
        if requested_to and last_date < requested_to:
            warnings.append(
                "指定した終了日より取得最終日が古いで。休場日、更新時刻またはプランの期間制限を確認してな。"
            )

        csv_text = intraday_bars_to_csv(rows, company.name)
        payload: dict[str, Any] = {
            "status": "ok",
            "query": stock_query,
            "company": company.public_dict(),
            "interval_minutes": 30,
            "raw_minute_row_count": len(minute_rows),
            "row_count": len(rows),
            "first_date": first_date,
            "last_date": last_date,
            "first_timestamp_jst": f"{first_date} {rows[0]['StartTimeJST']}",
            "last_timestamp_jst": f"{last_date} {rows[-1]['StartTimeJST']}",
            "filename": make_intraday_csv_filename(
                company.name, 30, first_date, last_date
            ),
            "series_name": "30分足",
            "mime_type": "text/csv; charset=utf-8",
            "preview_first": rows[:3],
            "preview_last": rows[-3:],
            "session_definition_jst": {
                "morning": "09:00-11:30",
                "afternoon": "12:30-15:30",
                "closing_auction": "11:30と15:30の約定は直前の30分足に含む",
            },
            "drive_destination": {
                "folder_id": DRIVE_FOLDER_ID,
                "folder_url": DRIVE_FOLDER_URL,
                "folder_name": "時系列データ",
            },
            "warnings": warnings,
            "source": "https://jpx-jquants.com/ja/spec/eq-bars-minute",
        }
        return _csv_result(payload, csv_text)
    except JQuantsError as exc:
        raise ToolError(str(exc)) from exc


@mcp.tool(
    name="analyze_closing_auction_gap",
    title="大引けクロージングオークションと翌朝ギャップを分析",
    description=(
        "J-Quants API V2の1分足を使い、15:30のクロージングオークション約定が"
        "直前の最終約定から上に跳ねた日・下に落ちた日で、翌営業日寄り付きまでの"
        "夜間ギャップ平均・中央値・勝率・単利合計・相関を比較する。"
    ),
    annotations=INTRADAY_READ_ONLY,
)
def analyze_closing_auction_gap(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
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
        minute_rows = client.get_minute_bars(
            company.code,
            from_date=from_date,
            to_date=to_date,
        )
        if not minute_rows:
            return _plain_result({
                "status": "no_data",
                "query": stock,
                "company": company.public_dict(),
                "message": "指定範囲で取得できる1分足がなかったで。",
            })

        summary = summarize_closing_auction(minute_rows)
        payload = {
            "status": "ok",
            "query": stock,
            "company": company.public_dict(),
            "raw_minute_row_count": len(minute_rows),
            "first_date": str(minute_rows[0].get("Date") or ""),
            "last_date": str(minute_rows[-1].get("Date") or ""),
            **summary,
            "source": "https://jpx-jquants.com/ja/spec/eq-bars-minute",
        }
        return CallToolResult(
            content=[TextContent(text=f"{company.name}のクロージングオークションと翌朝ギャップを集計したで。")],
            structuredContent=payload,
        )
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
