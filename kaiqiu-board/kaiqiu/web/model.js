"use strict";
// 纯计算函数：页面和 Node 测试共用，不碰 DOM。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  const METRICS = {
    participants: { key: "participants", label: "参赛人次", unit: "人次", short: "人次" },
    events: { key: "events", label: "比赛场次", unit: "场", short: "场次" },
  };

  // 大区分组（自定义对比的快捷选择）
  const GROUPS = {
    "华北": ["北京", "天津", "河北", "山西", "内蒙古"],
    "东北": ["辽宁", "吉林", "黑龙江"],
    "华东": ["上海", "江苏", "浙江", "安徽", "福建", "江西", "山东"],
    "华中": ["河南", "湖北", "湖南"],
    "华南": ["广东", "广西", "海南"],
    "西南": ["重庆", "四川", "贵州", "云南", "西藏"],
    "西北": ["陕西", "甘肃", "青海", "宁夏", "新疆"],
    "港澳台及海外": ["香港", "澳门", "台湾", "海外"],
  };

  const rate = (cur, base) => (base == null || base === 0 || cur == null ? null : (cur - base) / base);

  function derive(values) {
    const n = values.length;
    const delta = new Array(n), mom = new Array(n), yoyDelta = new Array(n), yoy = new Array(n), streak = new Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? values[i - 1] : null;
      delta[i] = prev == null ? null : values[i] - prev;
      mom[i] = rate(values[i], prev);
      const ly = i >= 12 ? values[i - 12] : null;
      yoyDelta[i] = ly == null ? null : values[i] - ly;
      yoy[i] = rate(values[i], ly);
      s = delta[i] != null && delta[i] > 0 ? s + 1 : 0;
      streak[i] = s;
    }
    return { values, delta, mom, yoyDelta, yoy, streak };
  }

  // 有增长率显示百分比；基数为 0 而本期为正显示“新增”；否则 —
  function growthText(r, d) {
    if (r != null) return (r > 0 ? "+" : "") + (r * 100).toFixed(1) + "%";
    return d != null && d > 0 ? "新增" : "—";
  }

  function sum(values, i0, i1) {
    let t = 0;
    for (let i = i0; i <= i1; i++) t += values[i] || 0;
    return t;
  }

  // 区间同比：每个月各自前移 12 个月；有任何一个月没有基数就不算
  function rangeYoY(values, i0, i1) {
    const value = sum(values, i0, i1);
    if (i0 - 12 < 0) return { value, base: null, delta: null, rate: null };
    const base = sum(values, i0 - 12, i1 - 12);
    return { value, base, delta: value - base, rate: rate(value, base) };
  }

  // 历史排名：该月数值在全部完整月份里排第几（降序）
  function historyRank(values, i, completeCount) {
    const pool = values.slice(0, completeCount);
    if (i >= completeCount) pool.push(values[i]);
    const v = values[i];
    return { rank: pool.filter(x => x > v).length + 1, of: pool.length };
  }

  function completeCount(months, currentMonth) {
    let c = 0;
    for (const m of months) if (m < currentMonth) c++;
    return c;
  }

  // 按年汇总。未结束年份只与去年“相同月份”比较。
  function annual(months, values, currentMonth, includeOpen) {
    const byYear = new Map();
    months.forEach((m, i) => {
      if (!includeOpen && m >= currentMonth) return;
      const y = +m.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(i);
    });
    const out = [];
    for (const [year, idx] of byYear) {
      const value = idx.reduce((t, i) => t + values[i], 0);
      const open = idx.some(i => months[i] >= currentMonth);
      let base = null;
      if (idx.every(i => i - 12 >= 0)) base = idx.reduce((t, i) => t + values[i - 12], 0);
      out.push({ year, value, months: idx.length, full: idx.length === 12 && !open, open, base,
        delta: base == null ? null : value - base, yoy: rate(value, base),
        firstMonth: months[idx[0]], lastMonth: months[idx[idx.length - 1]] });
    }
    return out.sort((a, b) => a.year - b.year);
  }

  function periodKey(month, gran) {
    const y = month.slice(0, 4), m = +month.slice(5, 7);
    if (gran === "year") return y;
    if (gran === "quarter") return `${y}Q${Math.ceil(m / 3)}`;
    return month;
  }

  // 把 [i0, i1] 区间按月/季/年分组求和
  function group(months, values, i0, i1, gran, currentMonth) {
    const out = [];
    let cur = null;
    for (let i = i0; i <= i1; i++) {
      const k = periodKey(months[i], gran);
      if (!cur || cur.key !== k) { cur = { key: k, value: 0, months: 0, open: false, idx: [] }; out.push(cur); }
      cur.value += values[i];
      cur.months += 1;
      cur.idx.push(i);
      if (months[i] >= currentMonth) cur.open = true;
    }
    const need = gran === "year" ? 12 : gran === "quarter" ? 3 : 1;
    out.forEach(g => { g.partial = g.months < need || g.open; });
    return out;
  }

  // 季节性：最近 years 个年份，每年 12 个月的数值（缺月为 null）
  function seasonality(months, values, currentMonth, years) {
    const map = new Map();
    months.forEach((m, i) => {
      const y = +m.slice(0, 4);
      if (!map.has(y)) map.set(y, new Array(12).fill(null));
      map.get(y)[+m.slice(5, 7) - 1] = { value: values[i], open: m >= currentMonth };
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]).slice(-years).map(([year, arr]) => ({ year, points: arr }));
  }

  // 热度：近30天日均 / 近365天日均
  function heat(p30, p365) {
    if (!p365) return null;
    return (p30 / 30) / (p365 / 365);
  }

  function toCSV(rows) {
    return rows.map(r => r.map(v => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");
  }

  return { METRICS, GROUPS, rate, derive, growthText, sum, rangeYoY, historyRank, completeCount, annual,
    group, periodKey, seasonality, heat, toCSV };
});
