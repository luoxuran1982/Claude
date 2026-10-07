"""从开球网公开 CSV 接口取数并解析。

（备用域名 kaiqiu.cc，路径相同）
全国：   https://kaiqiuwang.cc/home/cityEventsMonthly.php
区域：   同上 ?province=江苏
滚动时段：https://kaiqiuwang.cc/home/cityEvents.php（近7天），?days=30/90/365
"""
from __future__ import annotations

import csv
import io
import re
import ssl
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

BASE = "https://kaiqiuwang.cc/home"
# 同一个网站的另一个域名；主域名连不上时自动换用
MIRRORS = ["https://kaiqiu.cc/home"]
MONTHLY_URL = BASE + "/cityEventsMonthly.php"
PERIOD_URL = BASE + "/cityEvents.php"

REGIONS = [
    "北京", "上海", "天津", "四川", "江苏", "浙江", "湖北", "湖南", "新疆", "内蒙古",
    "黑龙江", "吉林", "辽宁", "山东", "山西", "陕西", "河南", "河北", "宁夏", "青海",
    "西藏", "云南", "广东", "广西", "海南", "福建", "安徽", "香港", "澳门", "江西",
    "贵州", "重庆", "甘肃", "台湾", "海外",
]
NATIONAL = "全国"
AREAS = [NATIONAL] + REGIONS
PERIODS = [("近7天", None), ("近30天", 30), ("近90天", 90), ("近365天", 365)]
MONTHLY_HEADER = ["月份", "本月比赛场次", "超过64人以上的比赛场次", "本月参赛人次"]


class SourceError(RuntimeError):
    """来源返回了无法使用的数据。消息直接展示给用户。"""


@dataclass
class Monthly:
    months: list[str]          # "YYYY-MM"
    participants: list[int]
    events: list[int]
    over64: list[int | None]


def monthly_url(area: str) -> str:
    if area == NATIONAL:
        return MONTHLY_URL
    return MONTHLY_URL + "?" + urllib.parse.urlencode({"province": area})


def period_url(days: int | None) -> str:
    return PERIOD_URL if days is None else f"{PERIOD_URL}?days={days}"


def _ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    try:  # 打包后的 macOS 程序没有系统证书路径，补上 certifi
        import certifi
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    return ctx


_CTX = None


def fetch_text(url: str, retries: int = 3, timeout: float = 45) -> str:
    """先用主域名；失败后依次换备用域名。"""
    try:
        return _fetch_one(url, retries, timeout)
    except SourceError as first:
        for mirror in MIRRORS:
            if url.startswith(BASE):
                try:
                    return _fetch_one(mirror + url[len(BASE):], 1, timeout)
                except SourceError:
                    pass
        raise first


def _fetch_one(url: str, retries: int, timeout: float) -> str:
    global _CTX
    if _CTX is None:
        _CTX = _ssl_context()
    headers = {"User-Agent": "Mozilla/5.0 KaiqiuBoard/2 (personal dashboard)",
               "Accept": "text/csv,text/plain,*/*"}
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as resp:
                return resp.read().decode("utf-8-sig", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    reason = getattr(last, "reason", None) or last
    raise SourceError(f"连接失败（{reason}）")


def _clean(cell: str) -> str:
    return cell.replace("﻿", "").strip().strip("\t").strip()


def _int(cell: str) -> int:
    cell = cell.replace(",", "").strip()
    if not cell:
        return 0
    if not re.fullmatch(r"-?\d+", cell):
        raise SourceError(f"无法识别的数字：{cell!r}")
    return int(cell)


def parse_monthly(area: str, text: str) -> Monthly:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise SourceError(f"{area}：月度数据为空")
    header = [_clean(c) for c in rows[0]]
    if header[:4] != MONTHLY_HEADER:
        raise SourceError(f"{area}：表头变了 {header[:4]}，请检查网站是否改版")
    found: dict[str, tuple[int, int, int | None]] = {}
    for raw in rows[1:]:
        cells = [_clean(c) for c in raw]
        if len(cells) < 4 or not cells[0]:
            continue
        m = re.fullmatch(r"(\d{4})年(\d{1,2})月", cells[0])
        if not m:
            continue
        key = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}"
        if key in found:
            raise SourceError(f"{area}：月份 {key} 重复")
        found[key] = (_int(cells[3]), _int(cells[1]), _int(cells[2]) if cells[2] else None)
    if not found:
        raise SourceError(f"{area}：没有月度数据行")
    months = sorted(found)  # 来源有时倒序，统一升序
    return Monthly(months, [found[k][0] for k in months], [found[k][1] for k in months],
                   [found[k][2] for k in months])


def parse_period(label: str, text: str) -> list[dict]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise SourceError(f"{label}：时段数据为空")
    header = [_clean(c) for c in rows[0]]
    if len(header) < 5 or header[0] != "序号" or header[1] != "省份":
        raise SourceError(f"{label}：表头变了 {header}")
    out = []
    for raw in rows[1:]:
        cells = [_clean(c) for c in raw]
        if len(cells) < 5 or not cells[1]:
            continue
        out.append({"region": cells[1], "events": _int(cells[2]),
                    "participants": _int(cells[3]), "games": _int(cells[4])})
    return out


def fetch_all(progress=None, fetch=fetch_text, workers: int = 6):
    """取全国+35区域全部历史（来源会修订历史，所以每次全量）以及 4 个滚动时段。

    progress(done, total, message)。任何一项失败都会抛错，调用方保留旧数据。
    """
    total = len(AREAS) + len(PERIODS)
    done = 0
    monthly: dict[str, Monthly] = {}
    periods: dict[str, list[dict]] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {pool.submit(fetch, monthly_url(a)): ("m", a) for a in AREAS}
        jobs.update({pool.submit(fetch, period_url(d)): ("p", label) for label, d in PERIODS})
        for fut in as_completed(jobs):
            kind, name = jobs[fut]
            try:
                text = fut.result()
                if kind == "m":
                    monthly[name] = parse_monthly(name, text)
                else:
                    periods[name] = parse_period(name, text)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}：{exc}")
            done += 1
            if progress:
                progress(done, total, f"已取得 {name}" if not errors else f"{len(errors)} 项失败，继续其余…")
    if errors:
        if len(errors) >= total // 2:
            raise SourceError(f"连不上开球网（{len(errors)}/{total} 项失败），请检查网络后重试。示例：{errors[0]}")
        head = "；".join(errors[:3])
        more = f" 等 {len(errors)} 项" if len(errors) > 3 else ""
        raise SourceError(f"部分数据没取到（{head}{more}）")
    return {a: monthly[a] for a in AREAS}, {label: periods[label] for label, _ in PERIODS}
