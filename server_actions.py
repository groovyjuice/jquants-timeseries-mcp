from __future__ import annotations

import os
import re
from typing import Any, Literal

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from starlette.requests import Request
from starlette.responses import PlainTextResponse


ACTIONS_REPOSITORY = "groovyjuice/jquants-timeseries-mcp"
ACTIONS_ISSUE_PREFIX = "[jquants]"
DRIVE_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip()
DRIVE_FOLDER_URL = (
    f"https://drive.google.com/drive/folders/{DRIVE_FOLDER_ID}"
    if DRIVE_FOLDER_ID
    else ""
)

SERVER_INSTRUCTIONS = f"""
このMCPはJ-Quants APIをRenderから直接呼ばない。日足・1分足・30分足の取得依頼を
GitHub Actions用リクエストへ変換して返すルーターとして使う。

tool結果のstatusがgithub_actions_requiredなら、接続済みGitHubコネクタで必ず
repository={ACTIONS_REPOSITORY} にissueを作成する。titleとbodyはtool結果の
github_actions_request.issue_title / issue_bodyをそのまま使い、内容を変更しない。
このissueで .github/workflows/jquants-to-drive.yml が起動し、J-Quants APIからCSVを取得して
Google Driveの「時系列データ」フォルダへ直接保存する。

issueが閉じたらコメントを確認し、「✅ J-Quants → Google Drive 保存完了」があれば成功。
コメントに出たCSV名をGoogle Driveで確認し、必要ならそのCSVを読んで分析する。
GitHub Actionsが失敗した場合はActionsログを確認し、RenderからJ-Quants APIを直接叩く経路へ
勝手にフォールバックしない。

1分足はget_stock_1min_timeseriesを使う。古いクライアントでこのtoolが表示されない場合は
get_stock_30min_timeseriesのstockへ「3103 1分足」のように指定すれば1mとしてルーティングする。
日足・30分足はget_stock_timeseriesを使える。保存先folder_id={DRIVE_FOLDER_ID or '未設定'}。
APIキーやMCP接続URLの秘密部分は会話・tool結果へ出力しない。
""".strip()

mcp = MCPServer(
    name="jquants-timeseries",
    title="J-Quants時系列データ（GitHub Actions経路）",
    description=(
        "日本株の日足・1分足・30分足の取得依頼をGitHub Actionsへルーティングし、"
        "J-Quantsから取得したCSVをGoogle Driveへ保存するためのリクエストを返します。"
    ),
    instructions=SERVER_INSTRUCTIONS,
    version="2.0.0",
)

READ_ONLY = ToolAnnotations(
    title="GitHub Actions経由でJ-Quants取得を依頼",
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)


@mcp.custom_route("/health", methods=["GET"])
async def health(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok-actions-router")


_ONE_MINUTE_MARKER = re.compile(
    r"(?i)(?:1\s*分(?:足)?|1\s*(?:m|min|minute)s?)"
)
_THIRTY_MINUTE_MARKER = re.compile(
    r"(?i)(?:30\s*分(?:足)?|30\s*(?:m|min|minute)s?|分足)"
)


def _clean_stock(stock: str, *patterns: re.Pattern[str]) -> str:
    cleaned = stock
    for pattern in patterns:
        cleaned = pattern.sub(" ", cleaned)
    cleaned = re.sub(r"[|/,:：、]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _request_result(
    *,
    stock: str,
    interval: Literal["daily", "1m", "30m"],
    from_date: str | None,
    to_date: str | None,
    postprocess: str | None = None,
) -> CallToolResult:
    stock = stock.strip()
    if not stock:
        payload = {
            "status": "invalid_request",
            "message": "銘柄名か銘柄コードを指定してな。",
        }
        return CallToolResult(
            content=[TextContent(text=payload["message"])],
            structuredContent=payload,
        )

    from_value = (from_date or "").strip()
    to_value = (to_date or "").strip()
    filename_mode = "dated" if (from_value or to_value) else "stable"

    issue_title = f"{ACTIONS_ISSUE_PREFIX} {stock} {interval}"
    issue_body = "\n".join(
        [
            f"stock: {stock}",
            f"interval: {interval}",
            f"from_date: {from_value}",
            f"to_date: {to_value}",
            f"filename_mode: {filename_mode}",
        ]
    )

    payload: dict[str, Any] = {
        "status": "github_actions_required",
        "message": (
            f"{stock} の{interval}取得はGitHub Actions経路で実行してな。"
            "下のissue_title / issue_bodyをそのままGitHubへ渡せば、CSVはDriveへ直接保存されるで。"
        ),
        "query": stock,
        "interval": interval,
        "from_date": from_value or None,
        "to_date": to_value or None,
        "github_actions_request": {
            "repository": ACTIONS_REPOSITORY,
            "workflow": ".github/workflows/jquants-to-drive.yml",
            "trigger": "issue",
            "issue_title": issue_title,
            "issue_body": issue_body,
        },
        "drive_destination": {
            "folder_id": DRIVE_FOLDER_ID,
            "folder_url": DRIVE_FOLDER_URL,
            "folder_name": "時系列データ",
        },
        "next_steps": [
            "GitHubコネクタで指定issueを作成する",
            "issueが閉じたらbotコメントで成功/失敗を確認する",
            "成功コメントのCSV名をGoogle Driveの時系列データから取得する",
        ],
        "execution_path": "ChatGPT -> GitHub issue -> GitHub Actions -> J-Quants -> Google Drive",
    }
    if postprocess:
        payload["postprocess"] = postprocess
        payload["next_steps"].append(
            "Drive保存後の1分足CSVを読み込み、指定された後処理を実行する"
        )

    return CallToolResult(
        content=[TextContent(text=payload["message"])],
        structuredContent=payload,
    )


@mcp.tool(
    name="get_stock_timeseries",
    title="日本株の日足・30分足データをGitHub Actions経由で取得",
    description=(
        "銘柄名または4/5桁の銘柄コードから、GitHub Actions経由でJ-Quantsの日足または30分足CSVを"
        "Google Driveへ保存するための実行リクエストを返す。intervalはdailyまたは30m。"
        "stockに『30分足』を含めても30mとして扱う。"
    ),
    annotations=READ_ONLY,
)
def get_stock_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
    interval: Literal["daily", "30m"] = "daily",
) -> CallToolResult:
    marker_30m = _THIRTY_MINUTE_MARKER.search(stock) is not None
    marker_1m = _ONE_MINUTE_MARKER.search(stock) is not None
    if marker_1m:
        stock_query = _clean_stock(stock, _ONE_MINUTE_MARKER, _THIRTY_MINUTE_MARKER)
        return _request_result(
            stock=stock_query,
            interval="1m",
            from_date=from_date,
            to_date=to_date,
        )
    stock_query = _clean_stock(stock, _THIRTY_MINUTE_MARKER) if marker_30m else stock.strip()
    resolved_interval: Literal["daily", "30m"] = "30m" if (interval == "30m" or marker_30m) else "daily"
    return _request_result(
        stock=stock_query,
        interval=resolved_interval,
        from_date=from_date,
        to_date=to_date,
    )


@mcp.tool(
    name="get_stock_1min_timeseries",
    title="日本株の1分足データをGitHub Actions経由で取得",
    description=(
        "銘柄名または4/5桁の銘柄コードから、GitHub Actions経由でJ-Quantsの生1分足CSVを"
        "Google Driveへ直接保存するための実行リクエストを返す。"
    ),
    annotations=READ_ONLY,
)
def get_stock_1min_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
    stock_query = _clean_stock(stock, _ONE_MINUTE_MARKER, _THIRTY_MINUTE_MARKER)
    return _request_result(
        stock=stock_query,
        interval="1m",
        from_date=from_date,
        to_date=to_date,
    )


@mcp.tool(
    name="get_stock_30min_timeseries",
    title="日本株の30分足データをGitHub Actions経由で取得",
    description=(
        "GitHub Actions経由でJ-Quantsの1分足を取得し30分足へ集計してDriveへ保存する。"
        "互換性のためstockに『1分足』が含まれる場合は生1分足CSVとしてルーティングする。"
    ),
    annotations=READ_ONLY,
)
def get_stock_30min_timeseries(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
    wants_1m = _ONE_MINUTE_MARKER.search(stock) is not None
    stock_query = _clean_stock(stock, _ONE_MINUTE_MARKER, _THIRTY_MINUTE_MARKER)
    return _request_result(
        stock=stock_query,
        interval="1m" if wants_1m else "30m",
        from_date=from_date,
        to_date=to_date,
    )


@mcp.tool(
    name="analyze_closing_auction_gap",
    title="クロージングオークション分析用1分足をGitHub Actions経由で取得",
    description=(
        "クロージングオークションと翌朝ギャップ分析に必要な1分足CSVをGitHub Actions経由で"
        "Google Driveへ保存するための実行リクエストを返す。CSV保存後に分析する。"
    ),
    annotations=READ_ONLY,
)
def analyze_closing_auction_gap(
    stock: str,
    from_date: str | None = None,
    to_date: str | None = None,
) -> CallToolResult:
    stock_query = _clean_stock(stock, _ONE_MINUTE_MARKER, _THIRTY_MINUTE_MARKER)
    return _request_result(
        stock=stock_query,
        interval="1m",
        from_date=from_date,
        to_date=to_date,
        postprocess="analyze_closing_auction_gap",
    )


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
