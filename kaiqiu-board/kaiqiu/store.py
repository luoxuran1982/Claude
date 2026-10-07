"""快照存储：每次刷新生成一个完整快照，全部校验通过才切换为当前版本。"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import source
from .paths import resource_dir

log = logging.getLogger("kaiqiu")
SHANGHAI = timezone(timedelta(hours=8))  # 中国不使用夏令时；避免 Windows 缺 tzdata
SCHEMA = 2
KEEP_SNAPSHOTS = 12
MAX_REVISIONS_LISTED = 300

DEFAULT_SETTINGS = {
    "auto_refresh_on_open": True,   # 打开时自动更新
    "min_refresh_minutes": 30,      # 距上次成功更新不足这么久，打开时不再重复抓
    "periodic_hours": 0,            # 窗口开着时定时刷新，0 = 关
}


def now_shanghai() -> datetime:
    return datetime.now(SHANGHAI)


def month_key(dt: datetime) -> str:
    return f"{dt.year:04d}-{dt.month:02d}"


def next_month(key: str) -> str:
    y, m = int(key[:4]), int(key[5:])
    return f"{y + (m == 12):04d}-{1 if m == 12 else m + 1:02d}"


def atomic_write(path: Path, data) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)


def validate(monthly: dict, periods: dict, now: datetime) -> list[str]:
    """返回统一的月份轴；任何异常都抛 SourceError（消息给用户看）。"""
    nat = monthly[source.NATIONAL]
    months = nat.months
    for a, b in zip(months, months[1:]):
        if next_month(a) != b:
            raise source.SourceError(f"全国历史月份不连续：{a} 之后是 {b}")
    current = month_key(now)
    if months[-1] > current:
        raise source.SourceError(f"来源出现未来月份 {months[-1]}")
    for area, m in monthly.items():
        if m.months != months:
            raise source.SourceError(f"{area} 的月份与全国不一致（{m.months[0]}–{m.months[-1]}，"
                                     f"全国 {months[0]}–{months[-1]}）")
        if min(m.participants) < 0 or min(m.events) < 0 or any(v is not None and v < 0 for v in m.over64):
            raise source.SourceError(f"{area} 出现负数统计")
    for label, rows in periods.items():
        if len(rows) < len(source.REGIONS) * 0.8:
            raise source.SourceError(f"{label} 只有 {len(rows)} 个区域，数量异常")
        if any(min(r["events"], r["participants"], r["games"]) < 0 for r in rows):
            raise source.SourceError(f"{label} 出现负数统计")
    return months


def build_snapshot(monthly: dict, periods: dict, now: datetime) -> dict:
    months = validate(monthly, periods, now)
    revision = now.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    return {
        "schema": SCHEMA, "revision": revision, "fetched_at": now.isoformat(timespec="seconds"),
        "months": months, "current_month": month_key(now), "areas": list(monthly),
        "data": {a: {"participants": m.participants, "events": m.events, "over64": m.over64}
                 for a, m in monthly.items()},
        "periods": periods, "changes": None,
        "sources": {"monthly": source.MONTHLY_URL, "period": source.PERIOD_URL},
    }


def diff(old: dict | None, new: dict) -> dict:
    """新旧快照对比：新增月份、被网站修订的历史数值。"""
    if not old:
        return {"first": True, "new_months": new["months"][-1:], "revised_count": 0, "revised": []}
    old_idx = {m: i for i, m in enumerate(old["months"])}
    revised, count = [], 0
    for area in new["areas"]:
        if area not in old["data"]:
            continue
        for metric in ("participants", "events"):
            ov, nv = old["data"][area][metric], new["data"][area][metric]
            for j, month in enumerate(new["months"]):
                i = old_idx.get(month)
                # 旧快照里还没结束的月份，数字变化是正常累计，不算修订
                if i is None or month >= old["current_month"] or ov[i] == nv[j]:
                    continue
                count += 1
                if len(revised) < MAX_REVISIONS_LISTED:
                    revised.append({"area": area, "month": month, "metric": metric, "old": ov[i], "new": nv[j]})
    return {"first": False, "previous_revision": old["revision"], "previous_fetched_at": old["fetched_at"],
            "new_months": [m for m in new["months"] if m not in old_idx], "revised_count": count,
            "revised": revised}


def sanity_check(old: dict | None, new: dict) -> None:
    """防止网站临时返回残缺数据把好数据覆盖掉。"""
    if not old or old.get("seed"):
        return
    if len(new["months"]) < len(old["months"]):
        raise source.SourceError(f"本次只有 {len(new['months'])} 个月历史，比上次少，判定为来源异常")
    common = [m for m in old["months"] if m < old["current_month"]]
    oi = {m: i for i, m in enumerate(old["months"])}
    ni = {m: i for i, m in enumerate(new["months"])}
    o = sum(old["data"]["全国"]["participants"][oi[m]] for m in common)
    n = sum(new["data"]["全国"]["participants"][ni[m]] for m in common if m in ni)
    if o and n < o * 0.9:
        raise source.SourceError(f"全国历史总人次比上次少 {1 - n / o:.0%}，判定为来源异常，已保留上次数据")


class Store:
    def __init__(self, directory: Path, fetcher=None):
        self.dir = Path(directory)
        self.snap_dir = self.dir / "snapshots"
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.fetcher = fetcher or source.fetch_all
        self.lock = threading.RLock()
        self.snapshot: dict | None = None
        self.settings = dict(DEFAULT_SETTINGS)
        self.progress = {"running": False, "done": 0, "total": len(source.AREAS) + len(source.PERIODS),
                         "message": "", "error": None, "started_at": None, "finished_at": None}
        self._load_settings()
        self._load_current()

    # ---------- 读取 ----------
    def _load_settings(self):
        try:
            saved = json.loads((self.dir / "settings.json").read_text(encoding="utf-8"))
            self.settings.update({k: saved[k] for k in DEFAULT_SETTINGS if k in saved})
        except FileNotFoundError:
            pass
        except Exception:
            log.exception("settings.json 损坏，使用默认设置")

    def _load_current(self):
        try:
            rev = json.loads((self.dir / "current.json").read_text(encoding="utf-8"))["revision"]
            if "/" in rev or "\\" in rev or ".." in rev:
                raise ValueError("bad revision")
            self.snapshot = json.loads((self.snap_dir / f"{rev}.json").read_text(encoding="utf-8"))
            self.progress["message"] = "显示上次成功更新的数据"
            return
        except FileNotFoundError:
            pass
        except Exception:
            log.exception("当前快照无法读取，改用附带数据")
        seed = resource_dir() / "seed.json"
        if seed.exists():
            self.snapshot = json.loads(seed.read_text(encoding="utf-8"))
            self.progress["message"] = "显示应用附带的初始数据（2026-10-03）"

    def set_settings(self, values: dict) -> dict:
        with self.lock:
            for k, v in values.items():
                if k == "auto_refresh_on_open" and isinstance(v, bool):
                    self.settings[k] = v
                elif k == "min_refresh_minutes" and isinstance(v, int) and 0 <= v <= 1440:
                    self.settings[k] = v
                elif k == "periodic_hours" and v in (0, 3, 6, 12, 24):
                    self.settings[k] = v
            atomic_write(self.dir / "settings.json", self.settings)
            return dict(self.settings)

    def status(self) -> dict:
        from . import __version__
        with self.lock:
            s = self.snapshot
            return {"version": __version__, "refresh": dict(self.progress), "settings": dict(self.settings),
                    "revision": s["revision"] if s else None, "fetched_at": s["fetched_at"] if s else None,
                    "seed": bool(s and s.get("seed")), "data_dir": str(self.dir)}

    def history(self) -> list[dict]:
        out = []
        for p in sorted(self.snap_dir.glob("*.json"), reverse=True):
            out.append({"revision": p.stem, "size": p.stat().st_size})
        return out

    def snapshot_age_minutes(self) -> float | None:
        s = self.snapshot
        if not s or s.get("seed"):
            return None
        return (now_shanghai() - datetime.fromisoformat(s["fetched_at"])).total_seconds() / 60

    def should_refresh_on_open(self) -> bool:
        if not self.settings["auto_refresh_on_open"]:
            return False
        age = self.snapshot_age_minutes()
        return age is None or age >= self.settings["min_refresh_minutes"]

    # ---------- 刷新 ----------
    def start_refresh(self) -> bool:
        with self.lock:
            if self.progress["running"]:
                return False
            self.progress.update(running=True, done=0, error=None, message="连接开球网…",
                                 started_at=now_shanghai().isoformat(timespec="seconds"))
        threading.Thread(target=self._refresh, name="kaiqiu-refresh", daemon=True).start()
        return True

    def _progress(self, done, total, message):
        with self.lock:
            self.progress.update(done=done, total=total, message=message)

    def _refresh(self):
        try:
            now = now_shanghai()
            monthly, periods = self.fetcher(self._progress)
            snap = build_snapshot(monthly, periods, now)
            with self.lock:
                old = self.snapshot
            sanity_check(old, snap)
            snap["changes"] = diff(None if (old and old.get("seed")) else old, snap)
            atomic_write(self.snap_dir / f"{snap['revision']}.json", snap)
            atomic_write(self.dir / "current.json", {"revision": snap["revision"]})  # 最后才切换指针
            with self.lock:
                self.snapshot = snap
                self.progress.update(running=False, error=None, message="更新完成",
                                     finished_at=now_shanghai().isoformat(timespec="seconds"))
            self._prune(snap["revision"])
        except Exception as exc:  # noqa: BLE001
            log.exception("刷新失败，保留上次数据")
            msg = str(exc) if isinstance(exc, source.SourceError) else f"{type(exc).__name__}: {exc}"
            with self.lock:
                self.progress.update(running=False, error=msg, message="更新失败，仍显示上次成功的数据",
                                     finished_at=now_shanghai().isoformat(timespec="seconds"))

    def _prune(self, keep_revision: str):
        files = sorted(self.snap_dir.glob("*.json"), reverse=True)
        for p in files[KEEP_SNAPSHOTS:]:
            if p.stem != keep_revision:
                try:
                    p.unlink()
                except OSError:
                    pass
