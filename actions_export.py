from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from jquants_client import (
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
    sanitize_filename_component,
)

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"


class ExportError(RuntimeError):
    pass


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ExportError(f"{name} が設定されてへんで。")
    return value


def _read_json_response(request: Request, timeout: float = 60.0) -> dict[str, Any]:
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        safe_detail = detail[:500].replace("\n", " ")
        raise ExportError(
            f"Google API が HTTP {exc.code} を返したで。{(' ' + safe_detail) if safe_detail else ''}"
        ) from exc
    except URLError as exc:
        raise ExportError("Google API へ接続できへんかったで。") from exc
    except json.JSONDecodeError as exc:
        raise ExportError("Google API の応答を JSON として読めへんかったで。") from exc

    if not isinstance(payload, dict):
        raise ExportError("Google API から想定外の形式で応答が返ったで。")
    return payload


def refresh_google_access_token() -> str:
    form = urlencode(
        {
            "client_id": _required_env("GOOGLE_CLIENT_ID"),
            "client_secret": _required_env("GOOGLE_CLIENT_SECRET"),
            "refresh_token": _required_env("GOOGLE_REFRESH_TOKEN"),
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    request = Request(
        GOOGLE_TOKEN_URL,
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    payload = _read_json_response(request)
    token = str(payload.get("access_token") or "").strip()
    if not token:
        raise ExportError("Google OAuth の access_token を取得できへんかったで。")
    return token


def _drive_json_request(
    method: str,
    url: str,
    access_token: str,
    *,
    data: bytes | None = None,
    content_type: str | None = None,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    if content_type:
        headers["Content-Type"] = content_type
    return _read_json_response(
        Request(url, data=data, headers=headers, method=method),
        timeout=120.0,
    )


def _escape_drive_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def find_drive_file(access_token: str, folder_id: str, filename: str) -> dict[str, Any] | None:
    q = (
        f"name = '{_escape_drive_query(filename)}' and "
        f"'{_escape_drive_query(folder_id)}' in parents and trashed = false"
    )
    params = urlencode(
        {
            "q": q,
            "fields": "files(id,name,webViewLink,modifiedTime)",
            "pageSize": "10",
            "orderBy": "modifiedTime desc",
            "spaces": "drive",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
    )
    payload = _drive_json_request(
        "GET",
        f"{DRIVE_API}/files?{params}",
        access_token,
    )
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        return None
    first = files[0]
    return first if isinstance(first, dict) else None


def upload_drive_csv(
    *,
    filename: str,
    csv_bytes: bytes,
    folder_id: str,
) -> dict[str, Any]:
    access_token = refresh_google_access_token()
    existing = find_drive_file(access_token, folder_id, filename)
    fields = "id,name,webViewLink,modifiedTime"

    if existing and existing.get("id"):
        file_id = str(existing["id"])
        params = urlencode(
            {
                "uploadType": "media",
                "fields": fields,
                "supportsAllDrives": "true",
            }
        )
        payload = _drive_json_request(
            "PATCH",
            f"{DRIVE_UPLOAD_API}/files/{file_id}?{params}",
            access_token,
            data=csv_bytes,
            content_type="text/csv; charset=utf-8",
        )
        payload["action"] = "updated"
        return payload

    boundary = f"===============jquants_{secrets.token_hex(12)}=="
    metadata = json.dumps(
        {
            "name": filename,
            "parents": [folder_id],
            "mimeType": "text/csv",
        },
        ensure_ascii=False,
    ).encode("utf-8")
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
    ).encode("utf-8")
    body += metadata
    body += (
        f"\r\n--{boundary}\r\n"
        "Content-Type: text/csv; charset=UTF-8\r\n\r\n"
    ).encode("utf-8")
    body += csv_bytes
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")

    params = urlencode(
        {
            "uploadType": "multipart",
            "fields": fields,
            "supportsAllDrives": "true",
        }
    )
    payload = _drive_json_request(
        "POST",
        f"{DRIVE_UPLOAD_API}/files?{params}",
        access_token,
        data=body,
        content_type=f"multipart/related; boundary={boundary}",
    )
    payload["action"] = "created"
    return payload


def resolve_company(client: JQuantsClient, stock: str):
    candidates = client.search_companies(stock, limit=10)
    if not candidates:
        raise ExportError(f"一致する上場銘柄が見つからへんかったで: {stock}")
    best_rank = candidates[0].rank
    best = [candidate for candidate in candidates if candidate.rank == best_rank]
    if len(best) != 1:
        choices = ", ".join(f"{item.name}({item.code})" for item in best)
        raise ExportError(f"銘柄候補が複数あるで。銘柄コードで指定してな: {choices}")
    return best[0]


def choose_filename(
    *,
    mode: str,
    interval: str,
    company_name: str,
    first_date: str,
    last_date: str,
    had_explicit_range: bool,
) -> str:
    if mode == "auto":
        mode = "dated" if had_explicit_range else "stable"

    safe_name = sanitize_filename_component(company_name)
    if mode == "stable":
        if interval == "daily":
            return f"{safe_name}.csv"
        if interval == "1m":
            return f"{safe_name}_1min.csv"
        return f"{safe_name}_30min.csv"

    if interval == "daily":
        return make_csv_filename(company_name, first_date, last_date)
    if interval == "1m":
        return make_minute_csv_filename(company_name, first_date, last_date)
    return make_intraday_csv_filename(company_name, 30, first_date, last_date)


def export_csv(
    *,
    stock: str,
    interval: str,
    from_date: str | None,
    to_date: str | None,
    filename_mode: str,
    output_dir: Path,
    upload: bool,
) -> dict[str, Any]:
    api_key = _required_env("JQUANTS_API_KEY")
    client = JQuantsClient(api_key)
    company = resolve_company(client, stock)

    start = normalize_date(from_date)
    end = normalize_date(to_date)
    had_explicit_range = bool(start or end)

    if interval == "daily":
        rows = client.get_daily_bars(company.code, from_date=start, to_date=end)
        series_name = "日足"
        if not rows:
            raise ExportError("指定範囲で取得できる日足がなかったで。")
        csv_text = daily_bars_to_csv(rows, company.name)
    elif interval in {"1m", "30m"}:
        minute_rows = client.get_minute_bars(company.code, from_date=start, to_date=end)
        if not minute_rows:
            raise ExportError("指定範囲で取得できる1分足がなかったで。")
        if interval == "1m":
            rows = minute_rows
            series_name = "1分足"
            csv_text = minute_bars_to_csv(rows, company.name)
        else:
            rows = aggregate_minute_bars_30m(minute_rows)
            if not rows:
                raise ExportError("1分足は取得できたけど、通常取引時間の30分足を作れへんかったで。")
            series_name = "30分足"
            csv_text = intraday_bars_to_csv(rows, company.name)
    else:
        raise ExportError(f"未対応の interval やで: {interval}")

    first_date = str(rows[0].get("Date") or "unknown")
    last_date = str(rows[-1].get("Date") or "unknown")
    filename = choose_filename(
        mode=filename_mode,
        interval=interval,
        company_name=company.name,
        first_date=first_date,
        last_date=last_date,
        had_explicit_range=had_explicit_range,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / filename
    csv_bytes = csv_text.encode("utf-8")
    output_path.write_bytes(csv_bytes)

    drive_result: dict[str, Any] | None = None
    if upload:
        drive_result = upload_drive_csv(
            filename=filename,
            csv_bytes=csv_bytes,
            folder_id=_required_env("GOOGLE_DRIVE_FOLDER_ID"),
        )

    result = {
        "status": "ok",
        "company_name": company.name,
        "company_code": company.code,
        "series_name": series_name,
        "interval": interval,
        "row_count": len(rows),
        "first_date": first_date,
        "last_date": last_date,
        "filename": filename,
        "output_path": str(output_path),
        "drive": drive_result,
    }
    return result


def write_github_outputs(result: dict[str, Any]) -> None:
    output_file = os.environ.get("GITHUB_OUTPUT")
    if not output_file:
        return

    drive = result.get("drive") or {}
    values = {
        "filename": result["filename"],
        "output_path": result["output_path"],
        "company_name": result["company_name"],
        "company_code": result["company_code"],
        "series_name": result["series_name"],
        "row_count": result["row_count"],
        "first_date": result["first_date"],
        "last_date": result["last_date"],
        "drive_file_id": drive.get("id", ""),
        "drive_file_url": drive.get("webViewLink", ""),
        "drive_action": drive.get("action", ""),
    }
    with open(output_file, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            text = str(value).replace("\n", " ").replace("\r", " ")
            handle.write(f"{key}={text}\n")


def write_github_summary(result: dict[str, Any]) -> None:
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_file:
        return
    drive = result.get("drive") or {}
    lines = [
        "## J-Quants CSV export",
        "",
        f"- 銘柄: {result['company_name']} ({result['company_code']})",
        f"- 足種: {result['series_name']}",
        f"- 件数: {result['row_count']}",
        f"- 期間: {result['first_date']} ～ {result['last_date']}",
        f"- CSV: `{result['filename']}`",
    ]
    if drive:
        lines.append(f"- Drive: {drive.get('action', 'saved')}")
    with open(summary_file, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="J-Quantsの時系列データをCSV化し、Google Driveへ保存する。"
    )
    parser.add_argument("--stock", required=True)
    parser.add_argument("--interval", choices=["daily", "1m", "30m"], default="daily")
    parser.add_argument("--from-date", default=None)
    parser.add_argument("--to-date", default=None)
    parser.add_argument(
        "--filename-mode",
        choices=["auto", "stable", "dated"],
        default="auto",
    )
    parser.add_argument("--output-dir", default="out")
    parser.add_argument("--no-upload", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = export_csv(
            stock=args.stock,
            interval=args.interval,
            from_date=args.from_date,
            to_date=args.to_date,
            filename_mode=args.filename_mode,
            output_dir=Path(args.output_dir),
            upload=not args.no_upload,
        )
    except (JQuantsError, ExportError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    write_github_outputs(result)
    write_github_summary(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
