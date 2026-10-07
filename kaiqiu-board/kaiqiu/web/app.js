"use strict";
(() => {
  const M = window.KModel;
  const $ = id => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get("t") || "";
  const NATIONAL = "全国";
  const STATE_KEY = "kaiqiu-board-state-v1";
  const fmtN = v => v == null ? "—" : Math.round(v).toLocaleString("zh-CN");
  const fmtP = (v, d = 1) => v == null ? "—" : (v * 100).toFixed(d) + "%";
  const signed = v => v == null ? "—" : (v > 0 ? "+" : "") + fmtN(v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function growth(r, d) {
    const t = M.growthText(r, d);
    if (t === "—") return '<span class="muted">—</span>';
    const up = r != null ? r > 0 : d > 0, down = r != null && r < 0;
    return `<span class="${up ? "up" : down ? "down" : ""}">${up ? "▲ " : down ? "▼ " : ""}${t}</span>`;
  }

  // ---------- 状态 ----------
  const DEFAULTS = {
    tab: "overview", metric: "participants", month: null, ovRange: "24", heatMode: "yoy",
    rgArea: null, rgSort: { key: "value", asc: false }, rgSearch: "",
    anArea: NATIONAL, anYear: null, anOpen: false,
    cp: { areas: [NATIONAL], slots: { [NATIONAL]: 0 }, start: null, end: null, gran: "month", mode: "overlay", chart: "line" },
    pdPeriod: "近30天", pdSort: "participants", tbArea: NATIONAL, theme: "auto", zoom: 1,
  };
  let S;
  try { S = Object.assign(structuredClone(DEFAULTS), JSON.parse(localStorage.getItem(STATE_KEY) || "{}")); }
  catch { S = structuredClone(DEFAULTS); }
  const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch { /* 无痕模式 */ } };

  let D = null, status = null, cache = {}, idx = {}, lastComplete = 0, charts = {};
  const metric = () => M.METRICS[S.metric];
  const regions = () => D.areas.filter(a => a !== NATIONAL);
  const isOpen = i => D.months[i] >= D.current_month;
  function series(area, key = S.metric) {
    const k = area + "|" + key;
    return cache[k] || (cache[k] = M.derive(D.data[area][key]));
  }
  const monthI = () => {
    const i = S.month ? idx[S.month] : undefined;
    return i == null ? lastComplete : i;
  };
  const label = m => m ? `${m.slice(0, 4)}年${+m.slice(5)}月` : "";

  // ---------- 网络 ----------
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", "X-Kaiqiu-Token": TOKEN }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function loadData() {
    D = await api("/api/data");
    cache = {}; idx = {};
    D.months.forEach((m, i) => { idx[m] = i; });
    lastComplete = Math.max(0, M.completeCount(D.months, D.current_month) - 1);
    if (S.month && idx[S.month] == null) S.month = null;
    if (!S.rgArea || !D.data[S.rgArea] || S.rgArea === NATIONAL) {
      const v = regions().map(a => [a, D.data[a].participants[lastComplete]]).sort((a, b) => b[1] - a[1]);
      S.rgArea = v[0][0];
    }
    for (const k of ["anArea", "tbArea"]) if (!D.data[S[k]]) S[k] = NATIONAL;
    S.cp.areas = S.cp.areas.filter(a => D.data[a]);
    if (!S.cp.start || idx[S.cp.start] == null || !S.cp.end || idx[S.cp.end] == null) setCompareRange(24);
    fillSelects();
    renderAll();
  }

  // ---------- 下拉框 ----------
  function options(el, items, value) {
    el.innerHTML = items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    if (value != null) el.value = value;
  }
  function fillSelects() {
    const months = D.months.map((m, i) => [m, m + (isOpen(i) ? "（进行中）" : "")]);
    options($("month"), [...months].reverse(), D.months[monthI()]);
    options($("cp-start"), months, S.cp.start);
    options($("cp-end"), months, S.cp.end);
    const areas = D.areas.map(a => [a, a]);
    options($("an-area"), areas, S.anArea);
    options($("tb-area"), areas, S.tbArea);
  }

  // ---------- 图表基础 ----------
  function chart(id) {
    if (!charts[id]) {
      charts[id] = echarts.init($(id), null, { renderer: "canvas" });
    }
    return charts[id];
  }
  function disposeCharts() { Object.values(charts).forEach(c => c.dispose()); charts = {}; }
  const fs = n => Math.round(n * (S.zoom || 1));
  function base() {
    const text = css("--text-2"), line = css("--line");
    return {
      animationDuration: 300,
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, fontSize: fs(12), color: text },
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      tooltip: { backgroundColor: css("--card"), borderColor: css("--line-strong"), textStyle: { color: css("--text"), fontSize: fs(12) }, confine: true },
      _legend: { textStyle: { color: text, fontSize: fs(12) }, icon: "roundRect", itemWidth: 14, itemHeight: 4 },
      _axis: { axisLine: { lineStyle: { color: css("--line-strong") } }, axisTick: { show: false },
        axisLabel: { color: css("--muted"), fontSize: fs(11) }, splitLine: { lineStyle: { color: line } } },
    };
  }
  const slot = n => css(`--s${(n % 8) + 1}`);
  const xCat = (b, data, extra = {}) => Object.assign({ type: "category", data, boundaryGap: false }, b._axis, { splitLine: { show: false } }, extra);
  const yVal = (b, extra = {}) => Object.assign({ type: "value", axisLabel: Object.assign({}, b._axis.axisLabel, { formatter: v => compact(v) }) },
    { axisLine: { show: false }, axisTick: { show: false }, splitLine: b._axis.splitLine }, extra);
  function compact(v) {
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(Math.abs(v) >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "万";
    return String(Math.round(v * 100) / 100);
  }
  // 完整月份实线 + 进行中月份虚线
  function splitOpen(values, months) {
    const open = months.map(m => m >= D.current_month);
    const solid = values.map((v, i) => open[i] ? null : v);
    const dashed = values.map((v, i) => (open[i] || open[i + 1]) ? v : null);
    return { solid, dashed, hasOpen: open.some(Boolean) };
  }
  function lineSeries(name, values, months, color, extra = {}) {
    const s = splitOpen(values, months);
    const common = { type: "line", showSymbol: false, symbolSize: 8, lineStyle: { width: 2, color }, itemStyle: { color }, emphasis: { focus: "series" } };
    const out = [Object.assign({ name, data: s.solid }, common, extra)];
    if (s.hasOpen) out.push(Object.assign({}, common, { name, data: s.dashed, lineStyle: { width: 2, color, type: "dashed" }, tooltip: { show: false } }));
    return out;
  }
  function seasonDecal() {
    return { symbol: "rect", symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: "rgba(255,255,255,.55)" };
  }

  // ---------- 概览 ----------
  function renderOverview() {
    const m = metric(), i = monthI(), nat = series(NATIONAL), v = nat.values;
    const r12 = i >= 11 ? M.rangeYoY(v, i - 11, i) : null;
    const hr = M.historyRank(v, i, lastComplete + 1);
    let best = 0;
    for (let k = 0; k <= lastComplete; k++) if (v[k] > v[best]) best = k;
    const open = isOpen(i) ? '<span class="tag">进行中</span>' : "";
    $("kpis").innerHTML = [
      [`全国${m.label}`, fmtN(v[i]) + open, label(D.months[i])],
      ["环比", growth(nat.mom[i], nat.delta[i]), `增量 ${signed(nat.delta[i])} · 上月 ${fmtN(i ? v[i - 1] : null)}`],
      ["同比", growth(nat.yoy[i], nat.yoyDelta[i]), `去年同月 ${fmtN(i >= 12 ? v[i - 12] : null)}`],
      ["近 12 个月累计", r12 ? fmtN(r12.value) : "—", r12 ? `同比 ${M.growthText(r12.rate, r12.delta)}` : "历史不足 12 个月"],
      ["历史排名", `第 ${hr.rank} 高`, `共 ${hr.of} 个月 · 最高 ${fmtN(v[best])}（${D.months[best]}）`],
    ].map(([a, b, c]) => `<div class="kpi"><span>${a}</span><strong>${b}</strong><small>${esc(c)}</small></div>`).join("");

    // 趋势
    $("ov-trend-title").textContent = `全国${m.label}趋势`;
    const b = base(), color = slot(0);
    const opt = Object.assign(b, {
      tooltip: Object.assign(b.tooltip, { trigger: "axis", formatter: ps => trendTip(NATIONAL, ps[0].dataIndex) }),
      xAxis: xCat(b, D.months), yAxis: yVal(b),
      grid: Object.assign(b.grid, { bottom: 48 }),
      dataZoom: [{ type: "inside" }, { type: "slider", height: 22, bottom: 6, borderColor: css("--line"), textStyle: { color: css("--muted") } }],
      series: lineSeries(m.label, v, D.months, color),
    });
    opt.series[0].markLine = { symbol: "none", silent: true, label: { formatter: "所选月份", color: css("--muted"), fontSize: fs(11) },
      lineStyle: { color: css("--muted"), type: "dotted" }, data: [{ xAxis: D.months[i] }] };
    const c = chart("ov-trend");
    c.setOption(opt, true);
    applyRange(c, S.ovRange);
    c.off("click"); c.getZr().off("click");
    c.getZr().on("click", e => {
      const p = c.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
      if (p && p[0] >= 0 && p[0] < D.months.length) { S.month = D.months[Math.round(p[0])]; $("month").value = S.month; save(); renderOverview(); }
    });
    segSet("ov-range", S.ovRange);

    // 前 12
    const rows = regions().map(a => ({ a, v: series(a).values[i] })).sort((x, y) => y.v - x.v);
    const top = rows.slice(0, 12).reverse();
    $("ov-top-title").textContent = `区域${m.short}前 12`;
    $("ov-top-sub").textContent = `${label(D.months[i])}${isOpen(i) ? "（进行中）" : ""} · 点击柱子看区域详情`;
    const b2 = base();
    const tc = chart("ov-top");
    tc.setOption(Object.assign(b2, {
      grid: Object.assign(b2.grid, { right: 56 }),
      tooltip: Object.assign(b2.tooltip, { trigger: "item", formatter: p => `${esc(p.name)}<br>${fmtN(p.value)} ${m.unit}<br>占全国 ${fmtP(p.value / v[i])}` }),
      xAxis: yVal(b2), yAxis: Object.assign({ type: "category", data: top.map(r => r.a) }, b2._axis, { splitLine: { show: false } }),
      series: [{ type: "bar", data: top.map(r => r.v), barWidth: "62%", itemStyle: { color: slot(0), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: css("--text-2"), fontSize: fs(11), formatter: p => compact(p.value) } }],
    }), true);
    tc.off("click"); tc.on("click", p => gotoRegion(p.name));

    // 涨跌榜：基数太小的区域波动没有意义，过滤掉
    const minBase = S.metric === "participants" ? 300 : 20;
    const ys = regions().map(a => { const s = series(a); return { a, r: s.yoy[i], d: s.yoyDelta[i], base: i >= 12 ? s.values[i - 12] : null }; })
      .filter(x => x.r != null && x.base >= minBase);
    const ups = [...ys].sort((x, y) => y.r - x.r).slice(0, 6), downs = [...ys].sort((x, y) => x.r - y.r).slice(0, 6);
    const li = x => `<li data-area="${esc(x.a)}"><span>${esc(x.a)} <small>${signed(x.d)}</small></span>${growth(x.r, x.d)}</li>`;
    $("ov-movers").innerHTML = `<div><h3>增长最快</h3><ol>${ups.filter(x => x.r > 0).map(li).join("") || "<li>无</li>"}</ol></div>
      <div><h3>下降最多</h3><ol>${downs.filter(x => x.r < 0).map(li).join("") || "<li>无</li>"}</ol></div>`;
    $("ov-movers-sub").textContent = `${label(D.months[i])} 与去年同月比 · 只统计去年同月 ≥ ${minBase} ${m.unit} 的区域`;
    renderHeat(i);
  }

  function trendTip(area, k) {
    const s = series(area), m = metric();
    const tag = isOpen(k) ? ' <span style="color:var(--open)">进行中</span>' : "";
    return `<b>${esc(area)} · ${label(D.months[k])}</b>${tag}<br>${m.label} <b>${fmtN(s.values[k])}</b>` +
      `<br>环比 ${M.growthText(s.mom[k], s.delta[k])}（${signed(s.delta[k])}）` +
      `<br>同比 ${M.growthText(s.yoy[k], s.yoyDelta[k])}（${signed(s.yoyDelta[k])}）` +
      (k >= 12 ? `<br><span style="opacity:.7">去年同月 ${fmtN(s.values[k - 12])}</span>` : "");
  }

  function applyRange(c, n) {
    n = +n;
    const end = D.months.length - 1, start = n ? Math.max(0, end - n + 1) : 0;
    c.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, startValue: start, endValue: end });
    c.dispatchAction({ type: "dataZoom", dataZoomIndex: 1, startValue: start, endValue: end });
  }

  function renderHeat(i) {
    const n = Math.min(24, i + 1), months = D.months.slice(i - n + 1, i + 1);
    const nat = series(NATIONAL).values;
    const order = regions().map(a => ({ a, v: series(a).values[i] })).sort((x, y) => x.v - y.v).map(x => x.a);
    const data = [];
    order.forEach((a, y) => {
      const s = series(a);
      months.forEach((mm, x) => {
        const k = i - n + 1 + x;
        const val = S.heatMode === "yoy" ? (s.yoy[k] == null ? null : Math.max(-1, Math.min(1, s.yoy[k]))) : (nat[k] ? s.values[k] / nat[k] : null);
        data.push([x, y, val == null ? "-" : val, k]);
      });
    });
    const dark = document.documentElement.dataset.resolved === "dark";
    const b = base(), m = metric();
    $("ov-heat-sub").textContent = S.heatMode === "yoy"
      ? `每格 = 该区域该月${m.short}与去年同月相比；蓝色增长、红色下降，空白为没有基数` : `每格 = 该区域该月${m.short}占全国的比例`;
    chart("ov-heat").setOption(Object.assign(b, {
      grid: { left: 8, right: 16, top: 8, bottom: 72, containLabel: true },
      tooltip: Object.assign(b.tooltip, { trigger: "item", formatter: p => {
        const [x, y, , k] = p.data, a = order[y], s = series(a);
        return `<b>${esc(a)} · ${label(months[x])}</b><br>${m.label} ${fmtN(s.values[k])}<br>同比 ${M.growthText(s.yoy[k], s.yoyDelta[k])}<br>占全国 ${fmtP(nat[k] ? s.values[k] / nat[k] : null)}`;
      } }),
      xAxis: Object.assign({ type: "category", data: months, splitArea: { show: false } }, b._axis, { splitLine: { show: false } }),
      yAxis: Object.assign({ type: "category", data: order }, b._axis, { splitLine: { show: false } }),
      visualMap: S.heatMode === "yoy"
        ? { min: -0.6, max: 0.6, calculable: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 220,
            dimension: 2, textStyle: { color: css("--muted") }, formatter: v => fmtP(v, 0),
            inRange: { color: [css("--div-neg"), css("--div-mid"), css("--div-pos")] } }
        : { dimension: 2, min: 0, max: Math.max(0.05, ...data.map(d => typeof d[2] === "number" ? d[2] : 0)), calculable: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 220,
            textStyle: { color: css("--muted") }, formatter: v => fmtP(v, 0),
            inRange: { color: dark ? ["#1f2e42", "#3987e5", "#cde2fb"] : ["#e6f0fb", "#2a78d6", "#0d366b"] } },
      series: [{ type: "heatmap", data, itemStyle: { borderColor: css("--card"), borderWidth: 1 }, emphasis: { itemStyle: { borderColor: css("--text"), borderWidth: 1 } } }],
    }), true);
    const hc = chart("ov-heat");
    hc.off("click"); hc.on("click", p => gotoRegion(order[p.data[1]]));
    segSet("heat-mode", S.heatMode);
  }

  // ---------- 区域 ----------
  function gotoRegion(a) {
    if (a === NATIONAL) return;
    S.rgArea = a; switchTab("regions");
  }
  function spark(values) {
    const w = 96, h = 22, max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1 || 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--s1)" stroke-width="1.5"/></svg>`;
  }
  function regionRows(i) {
    const nat = series(NATIONAL).values[i];
    return regions().map(a => {
      const s = series(a);
      return { name: a, value: s.values[i], share: nat ? s.values[i] / nat : null, mom: s.mom[i], delta: s.delta[i],
        yoy: s.yoy[i], yoyDelta: s.yoyDelta[i], streak: s.streak[i], spark: s.values.slice(Math.max(0, i - 23), i + 1) };
    });
  }
  function renderRegions() {
    const i = monthI(), m = metric();
    let rows = regionRows(i);
    const byValue = [...rows].sort((a, b) => b.value - a.value).map(r => r.name);
    const { key, asc } = S.rgSort;
    const nullLast = (a, b) => (a == null) - (b == null);
    rows.sort((a, b) => key === "name" ? a.name.localeCompare(b.name, "zh") * (asc ? 1 : -1)
      : nullLast(a[key], b[key]) || (asc ? a[key] - b[key] : b[key] - a[key]));
    const q = S.rgSearch.trim();
    if (q) rows = rows.filter(r => r.name.includes(q));
    $("rg-sub").textContent = `${label(D.months[i])}${isOpen(i) ? "（进行中）" : ""} · ${m.label}`;
    document.querySelectorAll("#rg-table th[data-sort]").forEach(th => {
      th.classList.toggle("sorted", th.dataset.sort === key); th.classList.toggle("asc", th.dataset.sort === key && asc);
    });
    $("rg-table").querySelector("tbody").innerHTML = rows.map(r => `<tr class="clickable${r.name === S.rgArea ? " selected" : ""}" data-area="${esc(r.name)}">
      <td>${byValue.indexOf(r.name) + 1}. ${esc(r.name)}</td><td class="num">${fmtN(r.value)}</td><td class="num">${fmtP(r.share)}</td>
      <td class="num">${growth(r.mom, r.delta)}</td><td class="num">${growth(r.yoy, r.yoyDelta)}</td><td class="num">${r.streak || ""}</td><td>${spark(r.spark)}</td></tr>`).join("");
    // 详情
    const a = S.rgArea, s = series(a);
    $("rg-kpis").innerHTML = [
      [`${a} · ${label(D.months[i])}`, fmtN(s.values[i]) + (isOpen(i) ? '<span class="tag">进行中</span>' : ""), `${m.label}，全国第 ${byValue.indexOf(a) + 1} 名`],
      ["占全国", fmtP(series(NATIONAL).values[i] ? s.values[i] / series(NATIONAL).values[i] : null), "同月全国口径"],
      ["环比", growth(s.mom[i], s.delta[i]), `增量 ${signed(s.delta[i])}`],
      ["同比", growth(s.yoy[i], s.yoyDelta[i]), `去年同月 ${fmtN(i >= 12 ? s.values[i - 12] : null)}`],
    ].map(([x, y, z]) => `<div class="kpi"><span>${esc(x)}</span><strong>${y}</strong><small>${esc(z)}</small></div>`).join("");
    $("rg-trend-title").textContent = `${a} ${m.label}趋势`;
    const b = base();
    const c = chart("rg-trend");
    c.setOption(Object.assign(b, {
      tooltip: Object.assign(b.tooltip, { trigger: "axis", formatter: ps => trendTip(a, ps[0].dataIndex) }),
      xAxis: xCat(b, D.months), yAxis: yVal(b), grid: Object.assign(b.grid, { bottom: 44 }),
      dataZoom: [{ type: "inside" }, { type: "slider", height: 20, bottom: 4, borderColor: css("--line"), textStyle: { color: css("--muted") } }],
      series: lineSeries(m.label, s.values, D.months, slot(0)),
    }), true);
    applyRange(c, 60);
    // 季节规律
    const seasons = M.seasonality(D.months, s.values, D.current_month, 4).reverse();
    $("rg-season-title").textContent = `${a} 季节规律`;
    const b2 = base();
    chart("rg-season").setOption(Object.assign(b2, {
      legend: Object.assign(b2._legend, { top: 0, right: 0 }),
      tooltip: Object.assign(b2.tooltip, { trigger: "axis", valueFormatter: v => fmtN(v) }),
      xAxis: xCat(b2, Array.from({ length: 12 }, (_, k) => `${k + 1}月`)), yAxis: yVal(b2),
      grid: Object.assign(b2.grid, { top: 32 }),
      series: seasons.map((y, k) => ({ name: String(y.year), type: "line", showSymbol: false, symbolSize: 8,
        data: y.points.map(p => p ? p.value : null), lineStyle: { width: k === 0 ? 2.5 : 2, color: slot(k) }, itemStyle: { color: slot(k) } })),
    }), true);
  }

  // ---------- 年度 ----------
  function renderAnnual() {
    const m = metric(), a = S.anArea, v = series(a).values;
    const list = M.annual(D.months, v, D.current_month, S.anOpen);
    if (!list.length) return;
    if (!S.anYear || !list.some(x => x.year === +S.anYear)) S.anYear = list[list.length - 1].year;
    options($("an-year"), [...list].reverse().map(x => [x.year, x.year + (x.full ? "" : `（${x.months}个月）`)]), S.anYear);
    $("an-area").value = a; $("an-open").checked = S.anOpen;
    const y = list.find(x => x.year === +S.anYear);
    $("an-note").textContent = y.full ? "" : `${y.year} 年计入 ${y.firstMonth}–${y.lastMonth}，与去年相同月份比较`;
    let peak = y.firstMonth, pv = -1;
    D.months.forEach((mm, k) => { if (mm.startsWith(y.year + "-") && (S.anOpen || !isOpen(k)) && v[k] > pv) { pv = v[k]; peak = mm; } });
    $("an-kpis").innerHTML = [
      [`${a} ${y.year} 年${m.label}`, fmtN(y.value) + (y.full ? "" : `<span class="tag">${y.months} 个月</span>`), y.open ? "含进行中月份" : "完整月份合计"],
      ["同比（同口径）", growth(y.yoy, y.delta), y.base == null ? "没有去年同期数据" : `去年同期 ${fmtN(y.base)}`],
      ["同比增量", signed(y.delta), y.full ? "全年对全年" : `去年同样 ${y.months} 个月`],
      ["月均", fmtN(y.value / y.months), `${y.months} 个月平均`],
      ["年内最高月", fmtN(pv), label(peak)],
    ].map(([x, yv, z]) => `<div class="kpi"><span>${esc(x)}</span><strong>${yv}</strong><small>${esc(z)}</small></div>`).join("");

    $("an-bars-title").textContent = `${a} 历年${m.label}`;
    const b = base(), color = slot(0);
    const bc = chart("an-bars");
    bc.setOption(Object.assign(b, {
      tooltip: Object.assign(b.tooltip, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ps => {
        const x = list[ps[0].dataIndex];
        return `<b>${x.year} 年</b>${x.full ? "" : `（${x.firstMonth.slice(5)}–${x.lastMonth.slice(5)} 月）`}<br>${m.label} <b>${fmtN(x.value)}</b><br>同比 ${M.growthText(x.yoy, x.delta)}（${signed(x.delta)}）` +
          (x.base == null ? "" : `<br><span style="opacity:.7">去年同期 ${fmtN(x.base)}</span>`);
      } }),
      xAxis: Object.assign(xCat(b, list.map(x => String(x.year))), { boundaryGap: true }), yAxis: yVal(b),
      series: [{ type: "bar", barMaxWidth: 36, data: list.map(x => ({ value: x.value, itemStyle: {
        color, opacity: x.year === +S.anYear ? 1 : 0.55, borderRadius: [4, 4, 0, 0], decal: x.full ? undefined : seasonDecal() } })) }],
    }), true);
    bc.off("click"); bc.on("click", p => { S.anYear = list[p.dataIndex].year; save(); renderAnnual(); });

    $("an-months-title").textContent = `${y.year} 与 ${y.year - 1} 逐月对照`;
    const seasons = M.seasonality(D.months, v, D.current_month, 100).filter(s => s.year === y.year || s.year === y.year - 1).reverse();
    const b2 = base();
    chart("an-months").setOption(Object.assign(b2, {
      legend: Object.assign(b2._legend, { top: 0, right: 0 }),
      tooltip: Object.assign(b2.tooltip, { trigger: "axis", valueFormatter: x => fmtN(x) }),
      xAxis: Object.assign(xCat(b2, Array.from({ length: 12 }, (_, k) => `${k + 1}月`)), { boundaryGap: true }), yAxis: yVal(b2),
      grid: Object.assign(b2.grid, { top: 32 }),
      series: seasons.map((s, k) => ({ name: `${s.year} 年`, type: "bar", barMaxWidth: 18, itemStyle: { color: slot(k), borderRadius: [3, 3, 0, 0] },
        data: s.points.map(p => p && (S.anOpen || !p.open) ? p.value : null) })),
    }), true);

    // 区域年度排名（与所选年同样的月份）
    const ks = [];
    D.months.forEach((mm, k) => { if (mm.startsWith(y.year + "-") && (S.anOpen || !isOpen(k))) ks.push(k); });
    const natSum = ks.reduce((t, k) => t + series(NATIONAL).values[k], 0);
    const rows = regions().map(r => {
      const vv = series(r).values, val = ks.reduce((t, k) => t + vv[k], 0);
      const bs = ks.every(k => k >= 12) ? ks.reduce((t, k) => t + vv[k - 12], 0) : null;
      return { r, val, share: natSum ? val / natSum : null, yoy: M.rate(val, bs), d: bs == null ? null : val - bs };
    }).sort((p, q) => q.val - p.val);
    $("an-rank-title").textContent = `${y.year} 年区域${m.label}排名`;
    $("an-rank-sub").textContent = `${ks.length} 个月 · 点击区域切换上方图表`;
    $("an-table").querySelector("tbody").innerHTML = rows.map((x, k) => `<tr class="clickable${x.r === a ? " selected" : ""}" data-area="${esc(x.r)}"><td>${k + 1}</td><td>${esc(x.r)}</td>
      <td class="num">${fmtN(x.val)}</td><td class="num">${fmtP(x.share)}</td><td class="num">${growth(x.yoy, x.d)}</td><td class="num">${signed(x.d)}</td><td class="num">${ks.length}</td></tr>`).join("");
  }

  // ---------- 自定义对比 ----------
  function setCompareRange(n) {
    const end = lastComplete, start = n ? Math.max(0, end - n + 1) : 0;
    S.cp.start = D.months[start]; S.cp.end = D.months[end];
  }
  function freeSlot() {
    const used = new Set(S.cp.areas.map(a => S.cp.slots[a]));
    for (let k = 0; k < 8; k++) if (!used.has(k)) return k;
    return null;
  }
  function toggleArea(a) {
    const cp = S.cp;
    if (cp.areas.includes(a)) { cp.areas = cp.areas.filter(x => x !== a); delete cp.slots[a]; }
    else {
      const k = freeSlot();
      if (k == null && cp.mode !== "sum") return toast("叠加最多 8 条线。要比较更多区域，请把“方式”改成“合并加总”。");
      cp.areas.push(a);
      if (k != null) cp.slots[a] = k;
    }
  }
  function setAreas(list) {
    S.cp.areas = []; S.cp.slots = {};
    list.forEach(a => { const k = freeSlot(); S.cp.areas.push(a); if (k != null) S.cp.slots[a] = k; });
    if (list.length > 8 && S.cp.mode !== "sum") S.cp.mode = "sum";
  }
  let cpExport = null;
  function renderCompare() {
    const cp = S.cp, m = metric();
    $("cp-start").value = cp.start; $("cp-end").value = cp.end;
    $("cp-gran").value = cp.gran; $("cp-mode").value = cp.mode; $("cp-chart").value = cp.chart;
    $("cp-groups").innerHTML = `<button class="btn small" data-group="__nat">只看全国</button><button class="btn small" data-group="__all">35 区域</button>` +
      Object.keys(M.GROUPS).map(g => `<button class="btn small" data-group="${esc(g)}">${esc(g)}</button>`).join("") +
      `<button class="btn small" data-group="__clear">清空</button>`;
    $("cp-areas").innerHTML = D.areas.map(a => {
      const on = cp.areas.includes(a), c = on && cp.slots[a] != null ? `background:var(--s${cp.slots[a] + 1});border-color:transparent` : "";
      return `<button class="chip" aria-pressed="${on}" data-area="${esc(a)}"><i style="${c}"></i>${esc(a)}</button>`;
    }).join("");
    const err = msg => { $("cp-error").hidden = !msg; $("cp-error").textContent = msg || ""; };
    const i0 = idx[cp.start], i1 = idx[cp.end];
    err("");
    if (i0 > i1) { err("开始月份晚于结束月份，请调整。"); chart("cp-chart-el").clear(); cpExport = null; return; }
    if (!cp.areas.length) { err("请至少选择一个区域。"); chart("cp-chart-el").clear(); cpExport = null; return; }
    let areas = [...cp.areas];
    if (cp.mode === "sum" && areas.includes(NATIONAL) && areas.length > 1) {
      err("全国已包含各区域，加总时已自动排除“全国”，避免重复计算。");
      areas = areas.filter(a => a !== NATIONAL);
    }
    if (cp.mode !== "sum" && areas.length > 8) { err("叠加最多 8 条线，请减少区域或改用“合并加总”。"); chart("cp-chart-el").clear(); cpExport = null; return; }
    const nat = series(NATIONAL).values;
    const groups = M.group(D.months, nat, i0, i1, cp.gran, D.current_month);
    const keys = groups.map(g => g.key);
    const natG = groups.map(g => g.value);
    const sumOf = vs => M.group(D.months, vs, i0, i1, cp.gran, D.current_month).map(g => g.value);
    let lines;
    if (cp.mode === "sum") {
      const total = D.months.map((_, k) => areas.reduce((t, a) => t + series(a).values[k], 0));
      lines = [{ name: areas.length === 1 ? areas[0] : `${areas.length} 个区域合计`, color: slot(0), vals: sumOf(total), raw: total }];
    } else {
      lines = areas.map(a => ({ name: a, color: slot(cp.slots[a] ?? 0), vals: sumOf(series(a).values), raw: series(a).values }));
    }
    let yFmt = v => compact(v), tipFmt = v => fmtN(v), unit = m.unit;
    let warn = "";
    if (cp.mode === "share") {
      lines.forEach(l => { l.vals = l.vals.map((v, k) => natG[k] ? v / natG[k] : null); });
      yFmt = v => fmtP(v, 0); tipFmt = v => fmtP(v, 2); unit = "占全国";
    } else if (cp.mode === "index") {
      lines.forEach(l => {
        const b0 = l.vals[0];
        if (!b0) warn = `${l.name} 起点为 0，无法指数化，已留空。`;
        l.vals = l.vals.map(v => b0 ? v / b0 * 100 : null);
      });
      yFmt = v => String(Math.round(v)); tipFmt = v => v == null ? "—" : v.toFixed(1); unit = "指数";
    }
    if (warn) err(warn);
    const partial = groups.map(g => g.partial);
    const modeName = { overlay: "对比", sum: "合计", share: "占全国比例", index: "指数（起点=100）" }[cp.mode];
    $("cp-title").textContent = `${m.label}${modeName}`;
    const nMonths = i1 - i0 + 1, hasOpen = isOpen(i1);
    $("cp-sub").textContent = `${unit} · ${cp.start} 至 ${cp.end}，${nMonths} 个月 · ${{ month: "按月", quarter: "按季", year: "按年" }[cp.gran]}` +
      (hasOpen ? " · 含进行中月份" : "") + (partial.some((p, k) => p && cp.gran !== "month" && !(hasOpen && k === partial.length - 1)) ? " · 首尾不完整的季/年用斜纹标出" : "");
    const b = base(), bar = cp.chart === "bar";
    const ser = lines.map(l => bar
      ? { name: l.name, type: "bar", barMaxWidth: 28, itemStyle: { color: l.color, borderRadius: [3, 3, 0, 0] },
          data: l.vals.map((v, k) => ({ value: v, itemStyle: partial[k] ? { decal: seasonDecal(), opacity: .7 } : {} })) }
      : { name: l.name, type: "line", showSymbol: l.vals.length < 40, symbolSize: 7, data: l.vals,
          lineStyle: { width: 2, color: l.color }, itemStyle: { color: l.color }, emphasis: { focus: "series" },
          endLabel: lines.length <= 4 ? { show: true, formatter: p => p.seriesName, color: css("--text-2"), fontSize: fs(11) } : undefined });
    chart("cp-chart-el").setOption(Object.assign(b, {
      legend: Object.assign(b._legend, { top: 0, left: 0, type: "scroll" }),
      grid: Object.assign(b.grid, { top: 36, right: lines.length <= 4 && !bar ? 70 : 16, bottom: keys.length > 30 ? 44 : 8 }),
      tooltip: Object.assign(b.tooltip, { trigger: "axis", axisPointer: { type: bar ? "shadow" : "line" }, formatter: ps => {
        const k = ps[0].dataIndex, g = groups[k];
        return `<b>${esc(g.key)}</b>${g.partial && cp.gran !== "month" ? `（${g.months} 个月）` : ""}${g.open ? " 进行中" : ""}<br>` +
          [...ps].sort((p, q) => (q.value ?? -Infinity) - (p.value ?? -Infinity)).map(p => `${p.marker}${esc(p.seriesName)}：<b>${tipFmt(p.value)}</b>`).join("<br>");
      } }),
      xAxis: Object.assign(xCat(b, keys), { boundaryGap: bar }), yAxis: yVal(b, { axisLabel: Object.assign({}, b._axis.axisLabel, { formatter: yFmt }) }),
      dataZoom: keys.length > 30 ? [{ type: "inside" }, { type: "slider", height: 20, bottom: 4, borderColor: css("--line") }] : [],
      series: ser,
    }), true);

    // 汇总表
    const natTotal = M.sum(nat, i0, i1);
    const rows = lines.map(l => ({ name: l.name, ...M.rangeYoY(l.raw, i0, i1) }));
    if (cp.mode !== "sum") {
      const regs = areas.filter(a => a !== NATIONAL);
      if (regs.length > 1) {
        const total = D.months.map((_, k) => regs.reduce((t, a) => t + series(a).values[k], 0));
        rows.push({ name: `以上 ${regs.length} 个区域合计`, ...M.rangeYoY(total, i0, i1), total: true });
      }
    }
    $("cp-table").querySelector("tbody").innerHTML = rows.map(r => `<tr${r.total ? ' class="selected"' : ""}><td>${esc(r.name)}</td><td class="num">${fmtN(r.value)}</td>
      <td class="num">${fmtN(r.value / nMonths)}</td><td class="num">${fmtP(natTotal ? r.value / natTotal : null)}</td><td class="num">${fmtN(r.base)}</td>
      <td class="num">${signed(r.delta)}</td><td class="num">${growth(r.rate, r.delta)}</td></tr>`).join("");
    cpExport = [["时间", ...lines.map(l => l.name)], ...keys.map((k, j) => [k, ...lines.map(l => l.vals[j] == null ? "" : +(+l.vals[j]).toFixed(cp.mode === "share" ? 6 : 2))])];
  }

  // ---------- 近期热度 ----------
  function renderPeriods() {
    const P = D.periods, rows = P[S.pdPeriod] || [];
    const p30 = Object.fromEntries((P["近30天"] || []).map(r => [r.region, r.participants]));
    const p365 = Object.fromEntries((P["近365天"] || []).map(r => [r.region, r.participants]));
    const total = rows.reduce((t, r) => t + r.participants, 0);
    const list = rows.map(r => ({ ...r, share: total ? r.participants / total : null, heat: M.heat(p30[r.region] || 0, p365[r.region]) }));
    const k = S.pdSort;
    list.sort((a, b) => (b[k] ?? -1) - (a[k] ?? -1));
    segSet("pd-period", S.pdPeriod); $("pd-sort").value = k;
    const names = { participants: "参赛人次", events: "比赛场次", games: "比赛盘数", heat: "热度指数" };
    $("pd-chart-title").textContent = `${S.pdPeriod}${names[k]}前 15`;
    const top = list.slice(0, 15).reverse(), b = base();
    chart("pd-chart").setOption(Object.assign(b, {
      grid: Object.assign(b.grid, { right: 56 }),
      tooltip: Object.assign(b.tooltip, { trigger: "item", formatter: p => {
        const r = top[p.dataIndex];
        return `<b>${esc(r.region)}</b><br>参赛人次 ${fmtN(r.participants)}<br>比赛场次 ${fmtN(r.events)}<br>比赛盘数 ${fmtN(r.games)}<br>热度 ${r.heat == null ? "—" : r.heat.toFixed(2)}`;
      } }),
      xAxis: yVal(b), yAxis: Object.assign({ type: "category", data: top.map(r => r.region) }, b._axis, { splitLine: { show: false } }),
      series: [{ type: "bar", barWidth: "62%", data: top.map(r => r[k]), itemStyle: { color: slot(0), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: css("--text-2"), fontSize: fs(11), formatter: p => k === "heat" ? p.value.toFixed(2) : compact(p.value) },
        markLine: k === "heat" ? { symbol: "none", data: [{ xAxis: 1 }], lineStyle: { color: css("--muted"), type: "dashed" }, label: { formatter: "全年平均", color: css("--muted") } } : undefined }],
    }), true);
    $("pd-table").querySelector("tbody").innerHTML = list.map((r, j) => `<tr><td>${j + 1}</td><td>${esc(r.region)}</td><td class="num">${fmtN(r.participants)}</td>
      <td class="num">${fmtN(r.events)}</td><td class="num">${fmtN(r.games)}</td><td class="num">${fmtP(r.share)}</td>
      <td class="num">${r.heat == null ? "—" : `<span class="${r.heat >= 1.15 ? "up" : r.heat <= 0.85 ? "down" : ""}">${r.heat.toFixed(2)}</span>`}</td></tr>`).join("");
  }

  // ---------- 明细 ----------
  function renderTable() {
    const a = S.tbArea, p = series(a, "participants"), e = series(a, "events"), o = D.data[a].over64, nat = D.data[NATIONAL].participants;
    $("tb-area").value = a;
    $("tb-sub").textContent = `${D.months.length} 个月，最新在上`;
    const out = [];
    for (let k = D.months.length - 1; k >= 0; k--) {
      out.push(`<tr${isOpen(k) ? ' class="open"' : ""}><td>${D.months[k]}</td><td class="num">${fmtN(p.values[k])}</td><td class="num">${growth(p.mom[k], p.delta[k])}</td>
        <td class="num">${growth(p.yoy[k], p.yoyDelta[k])}</td><td class="num">${fmtN(e.values[k])}</td><td class="num">${growth(e.mom[k], e.delta[k])}</td>
        <td class="num">${growth(e.yoy[k], e.yoyDelta[k])}</td><td class="num">${fmtN(o[k])}</td><td class="num">${fmtP(nat[k] ? p.values[k] / nat[k] : null)}</td>
        <td>${isOpen(k) ? "进行中" : "完整"}</td></tr>`);
    }
    $("tb-table").querySelector("tbody").innerHTML = out.join("");
  }

  // ---------- 切换与渲染 ----------
  const RENDER = { overview: renderOverview, regions: renderRegions, annual: renderAnnual, compare: renderCompare, periods: renderPeriods, table: renderTable };
  const USES_MONTH = new Set(["overview", "regions"]);
  function renderAll() {
    if (!D) return;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.dataset.view === S.tab));
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
    $("month").closest(".month-pick").style.visibility = USES_MONTH.has(S.tab) ? "visible" : "hidden";
    segSet("metric", S.metric);
    try { RENDER[S.tab](); } catch (e) { console.error(e); showError("页面绘制出错：" + e.message); }
    requestAnimationFrame(() => Object.values(charts).forEach(c => c.resize()));
    save();
  }
  function switchTab(t) { S.tab = t; renderAll(); window.scrollTo(0, 0); }
  function segSet(id, v) { document.querySelectorAll(`#${id} button`).forEach(b => b.setAttribute("aria-checked", String(b.dataset.v === String(v)))); }

  // ---------- 状态栏与刷新 ----------
  function showError(msg) { $("error").hidden = !msg; $("error").textContent = msg || ""; }
  let pollTimer = null, failCount = 0;
  async function poll() {
    clearTimeout(pollTimer);
    try {
      status = await api("/api/status");
      failCount = 0;
      const r = status.refresh, when = status.fetched_at ? status.fetched_at.slice(0, 16).replace("T", " ") : "—";
      $("refresh").disabled = r.running;
      $("progress").hidden = !r.running;
      $("progress").firstElementChild.style.width = r.total ? (r.done / r.total * 100) + "%" : "0";
      if (r.running) {
        $("status-dot").className = "dot busy";
        $("status-text").textContent = `正在更新 ${r.done}/${r.total}：${r.message}`;
        $("status-time").textContent = `当前显示 ${when} 的数据`;
      } else if (r.error) {
        $("status-dot").className = "dot bad";
        $("status-text").textContent = "更新失败，仍显示上次成功的数据";
        $("status-time").textContent = `数据取得于 ${when}`;
      } else {
        $("status-dot").className = "dot ok";
        $("status-text").textContent = status.seed ? "显示应用附带的初始数据" : `数据取得于 ${when}（北京时间）`;
        $("status-time").textContent = D ? `最近完整月 ${D.months[lastComplete]} · 共 ${D.months.length} 个月` : "";
      }
      showError(r.error ? `更新失败：${r.error}。可稍后点“刷新”重试。` : "");
      if (D && status.revision && status.revision !== D.revision) {
        await loadData();
        announceChanges();
      }
      pollTimer = setTimeout(poll, r.running ? 1500 : 15000);
    } catch (e) {
      failCount++;
      if (failCount >= 2) {
        $("status-dot").className = "dot bad";
        $("status-text").textContent = "本机服务已停止，请重新打开应用";
      }
      pollTimer = setTimeout(poll, 5000);
    }
  }
  function changesSummary() {
    const c = D && D.changes;
    if (!c) return "";
    if (c.first) return "首次从网站取得最新数据";
    const parts = [];
    if (c.new_months.length) parts.push(`新增 ${c.new_months.join("、")}`);
    parts.push(c.revised_count ? `网站修订了 ${c.revised_count} 个历史数值` : "历史数值无修订");
    return parts.join("，");
  }
  function announceChanges() {
    const t = changesSummary();
    $("changes-link").hidden = !t;
    $("changes-link").textContent = t ? `本次更新：${t}` : "";
    if (t) toast("已更新：" + t, D.changes && D.changes.revised_count ? ["查看", () => $("changes").showModal()] : null);
  }
  function renderChanges() {
    const c = D.changes;
    if (!c) return;
    let h = `<p>${esc(changesSummary())}。</p>`;
    if (c.previous_fetched_at) h += `<p class="muted">与 ${esc(c.previous_fetched_at.slice(0, 16).replace("T", " "))} 的数据相比；进行中月份的正常增长不算修订。</p>`;
    if (c.revised && c.revised.length) {
      h += `<div class="table-wrap"><table class="data"><thead><tr><th>区域</th><th>月份</th><th>指标</th><th class="num">原值</th><th class="num">新值</th><th class="num">差</th></tr></thead><tbody>` +
        c.revised.map(r => `<tr><td>${esc(r.area)}</td><td>${r.month}</td><td>${M.METRICS[r.metric].label}</td><td class="num">${fmtN(r.old)}</td><td class="num">${fmtN(r.new)}</td><td class="num">${signed(r.new - r.old)}</td></tr>`).join("") +
        "</tbody></table></div>";
      if (c.revised_count > c.revised.length) h += `<p class="muted">只列出前 ${c.revised.length} 条。</p>`;
    }
    $("changes-body").innerHTML = h;
  }

  let toastTimer;
  function toast(msg, action) {
    const t = $("toast");
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement("button");
      b.textContent = action[0]; b.onclick = () => { t.hidden = true; action[1](); };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 4000);
  }

  // ---------- 导出 ----------
  async function saveFile(kind, name, content) {
    try {
      const res = await api("/api/save", { kind, name, content });
      if (res.saved) return toast(`已保存：${res.saved}`, ["在文件夹中显示", () => api("/api/reveal", { path: res.saved })]);
      if (res.cancelled) return;
      // 浏览器模式：交给浏览器下载
      const a = document.createElement("a");
      if (kind === "xlsx") a.href = "/api/export.xlsx";
      else if (kind === "png") { a.href = content; a.download = name; }
      else { a.href = URL.createObjectURL(new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" })); a.download = name; }
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  function tableCSV(table) {
    const rows = [...table.querySelectorAll("tr")].map(tr => [...tr.children].map(td => td.textContent.replace(/[▲▼]\s?/g, "").trim()));
    return M.toCSV(rows);
  }
  function viewCSV() {
    const stamp = D.fetched_at.slice(0, 10), mName = metric().label;
    switch (S.tab) {
      case "overview": {
        const i = monthI();
        const rows = [["区域", `${mName}（${D.months[i]}）`, "占全国", "环比", "同比", "连续增长月数"]];
        regionRows(i).sort((a, b) => b.value - a.value).forEach(r => rows.push([r.name, r.value, r.share == null ? "" : (r.share * 100).toFixed(2) + "%",
          M.growthText(r.mom, r.delta), M.growthText(r.yoy, r.yoyDelta), r.streak]));
        return [`区域排名_${D.months[i]}_${mName}.csv`, M.toCSV(rows)];
      }
      case "compare":
        return [`自定义对比_${S.cp.start}_${S.cp.end}.csv`, M.toCSV(cpExport || []) + "\r\n\r\n" + tableCSV($("cp-table"))];
      case "regions": return [`35区域_${D.months[monthI()]}_${mName}.csv`, tableCSV($("rg-table"))];
      case "annual": return [`年度排名_${S.anYear}_${mName}.csv`, tableCSV($("an-table"))];
      case "periods": return [`近期热度_${S.pdPeriod}_${stamp}.csv`, tableCSV($("pd-table"))];
      default: return [`月度明细_${S.tbArea}_${stamp}.csv`, tableCSV($("tb-table"))];
    }
  }

  // ---------- 主题与缩放 ----------
  const mq = matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    const root = document.documentElement;
    if (S.theme === "auto") delete root.dataset.theme; else root.dataset.theme = S.theme;
    root.dataset.resolved = S.theme === "auto" ? (mq.matches ? "dark" : "light") : S.theme;
    root.style.setProperty("--zoom", S.zoom);
    $("zoom-label").textContent = Math.round(S.zoom * 100) + "%";
    disposeCharts();
    renderAll();
  }
  mq.addEventListener("change", () => { if (S.theme === "auto") applyTheme(); });
  const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
  function zoom(dir) {
    let k = ZOOMS.indexOf(S.zoom); if (k < 0) k = 3;
    S.zoom = dir === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, k + dir))];
    applyTheme();
  }

  // ---------- 事件 ----------
  function bind() {
    document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $("metric").onclick = e => { const v = e.target.dataset.v; if (v) { S.metric = v; renderAll(); } };
    $("month").onchange = e => { S.month = e.target.value; renderAll(); };
    $("refresh").onclick = async () => {
      try { await api("/api/refresh", {}); toast("开始从开球网更新全部历史，约需 10–60 秒"); poll(); }
      catch (e) { toast("无法开始更新：" + e.message); }
    };
    $("export-btn").onclick = e => { e.stopPropagation(); $("export-menu").hidden = !$("export-menu").hidden; };
    document.addEventListener("click", () => { $("export-menu").hidden = true; });
    $("export-menu").onclick = e => {
      const k = e.target.dataset.export;
      if (k === "xlsx") saveFile("xlsx");
      else if (k === "view-csv") { const [n, c] = viewCSV(); saveFile("csv", n, c); }
    };
    document.querySelectorAll("[data-png]").forEach(b => b.onclick = () => {
      const c = charts[b.dataset.png];
      if (!c) return;
      const url = c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: css("--card") });
      const title = b.closest(".card").querySelector("h2")?.textContent || "图表";
      saveFile("png", `${title}.png`, url);
    });
    $("ov-range").onclick = e => { const v = e.target.dataset.v; if (v != null) { S.ovRange = v; segSet("ov-range", v); applyRange(chart("ov-trend"), v); save(); } };
    $("heat-mode").onclick = e => { const v = e.target.dataset.v; if (v) { S.heatMode = v; renderHeat(monthI()); save(); } };
    $("ov-movers").onclick = e => { const li = e.target.closest("li[data-area]"); if (li) gotoRegion(li.dataset.area); };
    $("rg-table").onclick = e => {
      const th = e.target.closest("th[data-sort]");
      if (th) { const k = th.dataset.sort; S.rgSort = { key: k, asc: S.rgSort.key === k ? !S.rgSort.asc : k === "name" }; return renderAll(); }
      const tr = e.target.closest("tr[data-area]");
      if (tr) { S.rgArea = tr.dataset.area; renderAll(); }
    };
    $("rg-search").oninput = e => { S.rgSearch = e.target.value; renderRegions(); };
    $("an-area").onchange = e => { S.anArea = e.target.value; renderAll(); };
    $("an-year").onchange = e => { S.anYear = +e.target.value; renderAll(); };
    $("an-open").onchange = e => { S.anOpen = e.target.checked; renderAll(); };
    $("an-table").onclick = e => { const tr = e.target.closest("tr[data-area]"); if (tr) { S.anArea = tr.dataset.area; renderAll(); } };
    for (const [id, k] of [["cp-start", "start"], ["cp-end", "end"], ["cp-gran", "gran"], ["cp-mode", "mode"], ["cp-chart", "chart"]])
      $(id).onchange = e => {
        S.cp[k] = e.target.value;
        if (k === "mode" && S.cp.mode !== "sum") { // 回到叠加模式时给没有颜色的区域补颜色
          S.cp.areas.forEach(a => { if (S.cp.slots[a] == null) { const s = freeSlot(); if (s != null) S.cp.slots[a] = s; } });
        }
        renderAll();
      };
    $("cp-quick").onclick = e => { const v = e.target.dataset.v; if (v != null) { setCompareRange(+v); renderAll(); } };
    $("cp-areas").onclick = e => { const c = e.target.closest("[data-area]"); if (c) { toggleArea(c.dataset.area); renderAll(); } };
    $("cp-groups").onclick = e => {
      const g = e.target.dataset.group;
      if (!g) return;
      if (g === "__nat") setAreas([NATIONAL]);
      else if (g === "__all") setAreas(regions());
      else if (g === "__clear") setAreas([]);
      else setAreas(M.GROUPS[g]);
      renderAll();
    };
    $("pd-period").onclick = e => { const v = e.target.dataset.v; if (v) { S.pdPeriod = v; renderAll(); } };
    $("pd-sort").onchange = e => { S.pdSort = e.target.value; renderAll(); };
    $("tb-area").onchange = e => { S.tbArea = e.target.value; renderAll(); };
    $("changes-link").onclick = () => { renderChanges(); $("changes").showModal(); };

    // 设置
    $("settings-btn").onclick = () => {
      const st = status ? status.settings : {};
      $("set-auto").checked = !!st.auto_refresh_on_open;
      $("set-min").value = String(st.min_refresh_minutes ?? 30);
      $("set-periodic").value = String(st.periodic_hours ?? 0);
      $("set-theme").value = S.theme;
      $("set-info").textContent = status ? `版本 ${status.version} · 数据版本 ${status.revision} · 数据保存在 ${status.data_dir}` : "";
      $("settings").showModal();
    };
    const pushSettings = () => api("/api/settings", { auto_refresh_on_open: $("set-auto").checked,
      min_refresh_minutes: +$("set-min").value, periodic_hours: +$("set-periodic").value })
      .then(r => { if (status) status.settings = r.settings; }).catch(e => toast("设置保存失败：" + e.message));
    ["set-auto", "set-min", "set-periodic"].forEach(id => $(id).onchange = pushSettings);
    $("set-theme").onchange = e => { S.theme = e.target.value; save(); applyTheme(); };
    $("set-zoom").onclick = e => { const z = e.target.dataset.z; if (z) zoom(z === "+" ? 1 : z === "-" ? -1 : 0); };
    $("open-data").onclick = () => api("/api/open-data-dir", {}).catch(e => toast(e.message));

    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && ["=", "+", "-", "0"].includes(e.key)) {
        e.preventDefault(); zoom(e.key === "-" ? -1 : e.key === "0" ? 0 : 1);
      }
    });
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => Object.values(charts).forEach(c => c.resize()), 120); });
  }

  // ---------- 启动 ----------
  async function start() {
    if (location.protocol === "file:") {
      showError("请双击应用图标打开。直接打开这个 HTML 文件无法连接数据服务。");
      return;
    }
    bind();
    applyTheme();
    try {
      await loadData();
      applyTheme();
      if (D.changes) { $("changes-link").hidden = false; $("changes-link").textContent = `本次更新：${changesSummary()}`; }
    } catch (e) {
      showError("读取数据失败：" + e.message);
    }
    poll();
  }
  start();
})();
