"""真实访问开球网，检查接口格式、校验规则和 Excel 生成（CI 里不阻塞）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kaiqiu import excel, source, store  # noqa: E402

monthly, periods = source.fetch_all(lambda d, t, m: print(f"{d}/{t} {m}", flush=True))
snap = store.build_snapshot(monthly, periods, store.now_shanghai())
print("月份：", snap["months"][0], "→", snap["months"][-1], len(snap["months"]))
print("全国最近完整月：", snap["months"][-2], snap["data"]["全国"]["participants"][-2])
print("时段：", {k: len(v) for k, v in periods.items()})
print("Excel 字节：", len(excel.build(snap)))
