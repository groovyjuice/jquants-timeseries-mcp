from __future__ import annotations

import math
from statistics import mean, median, stdev
from typing import Any, Iterable


def _time_minutes(value: Any) -> int | None:
    text = str(value or "").strip()
    parts = text.split(":")
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None


def _number(row: dict[str, Any], field: str) -> float | None:
    value = row.get(field)
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _round(value: float | None, digits: int = 6) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _stats(events: list[dict[str, Any]]) -> dict[str, Any]:
    gaps = [float(event["overnight_gap_pct"]) for event in events if event.get("overnight_gap_pct") is not None]
    jumps = [float(event["auction_jump_pct"]) for event in events if event.get("auction_jump_pct") is not None]
    return {
        "event_count": len(events),
        "gap_count": len(gaps),
        "auction_jump_mean_pct": _round(mean(jumps)) if jumps else None,
        "overnight_gap_mean_pct": _round(mean(gaps)) if gaps else None,
        "overnight_gap_median_pct": _round(median(gaps)) if gaps else None,
        "overnight_gap_win_rate_pct": _round(100.0 * sum(value > 0 for value in gaps) / len(gaps)) if gaps else None,
        "overnight_gap_simple_sum_pct": _round(sum(gaps)) if gaps else None,
        "overnight_gap_std_pct": _round(stdev(gaps)) if len(gaps) >= 2 else None,
    }


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    mx = mean(xs)
    my = mean(ys)
    dx = [x - mx for x in xs]
    dy = [y - my for y in ys]
    denom_x = math.sqrt(sum(value * value for value in dx))
    denom_y = math.sqrt(sum(value * value for value in dy))
    if denom_x == 0 or denom_y == 0:
        return None
    return sum(x * y for x, y in zip(dx, dy)) / (denom_x * denom_y)


def summarize_closing_auction(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        (row for row in rows if isinstance(row, dict)),
        key=lambda row: (str(row.get("Date") or ""), str(row.get("Time") or "")),
    )
    by_day: dict[str, list[dict[str, Any]]] = {}
    for row in ordered:
        day = str(row.get("Date") or "")
        if day:
            by_day.setdefault(day, []).append(row)

    dates = sorted(by_day)
    events: list[dict[str, Any]] = []
    for index, day in enumerate(dates):
        day_rows = by_day[day]
        auction_rows = [row for row in day_rows if _time_minutes(row.get("Time")) == 15 * 60 + 30]
        if not auction_rows:
            continue
        auction = auction_rows[-1]
        pre_rows = [
            row for row in day_rows
            if (_time_minutes(row.get("Time")) is not None)
            and 12 * 60 + 30 <= int(_time_minutes(row.get("Time"))) < 15 * 60 + 30
        ]
        if not pre_rows:
            continue
        pre = pre_rows[-1]
        pre_close = _number(pre, "C")
        auction_close = _number(auction, "C")
        if pre_close is None or auction_close is None or pre_close == 0:
            continue

        jump_pct = (auction_close / pre_close - 1.0) * 100.0
        next_date: str | None = None
        next_open: float | None = None
        overnight_gap_pct: float | None = None
        if index + 1 < len(dates):
            next_date = dates[index + 1]
            next_rows = by_day[next_date]
            morning_rows = [
                row for row in next_rows
                if (_time_minutes(row.get("Time")) is not None)
                and 9 * 60 <= int(_time_minutes(row.get("Time"))) <= 11 * 60 + 30
            ]
            if morning_rows:
                next_open = _number(morning_rows[0], "O")
                if next_open is not None and auction_close != 0:
                    overnight_gap_pct = (next_open / auction_close - 1.0) * 100.0

        events.append({
            "date": day,
            "pre_auction_time": str(pre.get("Time") or ""),
            "pre_auction_close": _round(pre_close),
            "auction_close": _round(auction_close),
            "auction_jump_pct": _round(jump_pct),
            "auction_volume": _round(_number(auction, "Vo")),
            "next_date": next_date,
            "next_open": _round(next_open),
            "overnight_gap_pct": _round(overnight_gap_pct),
        })

    groups = {
        "up_any": [e for e in events if float(e["auction_jump_pct"]) > 0],
        "down_any": [e for e in events if float(e["auction_jump_pct"]) < 0],
        "flat": [e for e in events if float(e["auction_jump_pct"]) == 0],
        "up_ge_0_10pct": [e for e in events if float(e["auction_jump_pct"]) >= 0.10],
        "down_le_minus_0_10pct": [e for e in events if float(e["auction_jump_pct"]) <= -0.10],
        "up_ge_0_30pct": [e for e in events if float(e["auction_jump_pct"]) >= 0.30],
        "down_le_minus_0_30pct": [e for e in events if float(e["auction_jump_pct"]) <= -0.30],
        "abs_lt_0_10pct": [e for e in events if abs(float(e["auction_jump_pct"])) < 0.10],
    }
    paired = [e for e in events if e.get("overnight_gap_pct") is not None]
    xs = [float(e["auction_jump_pct"]) for e in paired]
    ys = [float(e["overnight_gap_pct"]) for e in paired]
    extremes = sorted(events, key=lambda e: abs(float(e["auction_jump_pct"])), reverse=True)[:12]

    return {
        "definition": {
            "auction": "15:30の1分足（大引けクロージングオークション約定）",
            "pre_auction": "15:30より前の当日最終1分足（通常は15:24）",
            "auction_jump_pct": "15:30終値 / オークション直前終値 - 1",
            "overnight_gap_pct": "翌営業日最初の1分足始値 / 当日15:30終値 - 1",
        },
        "event_count": len(events),
        "group_stats": {name: _stats(group) for name, group in groups.items()},
        "pearson_corr_auction_jump_vs_overnight_gap": _round(_pearson(xs, ys)),
        "largest_absolute_auction_jumps": extremes,
    }
