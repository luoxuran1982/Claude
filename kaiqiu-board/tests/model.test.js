// node tests/model.test.js
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const M = require(path.join(__dirname, "..", "kaiqiu", "web", "model.js"));
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "kaiqiu", "seed.json"), "utf8"));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok -", name); };

test("derive: 环比、同比、连续增长", () => {
  const v = [10, 12, 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 0];
  const d = M.derive(v);
  assert.strictEqual(d.mom[0], null);
  assert.strictEqual(d.mom[1], 0.2);
  assert.strictEqual(d.mom[3], null);        // 上月为 0 不算百分比
  assert.strictEqual(M.growthText(d.mom[3], d.delta[3]), "新增");
  assert.strictEqual(d.yoy[12], 1);          // 20 vs 10
  assert.strictEqual(d.yoy[13], -1);         // 0 vs 12
  assert.strictEqual(d.yoy[11], null);       // 不足 12 个月
  assert.strictEqual(d.streak[12], 10);
  assert.strictEqual(d.streak[13], 0);
});

test("rangeYoY: 缺基数不补算", () => {
  const v = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.deepStrictEqual(M.rangeYoY(v, 5, 10).base, null);
  const r = M.rangeYoY(v, 12, 23);
  assert.strictEqual(r.value, 222); // 13..24
  assert.strictEqual(r.base, 78);
});

test("annual: 未结束年份只比较相同月份", () => {
  const months = [], vals = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k > "2026-10") break;
    months.push(k); vals.push(y === 2026 ? 2 : 1);
  }
  const a = M.annual(months, vals, "2026-10", false);
  const y26 = a.find(x => x.year === 2026);
  assert.strictEqual(y26.months, 9);
  assert.strictEqual(y26.base, 9);
  assert.strictEqual(y26.yoy, 1);
  assert.strictEqual(a[0].base, null);
  assert.strictEqual(M.annual(months, vals, "2026-10", true).find(x => x.year === 2026).months, 10);
});

test("group: 季/年分组与不完整标记", () => {
  const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"];
  const g = M.group(months, [1, 2, 3, 4, 5, 6], 0, 5, "quarter", "2026-04");
  assert.deepStrictEqual(g.map(x => [x.key, x.value, x.partial]), [["2025Q4", 3, true], ["2026Q1", 12, false], ["2026Q2", 6, true]]);
  assert.deepStrictEqual(M.group(months, [1, 2, 3, 4, 5, 6], 0, 5, "year", "2027-01").map(x => x.value), [3, 18]);
});

test("真实快照：全国年度合计与逐月相加一致", () => {
  const v = seed.data["全国"].participants;
  const a = M.annual(seed.months, v, seed.current_month, false);
  const total = a.reduce((t, x) => t + x.value, 0);
  const expect = v.slice(0, M.completeCount(seed.months, seed.current_month)).reduce((t, x) => t + x, 0);
  assert.strictEqual(total, expect);
  for (const area of seed.areas) assert.strictEqual(seed.data[area].participants.length, seed.months.length);
});

test("historyRank 与 heat", () => {
  assert.deepStrictEqual(M.historyRank([5, 9, 7, 3], 2, 4), { rank: 2, of: 4 });
  assert.deepStrictEqual(M.historyRank([5, 9, 7, 3], 3, 3), { rank: 4, of: 4 });
  assert.strictEqual(M.heat(30, 365), 1);
  assert.strictEqual(M.heat(1, 0), null);
});

test("toCSV 转义", () => {
  assert.strictEqual(M.toCSV([["a,b", 'x"y', null], [1, 2, 3]]), '"a,b","x""y",\r\n1,2,3');
});

test("大区分组覆盖全部 35 区域且不重复", () => {
  const all = Object.values(M.GROUPS).flat();
  assert.strictEqual(all.length, 35);
  assert.deepStrictEqual([...new Set(all)].sort(), seed.areas.filter(a => a !== "全国").sort());
});
console.log(`${n} passed`);
