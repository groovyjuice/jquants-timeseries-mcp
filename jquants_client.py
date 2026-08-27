from __future__ import annotations

import csv
import io
import json
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_BASE_URL = "https://api.jquants.com"
MASTER_PATH = "/v2/equities/master"
DAILY_BARS_PATH = "/v2/equities/bars/daily"
MINUTE_BARS_PATH = "/v2/equities/bars/minute"


class JQuantsError(RuntimeError):
    """An error safe to show to the user without exposing credentials."""


@dataclass(frozen=True)
class CompanyCandidate:
    code: str
    name: str
    name_en: str
    market: str
    rank: int

    def public_dict(self) -> dict[str, str]:
        return {
            "code": self.code,
            "name": self.name,
            "name_en": self.name_en,
            "market": self.market,
        }


Fetcher = Callable[[str, dict[str, str]], dict[str, Any]]


def normalize_date(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    if re.fullmatch(r"\d{8}", raw):
        raw = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError as exc:
        raise JQuantsError(
            f"日付はYYYY-MM-DDまたはYYYYMMDDで指定してな: {value}"
        ) from exc


def normalize_code(value: str) -> str | None:
    raw = unicodedata.normalize("NFKC", value).strip()
    if not re.fullmatch(r"\d{4,5}", raw):
        return None
    return raw


def normalize_company_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"[\s　・･,.，．()（）\[\]【】'\"‐‑–—―_-]+", "", normalized)
    return normalized


def strip_corporate_words(value: str) -> str:
    result = value
    for word in (
        "株式会社",
        "有限会社",
        "ホールディングス",
        "holdings",
        "corporation",
        "corp",
        "inc",
        "ltd",
        "co",
    ):
        result = result.replace(normalize_company_text(word), "")
    return result


class JQuantsClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = API_BASE_URL,
        fetcher: Fetcher | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        if not api_key.strip():
            raise JQuantsError("JQUANTS_API_KEYが設定されてへんで。")
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.fetcher = fetcher or self._fetch_json
        self.timeout_seconds = timeout_seconds

    def _fetch_json(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"

        request = Request(
            url,
            headers={
                "x-api-key": self.api_key,
                "Accept": "application/json",
                "User-Agent": "jquants-chatgpt-mcp/1.0",
            },
            method="GET",
        )

        for attempt in range(3):
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                if not isinstance(payload, dict):
                    raise JQuantsError("J-Quantsから想定外の形式で応答が返ったで。")
                return payload
            except HTTPError as exc:
                if exc.code == 401:
                    raise JQuantsError(
                        "J-Quants APIキーが無効か、認証に失敗したで。"
                    ) from exc
                if exc.code == 403:
                    raise JQuantsError(
                        "このデータは現在のJ-Quantsプランでは取得できへんで。"
                    ) from exc
                if exc.code == 429 and attempt < 2:
                    retry_after = exc.headers.get("Retry-After", "12")
                    try:
                        wait_seconds = min(max(float(retry_after), 1.0), 30.0)
                    except ValueError:
                        wait_seconds = 12.0
                    time.sleep(wait_seconds)
                    continue
                if 500 <= exc.code < 600 and attempt < 2:
                    time.sleep(2**attempt)
                    continue
                raise JQuantsError(
                    f"J-Quants APIがHTTP {exc.code}を返したで。"
                ) from exc
            except URLError as exc:
                if attempt < 2:
                    time.sleep(2**attempt)
                    continue
                raise JQuantsError("J-Quants APIへ接続できへんかったで。") from exc
            except json.JSONDecodeError as exc:
                raise JQuantsError("J-Quantsの応答をJSONとして読めへんかったで。") from exc

        raise JQuantsError("J-Quants APIへの接続に失敗したで。")

    def _get_all_pages(
        self, path: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        base_params = dict(params or {})
        rows: list[dict[str, Any]] = []
        seen_keys: set[str] = set()
        pagination_key: str | None = None

        while True:
            page_params = dict(base_params)
            if pagination_key:
                page_params["pagination_key"] = pagination_key
            payload = self.fetcher(path, page_params)
            page_rows = payload.get("data", [])
            if not isinstance(page_rows, list):
                raise JQuantsError("J-Quantsのdata項目が配列やなかったで。")
            rows.extend(row for row in page_rows if isinstance(row, dict))

            next_key = payload.get("pagination_key")
            if not isinstance(next_key, str) or not next_key:
                break
            if next_key in seen_keys:
                raise JQuantsError("J-Quantsのページングが循環したため停止したで。")
            seen_keys.add(next_key)
            pagination_key = next_key

        return rows

    def get_master(self, code: str | None = None) -> list[dict[str, Any]]:
        params = {"code": code} if code else {}
        return self._get_all_pages(MASTER_PATH, params)

    def search_companies(self, query: str, limit: int = 10) -> list[CompanyCandidate]:
        query = query.strip()
        if not query:
            raise JQuantsError("銘柄名か銘柄コードを指定してな。")

        code = normalize_code(query)
        master_rows = self.get_master(code=code) if code else self.get_master()
        query_norm = normalize_company_text(query)
        query_short = strip_corporate_words(query_norm)
        candidates: list[CompanyCandidate] = []

        for row in master_rows:
            row_code = str(row.get("Code") or "")
            name = str(row.get("CoName") or "")
            name_en = str(row.get("CoNameEn") or "")
            market = str(row.get("MktNm") or "")

            if code:
                if row_code in {code, f"{code}0" if len(code) == 4 else code}:
                    rank = 0
                else:
                    continue
            else:
                name_norm = normalize_company_text(name)
                name_en_norm = normalize_company_text(name_en)
                name_short = strip_corporate_words(name_norm)
                name_en_short = strip_corporate_words(name_en_norm)
                searchable = (name_norm, name_en_norm, name_short, name_en_short)
                if query_norm in {name_norm, name_en_norm}:
                    rank = 0
                elif query_short and query_short in {name_short, name_en_short}:
                    rank = 1
                elif any(text.startswith(query_norm) for text in searchable if text):
                    rank = 2
                elif any(query_norm in text for text in searchable if text):
                    rank = 3
                elif query_short and any(query_short in text for text in searchable if text):
                    rank = 4
                else:
                    continue

            candidates.append(
                CompanyCandidate(
                    code=row_code,
                    name=name,
                    name_en=name_en,
                    market=market,
                    rank=rank,
                )
            )

        candidates.sort(key=lambda item: (item.rank, len(item.name), item.code))
        return candidates[: max(1, min(limit, 20))]

    def get_daily_bars(
        self,
        code: str,
        *,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> list[dict[str, Any]]:
        params = {"code": code}
        start = normalize_date(from_date)
        end = normalize_date(to_date)
        if start and end and start > end:
            raise JQuantsError("開始日は終了日以前にしてな。")
        if start:
            params["from"] = start
        if end:
            params["to"] = end

        rows = self._get_all_pages(DAILY_BARS_PATH, params)
        unique: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            key = (str(row.get("Date") or ""), str(row.get("Code") or code))
            unique[key] = row
        return sorted(unique.values(), key=lambda row: str(row.get("Date") or ""))

    def get_minute_bars(
        self,
        code: str,
        *,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> list[dict[str, Any]]:
        params = {"code": code}
        start = normalize_date(from_date)
        end = normalize_date(to_date)
        if start and end and start > end:
            raise JQuantsError("開始日は終了日以前にしてな。")
        if start:
            params["from"] = start
        if end:
            params["to"] = end

        rows = self._get_all_pages(MINUTE_BARS_PATH, params)
        unique: dict[tuple[str, str, str], dict[str, Any]] = {}
        for row in rows:
            key = (
                str(row.get("Date") or ""),
                str(row.get("Time") or ""),
                str(row.get("Code") or code),
            )
            unique[key] = row
        return sorted(
            unique.values(),
            key=lambda row: (
                str(row.get("Date") or ""),
                str(row.get("Time") or ""),
                str(row.get("Code") or code),
            ),
        )


CSV_COLUMNS: tuple[tuple[str, str], ...] = (
    ("Date", "Date"),
    ("Code", "Code"),
    ("CompanyName", "CompanyName"),
    ("O", "Open"),
    ("H", "High"),
    ("L", "Low"),
    ("C", "Close"),
    ("UL", "UpperLimit"),
    ("LL", "LowerLimit"),
    ("Vo", "Volume"),
    ("Va", "TurnoverValue"),
    ("AdjFactor", "AdjustmentFactor"),
    ("AdjO", "AdjustmentOpen"),
    ("AdjH", "AdjustmentHigh"),
    ("AdjL", "AdjustmentLow"),
    ("AdjC", "AdjustmentClose"),
    ("AdjVo", "AdjustmentVolume"),
    ("MO", "MorningOpen"),
    ("MH", "MorningHigh"),
    ("ML", "MorningLow"),
    ("MC", "MorningClose"),
    ("MUL", "MorningUpperLimit"),
    ("MLL", "MorningLowerLimit"),
    ("MVo", "MorningVolume"),
    ("MVa", "MorningTurnoverValue"),
    ("AO", "AfternoonOpen"),
    ("AH", "AfternoonHigh"),
    ("AL", "AfternoonLow"),
    ("AC", "AfternoonClose"),
    ("AUL", "AfternoonUpperLimit"),
    ("ALL", "AfternoonLowerLimit"),
    ("AVo", "AfternoonVolume"),
    ("AVa", "AfternoonTurnoverValue"),
    ("MktCap", "MarketCapitalizationMillionYen"),
    ("ExRT", "ExRightType"),
)


def daily_bars_to_csv(rows: Iterable[dict[str, Any]], company_name: str) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=[label for _, label in CSV_COLUMNS])
    writer.writeheader()
    for row in rows:
        converted: dict[str, Any] = {}
        for source, label in CSV_COLUMNS:
            converted[label] = company_name if source == "CompanyName" else row.get(source)
        writer.writerow(converted)
    # A UTF-8 BOM helps Excel on Windows recognize Japanese text correctly.
    return "\ufeff" + output.getvalue()


def sanitize_filename_component(value: str) -> str:
    sanitized = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", value).strip(" ._")
    return sanitized or "stock"


def make_csv_filename(company_name: str, first_date: str, last_date: str) -> str:
    name = sanitize_filename_component(company_name)
    return f"JQ_{name}_{first_date}_{last_date}.csv"


def _minute_bucket(time_value: Any) -> tuple[str, str] | None:
    match = re.fullmatch(r"(\d{2}):(\d{2})(?::\d{2})?", str(time_value or ""))
    if match is None:
        raise JQuantsError(f"分足に不正な時刻が含まれてるで: {time_value}")

    hour, minute = (int(part) for part in match.groups())
    total_minutes = hour * 60 + minute
    sessions = ((9 * 60, 11 * 60 + 30), (12 * 60 + 30, 15 * 60 + 30))
    for session_start, session_end in sessions:
        if session_start <= total_minutes <= session_end:
            # The trades stamped exactly at 11:30 or 15:30 are closing-auction
            # trades, so keep them in the preceding bar instead of creating a
            # one-minute-only bucket.
            bounded_minute = min(total_minutes, session_end - 1)
            bucket_start = session_start + ((bounded_minute - session_start) // 30) * 30
            bucket_end = min(bucket_start + 30, session_end)
            return (
                f"{bucket_start // 60:02d}:{bucket_start % 60:02d}",
                f"{bucket_end // 60:02d}:{bucket_end % 60:02d}",
            )
    return None


def _required_number(row: dict[str, Any], field: str) -> float:
    value = row.get(field)
    if value is None or isinstance(value, bool):
        raise JQuantsError(f"分足の{field}が欠損してるで。")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise JQuantsError(f"分足の{field}が数値やなかったで。") from exc


def _optional_number(row: dict[str, Any], field: str) -> float:
    value = row.get(field)
    if value is None or value == "":
        return 0.0
    if isinstance(value, bool):
        raise JQuantsError(f"分足の{field}が数値やなかったで。")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise JQuantsError(f"分足の{field}が数値やなかったで。") from exc


def _compact_number(value: float) -> int | float:
    return int(value) if value.is_integer() else value


def aggregate_minute_bars_30m(
    rows: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Aggregate J-Quants one-minute bars into TSE-session-aligned 30m bars."""
    sorted_rows = sorted(
        rows,
        key=lambda row: (
            str(row.get("Date") or ""),
            str(row.get("Time") or ""),
            str(row.get("Code") or ""),
        ),
    )
    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}

    for row in sorted_rows:
        day = str(row.get("Date") or "")
        code = str(row.get("Code") or "")
        if not day or not code:
            raise JQuantsError("分足に日付または銘柄コードがない行が含まれてるで。")
        bucket = _minute_bucket(row.get("Time"))
        if bucket is None:
            # Ignore trades outside the regular TSE cash-equity sessions.
            continue
        start_time, end_time = bucket
        key = (day, start_time, code)
        open_price = _required_number(row, "O")
        high_price = _required_number(row, "H")
        low_price = _required_number(row, "L")
        close_price = _required_number(row, "C")
        volume = _optional_number(row, "Vo")
        turnover = _optional_number(row, "Va")

        current = grouped.get(key)
        if current is None:
            grouped[key] = {
                "Date": day,
                "StartTimeJST": start_time,
                "EndTimeJST": end_time,
                "Code": code,
                "O": open_price,
                "H": high_price,
                "L": low_price,
                "C": close_price,
                "Vo": volume,
                "Va": turnover,
                "SourceMinuteCount": 1,
            }
            continue

        current["H"] = max(float(current["H"]), high_price)
        current["L"] = min(float(current["L"]), low_price)
        current["C"] = close_price
        current["Vo"] = float(current["Vo"]) + volume
        current["Va"] = float(current["Va"]) + turnover
        current["SourceMinuteCount"] = int(current["SourceMinuteCount"]) + 1

    result = sorted(
        grouped.values(),
        key=lambda row: (
            str(row["Date"]),
            str(row["StartTimeJST"]),
            str(row["Code"]),
        ),
    )
    for row in result:
        for field in ("O", "H", "L", "C", "Vo", "Va"):
            row[field] = _compact_number(float(row[field]))
    return result


INTRADAY_CSV_COLUMNS: tuple[tuple[str, str], ...] = (
    ("Date", "Date"),
    ("StartTimeJST", "StartTimeJST"),
    ("EndTimeJST", "EndTimeJST"),
    ("Code", "Code"),
    ("CompanyName", "CompanyName"),
    ("O", "Open"),
    ("H", "High"),
    ("L", "Low"),
    ("C", "Close"),
    ("Vo", "Volume"),
    ("Va", "TurnoverValue"),
    ("SourceMinuteCount", "SourceMinuteCount"),
)


def intraday_bars_to_csv(
    rows: Iterable[dict[str, Any]], company_name: str
) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(
        output, fieldnames=[label for _, label in INTRADAY_CSV_COLUMNS]
    )
    writer.writeheader()
    for row in rows:
        converted: dict[str, Any] = {}
        for source, label in INTRADAY_CSV_COLUMNS:
            converted[label] = company_name if source == "CompanyName" else row.get(source)
        writer.writerow(converted)
    return "\ufeff" + output.getvalue()


def make_intraday_csv_filename(
    company_name: str, interval_minutes: int, first_date: str, last_date: str
) -> str:
    name = sanitize_filename_component(company_name)
    return f"JQ_{name}_{interval_minutes}min_{first_date}_{last_date}.csv"
