/* EDLA Judge Tracker: computes every figure in the browser from data/*.json. */
(() => {
  const fmt = { int: d3.format(','), d1: d3.format('.1f'), d2: d3.format('.2f'), pct0: d3.format('.0%') };
  const fmtDate = (s) => d3.utcFormat('%b %-d, %Y')(new Date(s + 'T00:00:00Z'));
  const utc = (s) => new Date(s + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const median = (v) => { const s = v.slice().sort((a, b) => a - b); const m = s.length / 2; return s.length ? (s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2) : 0; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const heat = (v) => d3.interpolateRgb('#eef3fa', '#4a84c9')(Math.max(0, Math.min(1, (v - 0.05) / 0.35)));

  let state = { selected: '', data: null, stats: null };
  try { state.selected = localStorage.getItem('edla-judge') || ''; } catch (e) { /* storage unavailable */ }

  // ------------------------------------------------------------ calculations
  function compute(D) {
    const H = new Set(D.calendar.filter((r) => r.kind === 'holiday').map((r) => r.date));
    const pick = (k) => (D.calendar.find((r) => r.kind === k) || {}).date;
    const through = pick('through');
    const workdays = (a, b) => { const out = []; for (let d = utc(a); d <= utc(b); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w > 0 && w < 6 && !H.has(iso(d))) out.push(iso(d)); } return out; };
    const span = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);

    const opStart = pick('opinions_start');
    const opinions = D.judges.map((j) => {
      const s = j.bench_start > opStart ? j.bench_start : opStart;
      const R = D.opinions.filter((o) => o.judge === j.code && o.date >= s && o.date <= through);
      const ch = R.filter((o) => !Number(o.rr));
      const mer = ch.filter((o) => Number(o.merits));
      const ds = [...new Set(R.map((o) => o.date))].sort();
      let gap = 0; let prev = s;
      ds.forEach((d) => { gap = Math.max(gap, span(prev, d)); prev = d; });
      const wd = workdays(s, through).length;
      return { name: j.name, code: j.code, working_days: wd, total: R.length, rr: R.length - ch.length, district: ch.length,
        cases: new Set(R.map((o) => o.case)).size, days_with: ds.length, per_week: ch.length / (wd / 5), merits: mer.length,
        merits_month: mer.length / (wd / 21), r12: mer.filter((o) => Number(o.r12)).length, r56: mer.filter((o) => Number(o.r56)).length, gap };
    });

    const orStart = pick('orders_start');
    const allDays = workdays(orStart, through);
    const last10 = allDays.slice(-10)[0] || orStart;
    const orders = D.judges.map((j) => {
      const s = j.bench_start > orStart ? j.bench_start : orStart;
      const R = D.orders.filter((o) => o.judge === j.code && o.date >= s && o.date <= through);
      const timed = R.filter((o) => /^\d\d:\d\d/.test(o.time || ''));
      const wd = workdays(s, through).length;
      const cases = new Set(R.map((o) => o.case)).size;
      const dow = [0, 0, 0, 0, 0, 0, 0];
      R.forEach((o) => { dow[utc(o.date).getUTCDay()] += 1; });
      const share = (i) => (R.length ? dow[i] / R.length : 0);
      return { name: j.name, code: j.code, working_days: wd, orders: R.length, per_day: wd ? R.length / wd : 0, cases,
        per_case: cases ? R.length / cases : 0,
        early: timed.length ? timed.filter((o) => o.time < '10:00').length / timed.length : 0,
        late: timed.length ? timed.filter((o) => o.time >= '17:00').length / timed.length : 0,
        last10: R.filter((o) => o.date >= last10).length, mon: share(1), tue: share(2), wed: share(3), thu: share(4), fri: share(5) };
    });

    const monday = (s) => { const d = utc(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
    const wdays = {};
    allDays.forEach((d) => { const m = monday(d); wdays[m] = (wdays[m] || 0) + 1; });
    const counts = {};
    D.orders.forEach((o) => { if (o.date >= orStart && o.date <= through) { const k = monday(o.date) + '|' + o.judge; counts[k] = (counts[k] || 0) + 1; } });
    const weekly = Object.keys(wdays).sort().map((week) => {
      const row = { week, dt: utc(week) };
      D.judges.forEach((j) => { row[j.code] = (counts[week + '|' + j.code] || 0) / wdays[week]; });
      row.median = median(D.judges.map((j) => row[j.code]));
      return row;
    });

    const names = Object.fromEntries(D.judges.map((j) => [j.code, j.name]));
    const recent = D.opinions.filter((o) => names[o.judge] && o.date >= (D.judges.find((j) => j.code === o.judge) || {}).bench_start)
      .slice().sort((a, b) => (b.date + b.case + b.doc).localeCompare(a.date + a.case + a.doc));

    const wdAll = allDays.length;
    return {
      through, names, opinions, orders, weekly, recent,
      totals: {
        orders: d3.sum(orders, (r) => r.orders), perDay: wdAll ? d3.sum(orders, (r) => r.orders) / wdAll : 0,
        opinions: d3.sum(opinions, (r) => r.total), merits: d3.sum(opinions, (r) => r.merits),
        medPerDay: median(orders.map((r) => r.per_day)), medMerits: median(opinions.map((r) => r.merits_month)),
      },
    };
  }

  // ------------------------------------------------------------ tables
  const sorts = { 'or-table': { k: 'per_day', dir: -1 }, 'op-table': { k: 'merits_month', dir: -1 }, 'dow-table': { k: 'name', dir: 1 } };
  const columns = {
    'or-table': [['name'], ['working_days', fmt.int], ['orders', fmt.int], ['per_day', fmt.d1], ['cases', fmt.int], ['per_case', fmt.d1], ['early', fmt.pct0], ['late', fmt.pct0], ['last10', fmt.int]],
    'op-table': [['name'], ['working_days', fmt.int], ['total', fmt.int], ['rr', fmt.int], ['district', fmt.int], ['cases', fmt.int], ['days_with', fmt.int], ['per_week', fmt.d2], ['merits', fmt.int], ['merits_month', fmt.d2], ['r12', fmt.int], ['r56', fmt.int], ['gap', fmt.int]],
    'dow-table': [['name'], ['mon', null, 'heat'], ['tue', null, 'heat'], ['wed', null, 'heat'], ['thu', null, 'heat'], ['fri', null, 'heat']],
  };
  const source = { 'or-table': 'orders', 'op-table': 'opinions', 'dow-table': 'orders' };

  function drawTable(id) {
    const s = sorts[id];
    const rows = state.stats[source[id]].slice().sort((a, b) => {
      const x = a[s.k]; const y = b[s.k];
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * s.dir;
    });
    document.querySelectorAll('#' + id + ' th').forEach((th) => th.setAttribute('aria-sort', th.dataset.k === s.k ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'));
    document.querySelector('#' + id + ' tbody').replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr'); tr.className = 'pickable' + (r.code === state.selected ? ' sel' : ''); tr.dataset.code = r.code;
      columns[id].forEach(([k, f, kind]) => {
        const td = document.createElement('td');
        if (kind === 'heat') { const sp = document.createElement('span'); sp.className = 'heat'; sp.style.background = heat(r[k]); sp.textContent = fmt.pct0(r[k]); td.append(sp); }
        else td.textContent = f ? f(r[k]) : r[k];
        tr.append(td);
      });
      return tr;
    }));
  }

  function wireTable(id) {
    document.querySelectorAll('#' + id + ' th button').forEach((b) => b.addEventListener('click', () => {
      const k = b.parentElement.dataset.k; const s = sorts[id];
      s.dir = s.k === k ? -s.dir : (k === 'name' ? 1 : -1); s.k = k; drawTable(id);
    }));
    document.querySelector('#' + id + ' tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-code]'); if (tr) select(tr.dataset.code === state.selected ? '' : tr.dataset.code);
    });
  }

  // ------------------------------------------------------------ charts
  function tooltip(box) { let t = box.querySelector('.tip'); if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; box.append(t); } return t; }
  function showTip(box, tip, event, lines) {
    tip.replaceChildren(...lines.map((l, i) => { const d = document.createElement('div'); if (i === 0) d.className = 'k'; d.textContent = l; return d; }));
    tip.hidden = false;
    const [x, y] = d3.pointer(event, box);
    tip.style.left = Math.max(0, Math.min(box.clientWidth - tip.offsetWidth, x + 12)) + 'px'; tip.style.top = Math.max(0, y - 10) + 'px';
  }

  function barChart(boxId, rows, field, format, label, ref) {
    const box = document.getElementById(boxId); const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar'); const ink2 = css('--ink-2');
    rows = rows.slice().sort((a, b) => b[field] - a[field]);
    const W = box.clientWidth || 400; const top = 22; const H = rows.length * 22 + top + 6;
    const svg = d3.create('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', label + ' by judge');
    box.replaceChildren(svg.node());
    const m = svg.append('text').attr('font-size', 12).text('Papillion'); const left = Math.ceil(m.node().getComputedTextLength()) + 12; m.remove();
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r[field]) || 1], [left, W - 50]);
    const y = d3.scaleBand(rows.map((r) => r.name), [top, H - 6]).padding(0.28);
    const tip = tooltip(box);
    svg.selectAll('rect').data(rows).join('rect').attr('x', left).attr('y', (r) => y(r.name)).attr('height', y.bandwidth()).attr('rx', 3)
      .attr('width', (r) => Math.max(1, x(r[field]) - left)).attr('fill', (r) => (!sel || r.code === sel ? accent : muted)).style('cursor', 'pointer')
      .on('click', (e, r) => select(r.code === sel ? '' : r.code))
      .on('mousemove', (e, r) => showTip(box, tip, e, [r.name, label + ': ' + format(r[field])])).on('mouseleave', () => { tip.hidden = true; });
    svg.selectAll('.lbl').data(rows).join('text').attr('x', left - 8).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', (r) => (r.code === sel ? 700 : 400)).text((r) => r.name);
    svg.selectAll('.val').data(rows).join('text').attr('x', (r) => x(r[field]) + 6).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('font-size', 12).attr('fill', ink2).style('fill', ink2).text((r) => format(r[field]));
    svg.append('line').attr('x1', x(ref)).attr('x2', x(ref)).attr('y1', top - 4).attr('y2', H - 6).attr('stroke', ink2).attr('stroke-dasharray', '4 3');
    svg.append('text').attr('x', x(ref)).attr('y', 12).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', ink2).text('Median ' + format(ref));
  }

  function weeklyChart() {
    const box = document.getElementById('c-weekly'); const rows = state.stats.weekly; const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar'); const ink2 = css('--ink-2'); const rule = css('--rule');
    if (!rows.length) { box.replaceChildren(); return; }
    const series = [['median', 'Median judge', sel ? muted : accent]];
    if (sel) series.push([sel, state.stats.names[sel], accent]);
    const W = box.clientWidth || 400; const H = 250; const m = { t: 10, r: 130, b: 26, l: 34 };
    const x = d3.scaleUtc(d3.extent(rows, (r) => r.dt), [m.l, W - m.r]);
    const y = d3.scaleLinear([0, (d3.max(rows, (r) => d3.max(series, ([k]) => r[k] || 0)) || 1) * 1.1], [H - m.b, m.t]).nice();
    const svg = d3.create('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Weekly orders per working day');
    box.replaceChildren(svg.node());
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 110))).tickFormat(d3.utcFormat('%b %-d')))
      .attr('font-size', null).attr('font-family', null).call((g) => g.selectAll('line,path').attr('stroke', rule)).call((g) => g.selectAll('text').style('fill', ink2).attr('font-size', 11));
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)))
      .attr('font-size', null).attr('font-family', null).call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('line').attr('stroke', rule)).call((g) => g.selectAll('text').style('fill', ink2).attr('font-size', 11));
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
    document.getElementById('weekly-note').textContent = sel
      ? state.stats.names[sel] + ' against the median judge, by week (Monday start). The current week is partial.'
      : 'The median judge, by week (Monday start). Highlight a judge to add that judge\'s line. The current week is partial.';
  }

  function fillRows(id, rows, cols) {
    document.querySelector('#' + id + ' tbody').replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      cols.forEach(([get, cls]) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = get(r); tr.append(td); });
      return tr;
    }));
  }

  // ------------------------------------------------------------ render
  function render() {
    const S = state.stats; const D = state.data; const sel = state.selected;
    document.getElementById('t-orders').textContent = fmt.int(S.totals.orders);
    document.getElementById('t-perday').textContent = fmt.d1(S.totals.perDay);
    document.getElementById('t-opinions').textContent = fmt.int(S.totals.opinions);
    document.getElementById('t-merits').textContent = fmt.int(S.totals.merits);
    document.getElementById('t-through').textContent = d3.utcFormat('%b %-d')(utc(S.through));
    const lastRun = D.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    document.getElementById('t-updated').textContent = lastRun ? 'last update ' + String(lastRun.at).slice(0, 16).replace('T', ' ') : '';
    document.getElementById('status').textContent = '';

    const pick = document.getElementById('judge-pick');
    if (pick.options.length <= 1) D.judges.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((j) => pick.append(new Option(j.name, j.code)));
    pick.value = sel; document.getElementById('judge-clear').hidden = !sel;

    Object.keys(sorts).forEach(drawTable);
    barChart('c-perday', S.orders, 'per_day', fmt.d1, 'Orders per working day', S.totals.medPerDay);
    barChart('c-merits', S.opinions, 'merits_month', fmt.d2, 'Merits rulings per month', S.totals.medMerits);
    weeklyChart();

    const recent = sel ? S.recent.filter((o) => o.judge === sel).slice(0, 15) : S.recent.slice(0, 25);
    document.getElementById('recent-title').textContent = sel ? 'Latest written opinions: ' + S.names[sel] : 'Latest written opinions';
    document.getElementById('recent-note').textContent = sel ? 'That judge\'s 15 most recent.' : 'The 25 most recent across the court. Highlight a judge to see that judge\'s latest.';
    fillRows('recent-table', recent, [[(o) => fmtDate(o.date)], [(o) => S.names[o.judge]], [(o) => o.case + ' · ' + o.doc], [(o) => o.event, 'left'], [(o) => o.title, 'left']]);
    const runs = D.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40);
    fillRows('runs-table', runs, [[(r) => String(r.at).slice(0, 16).replace('T', ' ')], [(r) => fmt.int(+r.orders_added || 0)], [(r) => fmt.int(+r.opinions_added || 0)], [(r) => r.note || '', 'left']]);
  }

  function select(code) {
    state.selected = code || '';
    try { localStorage.setItem('edla-judge', state.selected); } catch (e) { /* storage unavailable */ }
    render();
  }

  async function load() {
    const names = ['opinions', 'orders', 'judges', 'calendar', 'runs'];
    try {
      const files = await Promise.all(names.map((n) => fetch('data/' + n + '.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(n + ' ' + r.status); return r.json(); })));
      state.data = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      state.stats = compute(state.data);
      if (state.selected && !state.stats.names[state.selected]) state.selected = '';
      render();
    } catch (e) {
      const s = document.getElementById('status'); s.textContent = 'The data files did not load. Reload the page to try again.'; s.className = 'status err';
    }
  }

  document.getElementById('judge-pick').addEventListener('change', (e) => select(e.target.value));
  document.getElementById('judge-clear').addEventListener('click', () => select(''));
  Object.keys(sorts).forEach(wireTable);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.stats && render(), 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.stats && render());
  load();
})();
