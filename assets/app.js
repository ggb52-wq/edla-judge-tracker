/* EDLA Judge Tracker: computes every figure in the browser from data/*.json. */
(() => {
  const fmt = { int: d3.format(','), d1: d3.format('.1f'), d2: d3.format('.2f'), pct0: d3.format('.0%') };
  const utc = (s) => new Date(s + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmtDate = (s) => d3.utcFormat('%b %-d, %Y')(utc(s));
  const fmtShort = (s) => d3.utcFormat('%b %-d')(utc(s));
  const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const later = (a, b) => (a > b ? a : b);
  const median = (v) => { const s = v.slice().sort((a, b) => a - b); const m = s.length / 2; return s.length ? (s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2) : 0; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const heat = (v) => d3.interpolateRgb('#eef3fa', '#4a84c9')(Math.max(0, Math.min(1, (v - 0.05) / 0.35)));
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); n.append(...kids.filter((k) => k != null)); return n; };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } } };

  // Each written opinion falls in exactly one ruling type, checked in this order.
  const CATS = [['r12', 'Rule 12'], ['r56', 'Rule 56'], ['trial', 'Trial and post-trial'], ['rr', 'Magistrate R&Rs'], ['other', 'Other opinions']];
  const category = (o) => (Number(o.rr) ? 'rr' : Number(o.r12) ? 'r12' : Number(o.r56) ? 'r56' : Number(o.merits) ? 'trial' : 'other');
  const zeroCats = () => Object.fromEntries(CATS.map(([k]) => [k, 0]));

  // Outcomes of motion rulings. "unclear" means the order text was read and no outcome was found.
  const OUTCOMES = { granted: 'Granted', partial: 'Granted in part', denied: 'Denied', mixed: 'Mixed', moot: 'Moot', other: 'Other', unclear: 'Not determined' };
  const KNOWN = ['granted', 'partial', 'denied', 'mixed', 'moot', 'other'];
  const OC_SEGS = [['granted', 'Granted'], ['partial', 'Granted in part'], ['denied', 'Denied'], ['rest', 'Mixed, moot, or other']];
  const ocColor = (v) => css('--o-' + (['granted', 'partial', 'denied'].includes(v) ? v : 'other'));
  const OC_SRC = { manual: 'entered by hand', docket_text: 'read from the docket text', opinion_text: 'read from the order' };
  const isMotion = (o) => !Number(o.rr) && /motion/i.test(o.event || '');
  const GROUPS = { r12: 'Rule 12', r56: 'Rule 56', all: 'All motions' };
  const FEW = 5;
  const inGroup = (o, g) => isMotion(o) && (g === 'all' || Number(o[g]) === 1);

  // Links go only to CourtListener: the opinion's PDF, else its docket-entry page, else a search by case number.
  const CL = 'https://www.courtlistener.com/';
  const CL_PDF = 'https://storage.courtlistener.com/recap/';
  const REPO = 'https://github.com/ggb52-wq/edla-judge-tracker';
  const linkKind = (o) => (typeof o.pdf === 'string' && o.pdf.startsWith(CL_PDF) ? 'pdf'
    : typeof o.url === 'string' && o.url.startsWith(CL + 'docket/') ? 'page' : 'search');
  const opinionLink = (o, kind) => (kind === 'pdf' ? o.pdf : kind === 'page' ? o.url
    : CL + '?type=r&court=laed&docket_number=' + encodeURIComponent(o.case));
  const linkTitle = { pdf: 'Open this opinion (PDF, CourtListener)', page: 'Open this docket entry on CourtListener', search: 'Search CourtListener for this case' };
  const recordLink = (o) => REPO + '/issues/new?template=outcome.yml&title=' + encodeURIComponent('Outcome: ' + o.case + ' doc ' + o.doc)
    + '&case=' + encodeURIComponent(o.case) + '&doc=' + encodeURIComponent(o.doc);

  const TABS = ['overview', 'orders', 'opinions', 'outcomes', 'finder', 'log'];
  const state = { tab: 'overview', selected: store.get('edla-judge') || '', period: '', bars: store.get('edla-bars') !== '0',
    ocGroup: 'r12', finderLimit: 100, editor: false, data: null, stats: null };
  const editorParam = new URLSearchParams(location.search).get('editor');
  if (editorParam === '1' || editorParam === '0') store.set('edla-editor', editorParam);
  state.editor = store.get('edla-editor') === '1';

  // ------------------------------------------------------------ calculations
  function compute(D, period) {
    const H = new Set(D.calendar.filter((r) => r.kind === 'holiday').map((r) => r.date));
    const pick = (k) => (D.calendar.find((r) => r.kind === k) || {}).date;
    const through = pick('through');
    const floor = period ? addDays(through, 1 - Number(period)) : '';
    const workdays = (a, b) => { const out = []; for (let d = utc(a); d <= utc(b); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w > 0 && w < 6 && !H.has(iso(d))) out.push(iso(d)); } return out; };
    const span = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
    const OC = new Map((D.outcomes || []).map((r) => [r.case + '|' + r.doc, r]));
    const names = Object.fromEntries(D.judges.map((j) => [j.code, j.name]));
    const bench = Object.fromEntries(D.judges.map((j) => [j.code, j.bench_start]));

    const opStart = later(pick('opinions_start'), floor);
    const opRows = [];
    const opinions = D.judges.map((j) => {
      const s = later(j.bench_start, opStart);
      const R = D.opinions.filter((o) => o.judge === j.code && o.date >= s && o.date <= through)
        .map((o) => { const r = OC.get(o.case + '|' + o.doc); return { ...o, cat: category(o), oc: r ? r.outcome : '', ocSrc: r ? r.src : '' }; });
      opRows.push(...R);
      const mix = zeroCats(); R.forEach((o) => { mix[o.cat] += 1; });
      const ch = R.filter((o) => !Number(o.rr));
      const mer = ch.filter((o) => Number(o.merits));
      const ds = [...new Set(R.map((o) => o.date))].sort();
      let gap = 0; let prev = s;
      ds.forEach((d) => { gap = Math.max(gap, span(prev, d)); prev = d; });
      const wd = workdays(s, through).length;
      const row = { name: j.name, code: j.code, start: s, working_days: wd, total: R.length, rr: R.length - ch.length, district: ch.length,
        cases: new Set(R.map((o) => o.case)).size, days_with: ds.length, per_week: wd ? ch.length / (wd / 5) : 0, merits: mer.length,
        merits_month: wd ? mer.length / (wd / 21) : 0, r12: mer.filter((o) => Number(o.r12)).length, r56: mer.filter((o) => Number(o.r56)).length, gap, mix };
      Object.keys(GROUPS).forEach((g) => {
        const G = R.filter((o) => inGroup(o, g)); const K = G.filter((o) => KNOWN.includes(o.oc));
        const n = (v) => K.filter((o) => o.oc === v).length;
        Object.assign(row, { [g + '_n']: G.length, [g + '_known']: K.length, [g + '_granted']: n('granted'), [g + '_partial']: n('partial'),
          [g + '_denied']: n('denied'), [g + '_rest']: K.length - n('granted') - n('partial') - n('denied') });
      });
      return row;
    });

    const months = [];
    for (let d = utc(opStart.slice(0, 7) + '-01'); iso(d) <= through; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(iso(d).slice(0, 7));
    const monthly = months.map((month) => ({ month, dt: utc(month + '-01'), all: zeroCats(), by: {} }));
    const mIndex = Object.fromEntries(months.map((m, i) => [m, monthly[i]]));
    opRows.forEach((o) => {
      const row = mIndex[o.date.slice(0, 7)]; if (!row) return;
      row.all[o.cat] += 1; (row.by[o.judge] = row.by[o.judge] || zeroCats())[o.cat] += 1;
    });

    const orStart = later(pick('orders_start'), floor);
    const allDays = workdays(orStart, through);
    const last10 = allDays.slice(-10)[0] || orStart;
    const hours = { all: new Array(24).fill(0), by: {} };
    const orders = D.judges.map((j) => {
      const s = later(j.bench_start, orStart);
      const R = D.orders.filter((o) => o.judge === j.code && o.date >= s && o.date <= through);
      const timed = R.filter((o) => /^\d\d:\d\d/.test(o.time || ''));
      const hj = new Array(24).fill(0);
      timed.forEach((o) => { const h = +o.time.slice(0, 2); if (h < 24) { hj[h] += 1; hours.all[h] += 1; } });
      hours.by[j.code] = hj;
      const wd = workdays(s, through).length;
      const cases = new Set(R.map((o) => o.case)).size;
      const dow = [0, 0, 0, 0, 0, 0, 0];
      R.forEach((o) => { dow[utc(o.date).getUTCDay()] += 1; });
      const share = (i) => (R.length ? dow[i] / R.length : 0);
      return { name: j.name, code: j.code, start: s, working_days: wd, orders: R.length, per_day: wd ? R.length / wd : 0, cases,
        per_case: cases ? R.length / cases : 0,
        early: timed.length ? timed.filter((o) => o.time < '10:00').length / timed.length : 0,
        late: timed.length ? timed.filter((o) => o.time >= '17:00').length / timed.length : 0,
        last10: R.filter((o) => o.date >= last10).length, mon: share(1), tue: share(2), wed: share(3), thu: share(4), fri: share(5) };
    });

    const monday = (s) => { const d = utc(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
    const wdays = {};
    allDays.forEach((d) => { const m = monday(d); wdays[m] = (wdays[m] || 0) + 1; });
    const counts = {};
    D.orders.forEach((o) => { if (o.date >= orStart && o.date <= through && names[o.judge] && o.date >= bench[o.judge]) { const k = monday(o.date) + '|' + o.judge; counts[k] = (counts[k] || 0) + 1; } });
    const weekly = Object.keys(wdays).sort().map((week) => {
      const row = { week, dt: utc(week) };
      D.judges.forEach((j) => { row[j.code] = (counts[week + '|' + j.code] || 0) / wdays[week]; });
      row.median = median(D.judges.map((j) => row[j.code]));
      row.all = d3.sum(D.judges, (j) => row[j.code]);
      return row;
    });
    orders.forEach((r) => { r.spark = weekly.map((w) => w[r.code]); });

    const recent = opRows.slice().sort((a, b) => (b.date + b.case + b.doc).localeCompare(a.date + a.case + a.doc));
    const sum = (rows, k) => d3.sum(rows, (r) => r[k]);
    return {
      through, names, opinions, orders, weekly, recent, monthly, hours, since: { orders: orStart, opinions: opStart },
      totals: {
        orders: sum(orders, 'orders'), perDay: allDays.length ? sum(orders, 'orders') / allDays.length : 0,
        opinions: sum(opinions, 'total'), merits: sum(opinions, 'merits'), motions: sum(opinions, 'all_n'), known: sum(opinions, 'all_known'),
        pdf: recent.filter((o) => linkKind(o) === 'pdf').length,
        medPerDay: median(orders.map((r) => r.per_day)), medMerits: median(opinions.map((r) => r.merits_month)),
        medPerWeek: median(opinions.map((r) => r.per_week)),
      },
    };
  }

  // ------------------------------------------------------------ spreadsheet tables
  const ocCols = (g, label) => [
    { k: g + '_n', label: 'Rulings', f: fmt.int, sum: true, group: label, gstart: true },
    { k: g + '_known', label: 'Known', f: fmt.int, sum: true, group: label },
    { k: g + '_granted', label: 'Granted', f: fmt.int, sum: true, group: label },
    { k: g + '_partial', label: 'In part', f: fmt.int, sum: true, group: label },
    { k: g + '_denied', label: 'Denied', f: fmt.int, sum: true, group: label },
    { k: g + '_rest', label: 'Other', f: fmt.int, sum: true, group: label, title: 'Mixed, moot, or other' },
  ];
  const TABLES = {
    'or-table': { src: 'orders', sort: { k: 'per_day', dir: -1 }, pick: true, cols: [
      { k: 'name', label: 'Judge' },
      { k: 'working_days', label: 'Working days', f: fmt.int },
      { k: 'orders', label: 'Total orders', f: fmt.int, bar: true, sum: true },
      { k: 'per_day', label: 'Orders per working day', f: fmt.d1, bar: true },
      { k: 'cases', label: 'Cases with orders', f: fmt.int, sum: true },
      { k: 'per_case', label: 'Orders per case', f: fmt.d1 },
      { k: 'early', label: 'Entered before 10 AM', f: fmt.pct0 },
      { k: 'late', label: 'Entered after 5 PM', f: fmt.pct0 },
      { k: 'last10', label: 'Orders, last 10 working days', f: fmt.int, bar: true, sum: true },
      { k: 'spark', label: 'Weekly trend', spark: true },
    ] },
    'op-table': { src: 'opinions', sort: { k: 'merits_month', dir: -1 }, pick: true, cols: [
      { k: 'name', label: 'Judge' },
      { k: 'working_days', label: 'Working days', f: fmt.int },
      { k: 'total', label: 'Total opinions', f: fmt.int, bar: true, sum: true },
      { k: 'rr', label: 'Magistrate R&Rs', f: fmt.int, sum: true },
      { k: 'district', label: 'District judge opinions', f: fmt.int, sum: true },
      { k: 'cases', label: 'Cases with opinions', f: fmt.int, sum: true },
      { k: 'days_with', label: 'Days with opinions', f: fmt.int },
      { k: 'per_week', label: 'Opinions per week', f: fmt.d2, bar: true },
      { k: 'merits', label: 'Merits rulings', f: fmt.int, bar: true, sum: true },
      { k: 'merits_month', label: 'Merits per month', f: fmt.d2, bar: true },
      { k: 'r12', label: 'Rule 12', f: fmt.int, sum: true },
      { k: 'r56', label: 'Rule 56', f: fmt.int, sum: true },
      { k: 'gap', label: 'Longest gap (days)', f: fmt.int },
    ] },
    'dow-table': { src: 'orders', sort: { k: 'name', dir: 1 }, pick: true, cols: [
      { k: 'name', label: 'Judge' },
      ...[['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri']].map(([k, label]) => ({ k, label, f: fmt.pct0, heat: true })),
    ] },
    'oc-table': { src: 'opinions', sort: { k: 'name', dir: 1 }, pick: true, noMedian: true, cols: [
      { k: 'name', label: 'Judge', group: '' }, ...ocCols('r12', 'Rule 12 rulings'), ...ocCols('r56', 'Rule 56 rulings'), ...ocCols('all', 'All motion rulings'),
    ] },
  };

  function tableRows(id) {
    const t = TABLES[id]; const s = t.sort;
    return state.stats[t.src].slice().sort((a, b) => {
      const x = a[s.k]; const y = b[s.k];
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * s.dir;
    });
  }

  function sparkline(values, w = 92, h = 20) {
    const svg = d3.create('svg').attr('class', 'spark').attr('width', w).attr('height', h).attr('aria-hidden', 'true');
    if (values.length < 2) return svg.node();
    const x = d3.scaleLinear([0, values.length - 1], [2, w - 4]);
    const y = d3.scaleLinear([0, d3.max(values) || 1], [h - 3, 3]);
    svg.append('path').attr('fill', 'none').attr('stroke', css('--accent')).attr('stroke-width', 1.5).attr('stroke-linejoin', 'round')
      .attr('d', d3.line().x((_, i) => x(i)).y((v) => y(v))(values));
    svg.append('circle').attr('cx', x(values.length - 1)).attr('cy', y(values[values.length - 1])).attr('r', 2.2).attr('fill', css('--accent'));
    return svg.node();
  }

  function drawTable(id) {
    const t = TABLES[id]; const s = t.sort; const rows = tableRows(id); const all = state.stats[t.src];
    const table = $(id);
    const max = Object.fromEntries(t.cols.filter((c) => c.bar).map((c) => [c.k, d3.max(all, (r) => r[c.k]) || 1]));
    const head = el('thead');
    if (t.cols.some((c) => c.group)) {
      const tr = el('tr', { className: 'group' }); let i = 0;
      while (i < t.cols.length) { const g = t.cols[i].group || ''; let n = 0; while (i + n < t.cols.length && (t.cols[i + n].group || '') === g) n += 1; tr.append(el('th', { colSpan: n, textContent: g, className: g ? 'gstart' : '' })); i += n; }
      head.append(tr);
    }
    head.append(el('tr', {}, ...t.cols.map((c) => {
      const th = el('th', { title: c.title || '', className: c.gstart ? 'gstart' : '' });
      if (c.spark) { th.textContent = c.label; return th; }
      th.dataset.k = c.k; th.setAttribute('aria-sort', c.k === s.k ? (s.dir > 0 ? 'ascending' : 'descending') : 'none');
      th.append(el('button', { type: 'button', textContent: c.label }));
      return th;
    })));
    const body = el('tbody', {}, ...rows.map((r) => {
      const tr = el('tr', { className: (t.pick ? 'pickable' : '') + (r.code === state.selected ? ' sel' : '') }); tr.dataset.code = r.code;
      t.cols.forEach((c) => {
        const td = el('td', { className: c.gstart ? 'gstart' : '' });
        if (c.spark) td.append(sparkline(r.spark));
        else if (c.heat) td.append(el('span', { className: 'heat', textContent: c.f(r[c.k]) }, null)), (td.firstChild.style.background = heat(r[c.k]));
        else {
          td.textContent = c.f ? c.f(r[c.k]) : r[c.k];
          if (c.bar && state.bars) { const p = Math.max(0, Math.min(100, (r[c.k] / max[c.k]) * 100)); td.className += ' barred'; td.style.setProperty('--p', p + '%'); }
        }
        tr.append(td);
      });
      return tr;
    }));
    const foot = el('tfoot');
    if (t.cols.some((c) => c.sum)) foot.append(el('tr', {}, ...t.cols.map((c, i) => el('td', { className: c.gstart ? 'gstart' : '', textContent: i === 0 ? 'All judges' : c.sum ? c.f(d3.sum(all, (r) => r[c.k])) : '' }))));
    if (!t.noMedian) foot.append(el('tr', {}, ...t.cols.map((c, i) => el('td', { textContent: i === 0 ? 'Median judge' : c.f && !c.spark ? c.f(median(all.map((r) => r[c.k]))) : '' }))));
    table.replaceChildren(head, body, foot);
  }

  function wireTable(id) {
    const table = $(id);
    table.addEventListener('click', (e) => {
      const b = e.target.closest('th button');
      if (b) {
        const k = b.parentElement.dataset.k; const s = TABLES[id].sort;
        s.dir = s.k === k ? -s.dir : (k === 'name' ? 1 : -1); s.k = k; drawTable(id); return;
      }
      const tr = e.target.closest('tbody tr[data-code]');
      if (tr && TABLES[id].pick && !e.target.closest('a')) select(tr.dataset.code === state.selected ? '' : tr.dataset.code);
    });
  }

  // ------------------------------------------------------------ CSV export
  function csvFor(id) {
    if (id === 'recent-table') {
      const head = ['Date', 'Judge', 'Case', 'Doc', 'Ruling type', 'Ruling', 'Outcome', 'Outcome source', 'Case name', 'Link'];
      return [head, ...finderRows().map((o) => [o.date, state.stats.names[o.judge], o.case, o.doc, (CATS.find(([k]) => k === o.cat) || [])[1],
        o.event, OUTCOMES[o.oc] || '', o.ocSrc || '', o.title, opinionLink(o, linkKind(o))])];
    }
    const t = TABLES[id]; const cols = t.cols.filter((c) => !c.spark);
    return [cols.map((c) => (c.group ? c.group + ': ' : '') + c.label),
      ...tableRows(id).map((r) => cols.map((c) => (typeof r[c.k] === 'number' ? +r[c.k].toFixed(4) : r[c.k])))];
  }
  function downloadCsv(id) {
    const text = csvFor(id).map((row) => row.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
    const a = el('a', { href: URL.createObjectURL(new Blob([text + '\n'], { type: 'text/csv' })), download: `edla-${id.replace('-table', '')}-${state.stats.through}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------ charts
  function tooltip(box) { let t = box.querySelector('.tip'); if (!t) { t = el('div', { className: 'tip', hidden: true }); box.append(t); } return t; }
  function showTip(box, tip, event, lines) {
    tip.replaceChildren(...lines.map((l, i) => el('div', { className: i === 0 ? 'k' : '', textContent: l })));
    tip.hidden = false;
    const [x, y] = d3.pointer(event, box);
    tip.style.left = Math.max(0, Math.min(box.clientWidth - tip.offsetWidth, x + 12)) + 'px'; tip.style.top = Math.max(0, y - 10) + 'px';
  }
  const axisStyle = (g) => g.attr('font-size', null).attr('font-family', null)
    .call((a) => a.selectAll('line,path').attr('stroke', css('--rule'))).call((a) => a.selectAll('text').style('fill', css('--ink-2')).attr('font-size', 11));
  const labelWidth = (svg) => { const m = svg.append('text').attr('font-size', 12).text('Papillion'); const w = Math.ceil(m.node().getComputedTextLength()) + 12; m.remove(); return w; };
  function frame(box, H, label) {
    const W = box.clientWidth || 400;
    const svg = d3.create('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', label);
    box.replaceChildren(svg.node());
    return { svg, W };
  }

  function barChart(boxId, rows, field, format, label, ref) {
    const box = $(boxId); const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar'); const ink2 = css('--ink-2');
    rows = rows.slice().sort((a, b) => b[field] - a[field]);
    const top = 22; const H = rows.length * 22 + top + 6;
    const { svg, W } = frame(box, H, label + ' by judge');
    const left = labelWidth(svg);
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r[field]) || 1], [left, W - 50]);
    const y = d3.scaleBand(rows.map((r) => r.name), [top, H - 6]).padding(0.28);
    const tip = tooltip(box);
    svg.selectAll('rect').data(rows).join('rect').attr('x', left).attr('y', (r) => y(r.name)).attr('height', y.bandwidth()).attr('rx', 2)
      .attr('width', (r) => Math.max(1, x(r[field]) - left)).attr('fill', (r) => (!sel || r.code === sel ? accent : muted)).style('cursor', 'pointer')
      .on('click', (e, r) => select(r.code === sel ? '' : r.code))
      .on('mousemove', (e, r) => showTip(box, tip, e, [r.name, label + ': ' + format(r[field])])).on('mouseleave', () => { tip.hidden = true; });
    svg.selectAll('.lbl').data(rows).join('text').attr('x', left - 8).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', (r) => (r.code === sel ? 600 : 400)).text((r) => r.name);
    svg.selectAll('.val').data(rows).join('text').attr('x', (r) => x(r[field]) + 6).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('font-size', 11).style('fill', ink2).text((r) => format(r[field]));
    svg.append('line').attr('x1', x(ref)).attr('x2', x(ref)).attr('y1', top - 4).attr('y2', H - 6).attr('stroke', ink2).attr('stroke-dasharray', '4 3');
    svg.append('text').attr('x', x(ref)).attr('y', 12).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', ink2).text('Median ' + format(ref));
  }

  function weeklyChart() {
    const box = $('c-weekly'); const rows = state.stats.weekly; const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar'); const ink2 = css('--ink-2');
    $('weekly-note').textContent = (sel ? state.stats.names[sel] + ' against the median judge' : 'The median judge') + ', by week (Monday start). The current week is partial.';
    if (!rows.length) { box.replaceChildren(); return; }
    const series = [['median', 'Median judge', sel ? muted : accent]];
    if (sel) series.push([sel, state.stats.names[sel], accent]);
    const H = 250; const m = { t: 10, r: 120, b: 26, l: 34 };
    const { svg, W } = frame(box, H, 'Weekly orders per working day');
    const x = d3.scaleUtc(d3.extent(rows, (r) => r.dt), [m.l, W - m.r]);
    const y = d3.scaleLinear([0, (d3.max(rows, (r) => d3.max(series, ([k]) => r[k] || 0)) || 1) * 1.1], [H - m.b, m.t]).nice();
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 110))).tickFormat(d3.utcFormat('%b %-d'))).call(axisStyle);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r))).call(axisStyle).call((g) => g.select('.domain').remove());
    const last = rows[rows.length - 1]; const ends = [];
    series.forEach(([k, label, color]) => {
      svg.append('path').datum(rows).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round')
        .attr('d', d3.line().x((r) => x(r.dt)).y((r) => y(r[k] || 0)));
      ends.push(svg.append('text').attr('x', W - m.r + 6).attr('y', y(last[k] || 0)).attr('dy', '0.35em').attr('font-size', 11).text(label + ' ' + fmt.d1(last[k] || 0)));
    });
    if (ends.length === 2) { const a = +ends[0].attr('y'); const b = +ends[1].attr('y'); if (Math.abs(a - b) < 13) { const mid = (a + b) / 2; ends[0].attr('y', a <= b ? mid - 7 : mid + 7); ends[1].attr('y', a <= b ? mid + 7 : mid - 7); } }
    const tip = tooltip(box);
    const ruleLine = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', ink2).attr('opacity', 0);
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('mousemove', (e) => {
        const t = x.invert(d3.pointer(e)[0]);
        const r = rows.reduce((best, q) => (Math.abs(q.dt - t) < Math.abs(best.dt - t) ? q : best), rows[0]);
        ruleLine.attr('x1', x(r.dt)).attr('x2', x(r.dt)).attr('opacity', 1);
        showTip(box, tip, e, ['Week of ' + d3.utcFormat('%b %-d')(r.dt), ...series.map(([k, label]) => label + ': ' + fmt.d1(r[k] || 0))]);
      })
      .on('mouseleave', () => { tip.hidden = true; ruleLine.attr('opacity', 0); });
  }

  // Columns stacked by ruling type, one per month; follows the picked judge.
  function monthlyChart() {
    const box = $('c-monthly'); const S = state.stats; const sel = state.selected; const panel = css('--panel');
    $('monthly-title').textContent = 'Written opinions by month' + (sel ? ': ' + S.names[sel] : '');
    $('monthly-note').textContent = (sel ? S.names[sel] + ', by ruling type.' : 'All 16 judges combined, by ruling type.') + ' The first and current months can be partial.';
    const rows = S.monthly.map((r) => ({ ...r, c: sel ? (r.by[sel] || zeroCats()) : r.all }));
    if (!rows.length) { box.replaceChildren(); return; }
    const H = 250; const m = { t: 10, r: 8, b: 26, l: 34 };
    const { svg, W } = frame(box, H, 'Written opinions by month' + (sel ? ', ' + S.names[sel] : ''));
    const x = d3.scaleBand(rows.map((r) => r.month), [m.l, W - m.r]).padding(0.25);
    const y = d3.scaleLinear([0, d3.max(rows, (r) => d3.sum(CATS, ([k]) => r.c[k])) || 1], [H - m.b, m.t]).nice();
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(W / 60)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(rows.map((r) => r.month).filter((_, i) => i % every === 0)).tickFormat((k) => d3.utcFormat(k.endsWith('-01') ? '%b %Y' : '%b')(utc(k + '-01')))).call(axisStyle);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r))).call(axisStyle).call((g) => g.select('.domain').remove());
    const tip = tooltip(box);
    rows.forEach((r) => {
      let acc = 0;
      CATS.forEach(([k]) => {
        const v = r.c[k]; if (!v) return;
        svg.append('rect').attr('x', x(r.month)).attr('width', x.bandwidth()).attr('y', y(acc + v)).attr('height', y(acc) - y(acc + v))
          .attr('fill', css('--c-' + k)).attr('stroke', panel).attr('stroke-width', 1);
        acc += v;
      });
      svg.append('rect').attr('x', x(r.month) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
        .on('mousemove', (e) => showTip(box, tip, e, [d3.utcFormat('%B %Y')(r.dt) + ': ' + fmt.int(acc), ...CATS.filter(([k]) => r.c[k]).map(([k, label]) => label + ': ' + fmt.int(r.c[k]))]))
        .on('mouseleave', () => { tip.hidden = true; });
    });
  }

  // One 100% bar per judge, alphabetical. segs: [[key, label, color]]; value(r, key) and total(r) give the counts.
  function shareBars(boxId, label, segs, value, total, emptyText, few = 0) {
    const box = $(boxId); const sel = state.selected; const panel = css('--panel'); const ink2 = css('--ink-2');
    const rows = state.stats.opinions.slice().sort((a, b) => a.name.localeCompare(b.name));
    const top = 4; const H = rows.length * 22 + top + 6;
    const { svg, W } = frame(box, H, label);
    const left = labelWidth(svg); const right = 52;
    const x = d3.scaleLinear([0, 1], [left, W - right]);
    const y = d3.scaleBand(rows.map((r) => r.name), [top, H - 6]).padding(0.28);
    const tip = tooltip(box);
    rows.forEach((r) => {
      const n = total(r);
      const g = svg.append('g').style('cursor', 'pointer').attr('opacity', (!sel || r.code === sel ? 1 : 0.35) * (n && n < few ? 0.45 : 1))
        .on('click', () => select(r.code === sel ? '' : r.code))
        .on('mousemove', (e) => showTip(box, tip, e, [r.name + ': ' + fmt.int(n), ...segs.map(([k, l]) => l + ': ' + fmt.int(value(r, k)) + (n ? ' (' + fmt.pct0(value(r, k) / n) + ')' : ''))]))
        .on('mouseleave', () => { tip.hidden = true; });
      let acc = 0;
      segs.forEach(([k, , color]) => {
        const v = n ? value(r, k) / n : 0; if (!v) return;
        g.append('rect').attr('x', x(acc)).attr('width', x(acc + v) - x(acc)).attr('y', y(r.name)).attr('height', y.bandwidth())
          .attr('fill', color).attr('stroke', panel).attr('stroke-width', 1);
        acc += v;
      });
      if (!n) g.append('text').attr('x', left + 4).attr('y', y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em').attr('font-size', 11).style('fill', ink2).text(emptyText);
      g.append('rect').attr('x', left).attr('width', W - right - left).attr('y', y(r.name) - 2).attr('height', y.bandwidth() + 4).attr('fill', 'transparent');
    });
    svg.selectAll('.lbl').data(rows).join('text').attr('x', left - 8).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', (r) => (r.code === sel ? 600 : 400)).text((r) => r.name);
    svg.selectAll('.val').data(rows).join('text').attr('x', W - right + 6).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('font-size', 11).style('fill', ink2).text((r) => 'n=' + fmt.int(total(r)));
  }

  function mixChart() {
    shareBars('c-mix', 'Mix of written opinions by judge', CATS.map(([k, l]) => [k, l, css('--c-' + k)]), (r, k) => r.mix[k], (r) => r.total, 'No opinions');
  }

  function outcomeChart() {
    const g = state.ocGroup;
    document.querySelectorAll('#oc-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === g)));
    const known = d3.sum(state.stats.opinions, (r) => r[g + '_known']); const n = d3.sum(state.stats.opinions, (r) => r[g + '_n']);
    $('oc-note').textContent = `${GROUPS[g]} rulings with a known outcome, as a share of each judge's known outcomes. Outcomes are on file for ${fmt.int(known)} of ${fmt.int(n)} such rulings since ${fmtDate(state.stats.since.opinions)}; n is the number known. Judges in alphabetical order; bars resting on fewer than ${FEW} known outcomes are faded, because a share of one or two rulings says little.`;
    shareBars('c-outcomes', 'Outcomes of ' + GROUPS[g] + ' rulings by judge', OC_SEGS.map(([k, l]) => [k, l, ocColor(k)]), (r, k) => r[g + '_' + k], (r) => r[g + '_known'], 'No outcomes on file yet', FEW);
  }

  // Share of timed orders by hour of entry: the court, plus the picked judge.
  function hoursChart() {
    const box = $('c-hours'); const S = state.stats; const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar');
    $('hours-note').textContent = 'Share of civil orders entered in each hour (Central) since ' + fmtDate(S.since.orders)
      + (sel ? ': ' + S.names[sel] + ' against all judges combined.' : ', all judges combined. Pick a judge to compare.');
    const share = (a) => { const t = d3.sum(a); return a.map((v) => (t ? v / t : 0)); };
    const series = [['all', 'All judges', sel ? muted : accent, share(S.hours.all), S.hours.all]];
    if (sel) series.push([sel, S.names[sel], accent, share(S.hours.by[sel]), S.hours.by[sel]]);
    $('hours-legend').replaceChildren(...(sel ? series : []).map(([, label, color]) => { const i = el('i'); i.style.background = color; return el('span', {}, i, label); }));
    const used = d3.range(24).filter((h) => series.some((s) => s[4][h]));
    if (!used.length) { box.replaceChildren(); return; }
    const hrs = d3.range(Math.min(...used), Math.max(...used) + 1);
    const hourName = (h) => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
    const H = 360; const m = { t: 10, r: 8, b: 26, l: 40 };
    const { svg, W } = frame(box, H, 'Share of civil orders by hour of entry');
    const x = d3.scaleBand(hrs, [m.l, W - m.r]).padding(0.2);
    const xi = d3.scaleBand(series.map((s) => s[0]), [0, x.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear([0, d3.max(series, (s) => d3.max(s[3])) || 1], [H - m.b, m.t]).nice();
    const every = Math.ceil(hrs.length / Math.max(2, Math.floor(W / 50)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(hrs.filter((_, i) => i % every === 0)).tickFormat(hourName)).call(axisStyle);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(fmt.pct0).tickSize(-(W - m.l - m.r))).call(axisStyle).call((g) => g.select('.domain').remove());
    const tip = tooltip(box);
    hrs.forEach((h) => {
      series.forEach(([k, , color, sh]) => {
        svg.append('rect').attr('x', x(h) + xi(k)).attr('width', xi.bandwidth()).attr('y', y(sh[h])).attr('height', y(0) - y(sh[h])).attr('rx', 2).attr('fill', color);
      });
      svg.append('rect').attr('x', x(h) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
        .on('mousemove', (e) => showTip(box, tip, e, [hourName(h) + ' to ' + hourName((h + 1) % 24), ...series.map(([, label, , sh, n]) => label + ': ' + fmt.pct0(sh[h]) + ' (' + fmt.int(n[h]) + ')')]))
        .on('mouseleave', () => { tip.hidden = true; });
    });
  }

  // ------------------------------------------------------------ opinion cells
  function caseLink(o) {
    const kind = linkKind(o);
    const a = el('a', { href: opinionLink(o, kind), target: '_blank', rel: 'noopener noreferrer', textContent: o.case + ' · ' + o.doc, title: linkTitle[kind] });
    return kind === 'pdf' ? [a, ' ', el('span', { className: 'tag', textContent: 'PDF' })] : [a];
  }
  function outcomePill(o) {
    if (!o.oc) return isMotion(o) ? el('span', { className: 'pill none', textContent: 'Not recorded', title: 'No outcome on file' }) : null;
    const i = el('i'); i.style.background = o.oc === 'unclear' ? 'transparent' : ocColor(o.oc);
    if (o.oc === 'unclear') i.style.border = '1px solid ' + css('--ink-3');
    return el('span', { className: 'pill', title: 'Outcome ' + (OC_SRC[o.ocSrc] || 'on file') }, i, OUTCOMES[o.oc] || o.oc, o.ocSrc === 'manual' ? el('small', { textContent: 'hand' }) : null);
  }

  // ------------------------------------------------------------ finder
  function finderRows() {
    const S = state.stats; const sel = state.selected;
    const q = $('op-q').value.trim().toLowerCase(); const type = $('op-type').value; const oc = $('op-outcome').value; const pdf = $('op-pdf').checked;
    return S.recent.filter((o) => (!sel || o.judge === sel)
      && (!type || (type === 'merits' ? Number(o.merits) && !Number(o.rr) : o.cat === type))
      && (!oc || (oc === 'known' ? KNOWN.includes(o.oc) : oc === 'none' ? isMotion(o) && !KNOWN.includes(o.oc) : o.oc === oc))
      && (!pdf || linkKind(o) === 'pdf')
      && (!q || (o.case + ' ' + o.title + ' ' + o.event).toLowerCase().includes(q)));
  }
  function drawFinder() {
    const S = state.stats; const rows = finderRows(); const shown = rows.slice(0, state.finderLimit);
    const cols = ['Date', 'Judge', 'Case · doc', 'Ruling', 'Outcome', 'Case name'].concat(state.editor ? ['Record'] : []);
    const head = el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c }))));
    const body = el('tbody', {}, ...shown.map((o) => {
      const cells = [el('td', { textContent: fmtDate(o.date) }), el('td', { className: 'txt', textContent: S.names[o.judge] }), el('td', { className: 'txt' }, ...caseLink(o)),
        el('td', { className: 'left', textContent: o.event }), el('td', { className: 'txt' }, outcomePill(o)), el('td', { className: 'left', textContent: o.title })];
      if (state.editor) cells.push(el('td', { className: 'txt' }, el('a', { href: recordLink(o), target: '_blank', rel: 'noopener noreferrer', textContent: o.oc ? 'Correct' : 'Record' })));
      return el('tr', {}, ...cells);
    }));
    $('recent-table').replaceChildren(head, body);
    $('op-count').textContent = rows.length ? 'Showing ' + fmt.int(shown.length) + ' of ' + fmt.int(rows.length) : 'No matching opinions';
    $('op-more').hidden = shown.length >= rows.length;
    $('finder-title').textContent = 'Opinion finder' + (state.selected ? ': ' + S.names[state.selected] : '');
  }

  // ------------------------------------------------------------ overview
  function drawProfile() {
    const S = state.stats; const sel = state.selected;
    $('profile-empty').hidden = !!sel; $('profile-body').hidden = !sel; $('profile-clear').hidden = !sel;
    $('profile-title').textContent = sel ? 'Judge ' + S.names[sel] : 'Judge profile';
    if (!$('profile-chips').childElementCount) {
      $('profile-chips').append(...state.data.judges.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((j) => el('button', { type: 'button', className: 'chip', textContent: j.name, onclick: () => select(j.code) })));
    }
    if (!sel) return;
    const or = S.orders.find((r) => r.code === sel); const op = S.opinions.find((r) => r.code === sel);
    const ocLine = (g) => (op[g + '_known'] ? `${op[g + '_granted']} granted · ${op[g + '_partial']} in part · ${op[g + '_denied']} denied` : 'none on file yet');
    const facts = [
      ['Orders per working day', fmt.d1(or.per_day), 'court median ' + fmt.d1(S.totals.medPerDay)],
      ['Civil orders', fmt.int(or.orders), fmt.int(or.last10) + ' in the last 10 working days'],
      ['Written opinions', fmt.int(op.total), fmt.d2(op.per_week) + ' per week · median ' + fmt.d2(S.totals.medPerWeek)],
      ['Merits rulings per month', fmt.d2(op.merits_month), 'court median ' + fmt.d2(S.totals.medMerits)],
      ['Rule 12 rulings', fmt.int(op.r12_n), 'outcomes: ' + ocLine('r12')],
      ['Rule 56 rulings', fmt.int(op.r56_n), 'outcomes: ' + ocLine('r56')],
      ['Longest gap between opinions', fmt.int(op.gap) + ' days', 'calendar days'],
      ['Counted from', fmtShort(op.start > or.start ? or.start : op.start), op.start === S.since.opinions ? 'start of the data' : 'first day in the period'],
    ];
    $('profile-facts').replaceChildren(...facts.map(([k, v, sub]) => el('div', { className: 'fact' }, el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: sub }))));
    $('profile-period').textContent = state.period ? '· last ' + state.period + ' days' : '';
    const latest = S.recent.filter((o) => o.judge === sel).slice(0, 6);
    $('profile-latest').replaceChildren(...(latest.length ? latest.map((o) => el('li', {}, el('span', { className: 'd', textContent: fmtShort(o.date) }),
      el('span', {}, ...caseLink(o), ...(o.oc ? [' ', outcomePill(o)] : [])), el('span', { className: 't', textContent: o.event + ' · ' + o.title }))) : [el('li', { textContent: 'No written opinions in this period.' })]));
  }

  function drawTiles() {
    const S = state.stats; const T = S.totals; const D = state.data;
    $('t-orders').textContent = fmt.int(T.orders);
    $('t-perday').textContent = fmt.d1(T.perDay);
    $('t-opinions').textContent = fmt.int(T.opinions);
    $('t-merits').textContent = fmt.int(T.merits);
    $('t-outcomes').textContent = fmt.int(T.known);
    $('t-outcomes-sub').textContent = 'of ' + fmt.int(T.motions) + ' motion rulings';
    $('t-pdf').textContent = fmt.int(T.pdf);
    $('t-pdf-sub').textContent = 'of ' + fmt.int(S.recent.length) + ' · ' + (S.recent.length ? fmt.pct0(T.pdf / S.recent.length) : '0%');
    $('t-through').textContent = fmtShort(S.through);
    const lastRun = D.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    $('t-updated').textContent = lastRun ? 'updated ' + String(lastRun.at).slice(5, 16).replace('T', ' ') : '';
    $('t-perday-spark').replaceChildren(sparkline(S.weekly.map((w) => w.all), 120, 22));
    $('t-opinions-spark').replaceChildren(sparkline(S.monthly.map((m) => d3.sum(CATS, ([k]) => m.all[k])), 120, 22));
  }

  function drawLog() {
    const runs = state.data.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60);
    $('runs-table').replaceChildren(el('thead', {}, el('tr', {}, ...['Run (Central)', 'Orders added', 'Opinions added', 'Note'].map((c) => el('th', { textContent: c })))),
      el('tbody', {}, ...runs.map((r) => el('tr', {}, el('td', { textContent: String(r.at).slice(0, 16).replace('T', ' ') }), el('td', { textContent: fmt.int(+r.orders_added || 0) }),
        el('td', { textContent: fmt.int(+r.opinions_added || 0) }), el('td', { className: 'left', textContent: r.note || '' })))));
  }

  // ------------------------------------------------------------ render
  const SHEETS = {
    overview: () => { drawTiles(); drawProfile(); weeklyChart(); monthlyChart(); },
    orders: () => { drawTable('or-table'); drawTable('dow-table'); barChart('c-perday', state.stats.orders, 'per_day', fmt.d1, 'Orders per working day', state.stats.totals.medPerDay); hoursChart(); },
    opinions: () => { drawTable('op-table'); barChart('c-merits', state.stats.opinions, 'merits_month', fmt.d2, 'Merits rulings per month', state.stats.totals.medMerits); mixChart(); },
    outcomes: () => { drawTable('oc-table'); outcomeChart(); },
    finder: drawFinder,
    log: drawLog,
  };

  function render() {
    const S = state.stats;
    document.querySelectorAll('[data-since]').forEach((n) => { n.textContent = fmtDate(S.since[n.dataset.since]); });
    $('status').textContent = '';
    $('judge-pick').value = state.selected; $('period-pick').value = state.period; $('bars-pick').checked = state.bars;
    $('n-finder').textContent = fmt.int(S.recent.length);
    TABS.forEach((t) => { $(t).hidden = t !== state.tab; $('tab-' + t).setAttribute('aria-selected', String(t === state.tab)); $('tab-' + t).tabIndex = t === state.tab ? 0 : -1; });
    SHEETS[state.tab]();
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (state.selected) p.set('judge', state.selected);
    if (state.period) p.set('period', state.period);
    const h = '#' + state.tab + (p.toString() ? '?' + p : '');
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function readHash() {
    const [tab, query] = location.hash.slice(1).split('?');
    if (TABS.includes(tab)) state.tab = tab;
    const p = new URLSearchParams(query || '');
    if (p.has('judge')) state.selected = p.get('judge');
    if (p.has('period')) state.period = ['30', '90'].includes(p.get('period')) ? p.get('period') : '';
  }

  function update(recompute) {
    if (!state.data) return;
    if (recompute) state.stats = compute(state.data, state.period);
    if (state.selected && !state.stats.names[state.selected]) state.selected = '';
    store.set('edla-judge', state.selected);
    writeHash(); render();
  }
  function select(code) { state.selected = code || ''; state.finderLimit = 100; update(false); }
  function show(tab) { state.tab = tab; update(false); window.scrollTo({ top: Math.min(window.scrollY, document.querySelector('.bar').offsetTop) }); }

  async function load() {
    const names = ['opinions', 'orders', 'judges', 'calendar', 'runs', 'outcomes'];
    try {
      const files = await Promise.all(names.map((n) => fetch('data/' + n + '.json', { cache: 'no-cache' })
        .then((r) => { if (!r.ok) { if (n === 'outcomes') return []; throw new Error(n + ' ' + r.status); } return r.json(); })));
      state.data = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      $('judge-pick').append(...state.data.judges.slice().sort((a, b) => a.name.localeCompare(b.name)).map((j) => new Option(j.name, j.code)));
      update(true);
    } catch (e) {
      const s = $('status'); s.textContent = 'The data files did not load. Reload the page to try again.'; s.className = 'status err';
    }
  }

  // ------------------------------------------------------------ wiring
  const legendItem = (color, label) => { const i = el('i'); i.style.background = color; return el('span', {}, i, label); };
  const fillLegends = () => {
    document.querySelectorAll('[data-legend="cats"]').forEach((n) => n.replaceChildren(...CATS.map(([k, l]) => legendItem(`var(--c-${k})`, l))));
    document.querySelectorAll('[data-legend="outcomes"]').forEach((n) => n.replaceChildren(...OC_SEGS.map(([k, l]) => legendItem(`var(--o-${k === 'rest' ? 'other' : k})`, l))));
  };
  fillLegends();
  readHash();
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  $('judge-pick').addEventListener('change', (e) => select(e.target.value));
  $('period-pick').addEventListener('change', (e) => { state.period = e.target.value; update(true); });
  $('bars-pick').addEventListener('change', (e) => { state.bars = e.target.checked; store.set('edla-bars', state.bars ? '1' : '0'); update(false); });
  $('profile-clear').addEventListener('click', () => select(''));
  $('profile-more').addEventListener('click', (e) => { e.preventDefault(); show('finder'); });
  document.querySelectorAll('#oc-seg button').forEach((b) => b.addEventListener('click', () => { state.ocGroup = b.dataset.g; outcomeChart(); }));
  document.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', () => state.stats && downloadCsv(b.dataset.csv)));
  Object.keys(TABLES).forEach(wireTable);
  const refind = () => { state.finderLimit = 100; if (state.stats) drawFinder(); };
  ['op-q', 'op-type', 'op-outcome', 'op-pdf'].forEach((id) => $(id).addEventListener(id === 'op-q' ? 'input' : 'change', refind));
  $('op-more').addEventListener('click', () => { state.finderLimit += 200; drawFinder(); });
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(state.tab); const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { e.preventDefault(); show(TABS[(i + d + TABS.length) % TABS.length]); $('tab-' + state.tab).focus(); }
  });
  window.addEventListener('hashchange', () => { readHash(); update(false); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.stats && render(), 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.stats && render());
  load();
})();
