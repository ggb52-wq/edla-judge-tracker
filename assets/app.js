/* EDLA Analyzer: computes every figure in the browser from data/*.json. */
(() => {
  const fmt = { int: d3.format(','), d1: d3.format('.1f'), d2: d3.format('.2f'), pct0: d3.format('.0%') };
  fmt.med = (v) => (Number.isInteger(v) ? fmt.int(v) : fmt.d1(v));  // medians of counts can land on a half
  const utc = (s) => new Date(s + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmtDate = (s) => d3.utcFormat('%b %-d, %Y')(utc(s));
  const fmtShort = (s) => d3.utcFormat('%b %-d')(utc(s));
  const fmtMonth = (m) => d3.utcFormat('%B %Y')(utc(m + '-01'));
  const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
  const later = (a, b) => (a > b ? a : b);
  const median = (v) => { const s = v.slice().sort((a, b) => a - b); const m = s.length / 2; return s.length ? (s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2) : 0; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const heat = (v) => d3.interpolateRgb('#eef2f7', '#5b87bf')(Math.max(0, Math.min(1, (v - 0.05) / 0.35)));
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); n.append(...kids.flat().filter((k) => k != null)); return n; };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } } };

  // Each written opinion falls in exactly one ruling type, checked in this order.
  const CATS = [['r12', 'Rule 12'], ['r56', 'Rule 56'], ['trial', 'Trial and post-trial'], ['rr', 'Magistrate R&Rs'], ['other', 'Other opinions']];
  const category = (o) => (Number(o.rr) ? 'rr' : Number(o.r12) ? 'r12' : Number(o.r56) ? 'r56' : Number(o.merits) ? 'trial' : 'other');
  const zeroCats = () => Object.fromEntries(CATS.map(([k]) => [k, 0]));
  const catLabel = Object.fromEntries(CATS);

  // A motion ruling names a motion ("Order on Motion to Dismiss"); clerk events such as "Terminate Motions" do not count.
  const isMotion = (o) => !Number(o.rr) && /\bmotion\s+(to|for|in)\b/i.test(o.event || '');
  // Motion categories, from the Rule 12 / Rule 56 flags first and then the motion's name in the docket event.
  const MCATS = [['r12', 'Rule 12'], ['r56', 'Rule 56'], ['discovery', 'Discovery'], ['daubert', 'Daubert / expert'], ['limine', 'In limine'],
    ['injunction', 'Injunction / TRO'], ['remand', 'Remand'], ['reconsideration', 'Reconsideration'], ['stay', 'Stay'], ['default', 'Default judgment'],
    ['fees', 'Attorney fees'], ['othermotion', 'Other motions']];
  const mcatLabel = Object.fromEntries(MCATS);
  const MCAT_RULES = [['remand', /remand/i], ['limine', /in limine/i], ['daubert', /daubert|exclude|expert/i],
    ['discovery', /compel|protective order|quash|discovery|deposition|subpoena|interrogator|produc/i],
    ['injunction', /restraining order|injunction|\btro\b/i], ['reconsideration', /reconsider/i], ['stay', /motion to stay\b/i],
    ['default', /default/i], ['fees', /attorney'?s? fees|\bfees\b/i]];
  const motionCategory = (o) => {
    if (!isMotion(o)) return '';
    if (Number(o.r12)) return 'r12';
    if (Number(o.r56)) return 'r56';
    const hit = MCAT_RULES.find(([, re]) => re.test(o.event || ''));
    return hit ? hit[0] : 'othermotion';
  };

  // Outcomes of motion rulings. "unclear" means the order text was read and no outcome was found.
  const OUTCOMES = { granted: 'Granted', granted_leave: 'Granted, leave to amend', partial: 'Granted in part', denied: 'Denied', denied_wop: 'Denied without prejudice',
    mixed: 'Mixed', moot: 'Moot', other: 'Other', unclear: 'Not determined' };
  const KNOWN = ['granted', 'granted_leave', 'partial', 'denied', 'denied_wop', 'mixed', 'moot', 'other'];
  // Outcome families: the charts and rates group "granted, leave to amend" with granted and "denied without prejudice" with denied.
  const FAMILY = { granted_leave: 'granted', denied_wop: 'denied' };
  const family = (v) => FAMILY[v] || v;
  const ocMatch = (o, f) => (f === 'known' ? KNOWN.includes(o.oc) : f === 'none' ? isMotion(o) && !KNOWN.includes(o.oc)
    : f === 'rest' ? ['mixed', 'moot', 'other'].includes(o.oc) : (f === 'granted' || f === 'denied') ? family(o.oc) === f : o.oc === f);
  const OC_SEGS = [['granted', 'Granted'], ['partial', 'Granted in part'], ['denied', 'Denied'], ['rest', 'Mixed, moot, or other']];
  const ocColor = (v) => css('--o-' + (['granted', 'partial', 'denied'].includes(family(v)) ? family(v) : 'other'));
  const OC_SRC = { manual: 'entered by hand', docket_text: 'read from the docket text', opinion_text: 'read from the order' };
  const FEW = 5;
  const GROUPS = { r12: 'Rule 12', r56: 'Rule 56', all: 'All motions' };
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

  const TABS = ['overview', 'orders', 'opinions', 'outcomes', 'finder', 'motions', 'log'];
  const emptyFinder = () => ({ q: '', type: '', oc: '', pdf: false, month: '' });
  const state = { tab: 'overview', selected: store.get('edla-judge') || '', compare: [], period: '', bars: store.get('edla-bars') !== '0',
    ocGroup: 'r12', finder: emptyFinder(), finderLimit: 100, pl: { q: '', type: '' }, mt: { view: 'past', q: '', limit: 100 }, editor: false, data: null, stats: null };
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
    const OC = new Map((D.outcomes || []).map((r) => [r.case + '|' + r.doc, r]));
    const names = Object.fromEntries(D.judges.map((j) => [j.code, j.name]));
    const bench = Object.fromEntries(D.judges.map((j) => [j.code, j.bench_start]));

    const opStart = later(pick('opinions_start'), floor);
    const orStart = later(pick('orders_start'), floor);
    // Dates on which an order set a hearing, by case, for "was a hearing set before the ruling".
    const hearingDays = {};
    D.orders.forEach((o) => { if (/hearing/i.test(o.event || '') && /set/i.test(o.event || '')) (hearingDays[o.case] = hearingDays[o.case] || []).push(o.date); });
    const opRows = [];
    const opinions = D.judges.map((j) => {
      const s = later(j.bench_start, opStart);
      const R = D.opinions.filter((o) => o.judge === j.code && o.date >= s && o.date <= through).map((o) => {
        const r = OC.get(o.case + '|' + o.doc) || {};
        const filed = /^\d{4}-\d{2}-\d{2}$/.test(r.motion_filed || '') ? r.motion_filed : '';
        // A hearing question is asked only when the whole filing-to-ruling span falls inside the orders window.
        const askHearing = !!filed && filed >= orStart && o.date >= orStart;
        return { ...o, cat: category(o), mcat: motionCategory(o), oc: r.outcome || '', ocSrc: r.src || '', motionDoc: r.motion_doc || '',
          filed, days: filed ? daysBetween(filed, o.date) : null, pages: Number(o.pages) > 0 ? Number(o.pages) : null,
          hearing: askHearing ? (hearingDays[o.case] || []).some((d) => d >= filed && d <= o.date) : null };
      });
      opRows.push(...R);
      const mix = zeroCats(); R.forEach((o) => { mix[o.cat] += 1; });
      const ch = R.filter((o) => !Number(o.rr));
      const mer = ch.filter((o) => Number(o.merits));
      const ds = [...new Set(R.map((o) => o.date))].sort();
      let gap = 0; let prev = s;
      ds.forEach((d) => { gap = Math.max(gap, daysBetween(prev, d)); prev = d; });
      const wd = workdays(s, through).length;
      const row = { name: j.name, code: j.code, start: s, working_days: wd, total: R.length, rr: R.length - ch.length, district: ch.length,
        cases: new Set(R.map((o) => o.case)).size, days_with: ds.length, per_week: wd ? ch.length / (wd / 5) : 0, merits: mer.length,
        merits_month: wd ? mer.length / (wd / 21) : 0, r12: mer.filter((o) => Number(o.r12)).length, r56: mer.filter((o) => Number(o.r56)).length, gap, mix,
        pdf: R.filter((o) => linkKind(o) === 'pdf').length };
      const tally = (G) => {
        const K = G.filter((o) => KNOWN.includes(o.oc)); const n = (v) => K.filter((o) => family(o.oc) === v).length; const exact = (v) => K.filter((o) => o.oc === v).length;
        const days = G.map((o) => o.days).filter((d) => d != null && d >= 0).sort((a, b) => a - b);
        const pages = G.map((o) => o.pages).filter((p) => p != null);
        const asked = G.filter((o) => o.hearing != null);
        return { n: G.length, known: K.length, granted: n('granted'), partial: n('partial'), denied: n('denied'),
          rest: K.length - n('granted') - n('partial') - n('denied'), grantedLeave: exact('granted_leave'), deniedWop: exact('denied_wop'), moot: exact('moot'),
          nDays: days.length, medDays: days.length ? median(days) : null, p25: days.length >= 4 ? d3.quantileSorted(days, 0.25) : null, p75: days.length >= 4 ? d3.quantileSorted(days, 0.75) : null,
          nPages: pages.length, medPages: pages.length ? median(pages) : null,
          nHearing: asked.length, hearings: asked.filter((o) => o.hearing).length };
      };
      Object.keys(GROUPS).forEach((g) => { const t = tally(R.filter((o) => inGroup(o, g))); Object.keys(t).forEach((k) => { row[g + '_' + k] = t[k]; }); });
      row.cats = Object.fromEntries(MCATS.map(([k]) => [k, tally(R.filter((o) => o.mcat === k))]));
      row.motions = tally(R.filter((o) => isMotion(o)));
      const allPages = R.map((o) => o.pages).filter((p) => p != null);
      row.med_pages = allPages.length ? median(allPages) : 0; row.n_pages = allPages.length;
      // Written opinions against all orders in the same window: how much of this judge's output is flagged as a written opinion.
      const W = R.filter((o) => o.date >= later(orStart, s));
      row.written_window = W.length; row.written_motions = W.filter((o) => isMotion(o)).length;
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

    const allDays = workdays(orStart, through);
    const last10 = allDays.slice(-10)[0] || orStart;
    const hours = { all: new Array(24).fill(0), by: {} };
    const orders = D.judges.map((j, i) => {
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
      const share = (k) => (R.length ? dow[k] / R.length : 0);
      const textOrders = R.filter((o) => /\btext order\b/i.test(o.event || '')).length;
      const motionOrders = R.filter((o) => /\bmotion\s+(to|for|in)\b/i.test(o.event || '')).length;
      const op = opinions[i];
      return { name: j.name, code: j.code, start: s, working_days: wd, orders: R.length, per_day: wd ? R.length / wd : 0, cases,
        per_case: cases ? R.length / cases : 0,
        last10: R.filter((o) => o.date >= last10).length, mon: share(1), tue: share(2), wed: share(3), thu: share(4), fri: share(5),
        text_orders: textOrders, motion_orders: motionOrders,
        written_share: R.length ? op.written_window / R.length : 0, written_motion_share: motionOrders ? Math.min(1, op.written_motions / motionOrders) : 0 };
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

    // Submitted motions: each motion from the feed, with the first later order or opinion in the same case that names
    // the same type of motion (or an outcome that cites the motion's docket number) taken as its ruling.
    const motionCore = (e) => (e || '').replace(/^.*?\bmotion\b/i, 'motion').toLowerCase().trim();
    const byCase = {};
    const addRuling = (o, kind) => { if (/\bmotion\b/i.test(o.event || '')) (byCase[o.case] = byCase[o.case] || []).push({ date: o.date, event: (o.event || '').toLowerCase(), kind }); };
    D.orders.forEach((o) => addRuling(o, 'order'));
    D.opinions.forEach((o) => addRuling(o, 'opinion'));
    const cited = new Set((D.outcomes || []).filter((r) => r.motion_doc).map((r) => r.case + '|' + r.motion_doc));
    const citedDate = Object.fromEntries((D.outcomes || []).filter((r) => r.motion_doc).map((r) => [r.case + '|' + r.motion_doc, (D.opinions.find((o) => o.case === r.case && o.doc === r.doc) || {}).date || '']));
    const motions = (D.motions || []).filter((m) => (!m.judge || names[m.judge]) && m.date <= through && (!floor || m.date >= floor)).map((m) => {
      const core = motionCore(m.event);
      let ruled = '';
      if (cited.has(m.case + '|' + m.doc)) ruled = citedDate[m.case + '|' + m.doc] || m.date;
      else { const hit = (byCase[m.case] || []).filter((r) => r.date >= m.date && r.event.includes(core)).sort((a, b) => a.date.localeCompare(b.date))[0]; if (hit) ruled = hit.date; }
      const past = !!m.submit && m.submit < through && !ruled;
      return { ...m, core, ruled, past, daysPast: past ? daysBetween(m.submit, through) : null, daysToRule: ruled ? daysBetween(m.date, ruled) : null };
    }).sort((a, b) => (b.daysPast || -1) - (a.daysPast || -1) || b.date.localeCompare(a.date));
    const motionsSince = (D.motions || []).reduce((s, m) => (s && s < m.date ? s : m.date), '');
    const byJudge = [...D.judges.map((j) => ({ name: j.name, code: j.code })), { name: 'Judge not yet known', code: '' }].map((j) => {
      const M = motions.filter((m) => m.judge === j.code);
      const P = M.filter((m) => m.past);
      return { ...j, seen: M.length, dated: M.filter((m) => m.submit).length, awaiting: M.filter((m) => !m.ruled).length, past: P.length,
        med_past: P.length ? median(P.map((m) => m.daysPast)) : 0, ruled: M.filter((m) => m.ruled).length };
    }).filter((j) => j.code || j.seen);
    const sum = (rows, k) => d3.sum(rows, (r) => r[k]);
    // A court median of grant rates is shown only when at least three judges each have FEW or more coded outcomes.
    const rate = (r, cat) => (r.cats[cat].known >= FEW ? r.cats[cat].granted / r.cats[cat].known : null);
    const medOf = (vals, min = 1) => { const v = vals.filter((x) => x != null); return v.length >= min ? median(v) : null; };
    return {
      through, names, opinions, orders, weekly, recent, monthly, hours, since: { orders: orStart, opinions: opStart }, workingDays: allDays.length,
      motions, motionsSince, motionsByJudge: byJudge,
      totals: {
        orders: sum(orders, 'orders'), perDay: allDays.length ? sum(orders, 'orders') / allDays.length : 0,
        opinions: sum(opinions, 'total'), merits: sum(opinions, 'merits'), motions: sum(opinions, 'all_n'), known: sum(opinions, 'all_known'),
        pdf: sum(opinions, 'pdf'),
        medPerDay: median(orders.map((r) => r.per_day)), medMerits: median(opinions.map((r) => r.merits_month)),
        medPerWeek: median(opinions.map((r) => r.per_week)),
        medRate: Object.fromEntries(MCATS.map(([k]) => [k, medOf(opinions.map((r) => rate(r, k)), 3)])),
        medDays: medOf(opinions.map((r) => (r.motions.nDays >= FEW ? r.motions.medDays : null)), 3),
        medWrittenShare: median(orders.map((r) => r.written_share)),
        medPages: medOf(opinions.map((r) => (r.n_pages >= FEW ? r.med_pages : null)), 3),
      },
    };
  }

  // ------------------------------------------------------------ navigation helpers
  function goFinder(preset, judge) {
    if (judge !== undefined) state.selected = judge;
    state.finder = { ...emptyFinder(), ...preset }; state.finderLimit = 100;
    show('finder');
  }
  const tipHint = (lines, hint) => lines.concat([{ hint }]);

  // ------------------------------------------------------------ tables
  const pctOf = (n, d) => (d ? fmt.pct0(n / d) : '—');
  const ocCols = (g, label) => [
    { k: g + '_n', label: 'Rulings', f: fmt.int, sum: true, group: label, gstart: true, link: (r) => ({ type: g === 'all' ? 'motion' : g }) },
    { k: g + '_known', label: 'Known', f: fmt.int, sum: true, group: label, link: (r) => ({ type: g === 'all' ? 'motion' : g, oc: 'known' }) },
    { k: g + '_granted', label: 'Granted', f: fmt.int, sum: true, group: label, link: (r) => ({ type: g === 'all' ? 'motion' : g, oc: 'granted' }) },
    { k: g + '_partial', label: 'In part', f: fmt.int, sum: true, group: label, link: (r) => ({ type: g === 'all' ? 'motion' : g, oc: 'partial' }) },
    { k: g + '_denied', label: 'Denied', f: fmt.int, sum: true, group: label, link: (r) => ({ type: g === 'all' ? 'motion' : g, oc: 'denied' }) },
    { k: g + '_rest', label: 'Other', f: fmt.int, sum: true, group: label, title: 'Mixed, moot, or other', link: (r) => ({ type: g === 'all' ? 'motion' : g, oc: 'rest' }) },
  ];
  const TABLES = {
    'or-table': { src: 'orders', sort: { k: 'per_day', dir: -1 }, pick: true, cols: [
      { k: 'name', label: 'Judge' },
      { k: 'working_days', label: 'Days', f: fmt.int, title: 'Working days in the period: weekdays other than court holidays, from the judge\'s first day on the bench' },
      { k: 'orders', label: 'Orders', f: fmt.int, bar: true, sum: true, title: 'Civil orders entered in the period' },
      { k: 'per_day', label: 'Per day', f: fmt.d1, bar: true, title: 'Orders per working day' },
      { k: 'cases', label: 'Cases', f: fmt.int, sum: true, title: 'Distinct cases with at least one order' },
      { k: 'per_case', label: 'Per case', f: fmt.d1, title: 'Orders per case with orders' },
      { k: 'last10', label: 'Last 10 days', f: fmt.int, bar: true, sum: true, title: 'Orders in the last 10 working days' },
      { k: 'spark', label: 'Trend', spark: true, title: 'Orders per working day, week by week' },
    ] },
    'op-table': { src: 'opinions', sort: { k: 'merits_month', dir: -1 }, pick: true, cols: [
      { k: 'name', label: 'Judge' },
      { k: 'working_days', label: 'Days', f: fmt.int, title: 'Working days in the period' },
      { k: 'total', label: 'Opinions', f: fmt.int, bar: true, sum: true, link: () => ({}), title: 'Entries on PACER\'s Written Opinions Report' },
      { k: 'rr', label: 'R&Rs', f: fmt.int, sum: true, link: () => ({ type: 'rr' }), title: 'Magistrate judges\' reports and recommendations in the judge\'s cases' },
      { k: 'district', label: 'By judge', f: fmt.int, sum: true, title: 'Opinions other than magistrate R&Rs' },
      { k: 'cases', label: 'Cases', f: fmt.int, sum: true, title: 'Distinct cases with an opinion' },
      { k: 'days_with', label: 'Days with', f: fmt.int, title: 'Calendar days on which an opinion was entered' },
      { k: 'per_week', label: 'Per week', f: fmt.d2, bar: true, title: 'Opinions by the judge per five working days' },
      { k: 'merits', label: 'Merits', f: fmt.int, bar: true, sum: true, link: () => ({ type: 'merits' }), title: 'Rule 12, Rule 56, and trial or post-trial rulings' },
      { k: 'merits_month', label: 'Merits / mo.', f: fmt.d2, bar: true, title: 'Merits rulings per 21 working days' },
      { k: 'r12', label: 'Rule 12', f: fmt.int, sum: true, link: () => ({ type: 'r12' }), title: 'Rulings on motions to dismiss or for judgment on the pleadings' },
      { k: 'r56', label: 'Rule 56', f: fmt.int, sum: true, link: () => ({ type: 'r56' }), title: 'Rulings on motions for summary judgment' },
      { k: 'med_pages', label: 'Pages', f: (v) => (v ? fmt.med(v) : '—'), title: 'Median PDF length of opinions with a page count on file',
        hide: (all) => all.filter((r) => r.n_pages >= FEW).length < 8 },
    ] },
    'dow-table': { src: 'orders', sort: { k: 'name', dir: 1 }, pick: true, cols: [
      { k: 'name', label: 'Judge' },
      ...[['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri']].map(([k, label]) => ({ k, label, f: fmt.pct0, heat: true })),
    ] },
    'mj-table': { src: 'motionsByJudge', sort: { k: 'past', dir: -1 }, pick: true, noMedian: true, cols: [
      { k: 'name', label: 'Judge' },
      { k: 'seen', label: 'Motions seen', f: fmt.int, sum: true, title: 'Civil motions recorded from the feed' },
      { k: 'dated', label: 'With date', f: fmt.int, sum: true, title: 'Motions whose submission date has been read from the docket text' },
      { k: 'ruled', label: 'Ruling found', f: fmt.int, sum: true, title: 'Motions matched to a later order or opinion in the same case' },
      { k: 'awaiting', label: 'Awaiting', f: fmt.int, sum: true, title: 'Motions with no ruling found yet, whether or not past submission' },
      { k: 'past', label: 'Past submission', f: fmt.int, bar: true, sum: true, title: 'Past the submission date with no ruling found' },
      { k: 'med_past', label: 'Median days past', f: (v) => (v ? fmt.med(v) : '—'), title: 'Median days since the submission date, for motions past it' },
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
    svg.append('circle').attr('cx', x(values.length - 1)).attr('cy', y(values[values.length - 1])).attr('r', 2.2).attr('fill', css('--amber'));
    return svg.node();
  }

  const cellLink = (text, preset, judge, title) => el('button', { type: 'button', className: 'cell-link', textContent: text, title: title || 'List these opinions in the finder',
    onclick: (e) => { e.stopPropagation(); goFinder(preset, judge); } });

  function drawTable(id) {
    const T = TABLES[id]; const s = T.sort; const rows = tableRows(id); const all = state.stats[T.src];
    const t = { ...T, cols: T.cols.filter((c) => !(c.hide && c.hide(all))) };  // columns the data cannot fill yet stay hidden
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
      const tr = el('tr', { className: (t.pick && r.code ? 'pickable' : '') + (state.selected && r.code === state.selected ? ' sel' : '') }); tr.dataset.code = r.code;
      t.cols.forEach((c) => {
        const td = el('td', { className: c.gstart ? 'gstart' : '' });
        if (c.spark) td.append(sparkline(r.spark));
        else if (c.heat) { const sp = el('span', { className: 'heat', textContent: c.f(r[c.k]) }); sp.style.background = heat(r[c.k]); td.append(sp); }
        else {
          const text = c.f ? c.f(r[c.k]) : r[c.k];
          if (c.link && r[c.k] > 0) td.append(cellLink(text, c.link(r), r.code)); else td.textContent = text;
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
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('th button');
      if (b) {
        const k = b.parentElement.dataset.k; const s = TABLES[id].sort;
        s.dir = s.k === k ? -s.dir : (k === 'name' ? 1 : -1); s.k = k; drawTable(id); return;
      }
      const tr = e.target.closest('tbody tr[data-code]');
      if (tr && tr.dataset.code && TABLES[id].pick && !e.target.closest('a,button')) select(tr.dataset.code === state.selected ? '' : tr.dataset.code);
    });
  }

  // ------------------------------------------------------------ CSV export
  function csvFor(id) {
    if (id === 'recent-table') {
      const head = ['Date', 'Judge', 'Case', 'Doc', 'Ruling type', 'Motion category', 'Ruling', 'Outcome', 'Outcome source', 'Motion filed', 'Days to ruling', 'Pages', 'Hearing set', 'Case name', 'Link'];
      return [head, ...finderRows().map((o) => [o.date, state.stats.names[o.judge], o.case, o.doc, catLabel[o.cat], mcatLabel[o.mcat] || '',
        o.event, OUTCOMES[o.oc] || '', o.ocSrc || '', o.filed, o.days == null ? '' : o.days, o.pages == null ? '' : o.pages, o.hearing == null ? '' : o.hearing ? 'yes' : 'no', o.title, opinionLink(o, linkKind(o))])];
    }
    if (id === 'mt-table') {
      return [['Judge', 'Case', 'Doc', 'Motion', 'Filed', 'Submission date', 'Days past submission', 'Ruling found', 'Case name'],
        ...motionRows().map((m) => [state.stats.names[m.judge] || '', m.case, m.doc, m.event, m.date, m.submit, m.daysPast == null ? '' : m.daysPast, m.ruled, m.title])];
    }
    const t = TABLES[id]; const cols = t.cols.filter((c) => !c.spark && !(c.hide && c.hide(state.stats[t.src])));
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
    tip.replaceChildren(...lines.map((l, i) => (typeof l === 'object' ? el('div', { className: 'hint', textContent: l.hint }) : el('div', { className: i === 0 ? 'k' : '', textContent: l }))));
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
      .attr('width', (r) => Math.max(1, x(r[field]) - left)).attr('fill', (r) => (!sel || r.code === sel ? accent : muted)).attr('data-link', 1)
      .on('click', (e, r) => select(r.code === sel ? '' : r.code))
      .on('mousemove', (e, r) => showTip(box, tip, e, tipHint([r.name, label + ': ' + format(r[field])], 'Click to pick this judge'))).on('mouseleave', () => { tip.hidden = true; });
    svg.selectAll('.lbl').data(rows).join('text').attr('x', left - 8).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', (r) => (r.code === sel ? 600 : 400)).text((r) => r.name);
    svg.selectAll('.val').data(rows).join('text').attr('x', (r) => x(r[field]) + 6).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('font-size', 11).style('fill', ink2).text((r) => format(r[field]));
    svg.append('line').attr('x1', x(ref)).attr('x2', x(ref)).attr('y1', top - 4).attr('y2', H - 6).attr('stroke', css('--amber')).attr('stroke-dasharray', '4 3');
    svg.append('text').attr('x', x(ref)).attr('y', 12).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', ink2).text('Median ' + format(ref));
  }

  function weeklyChart() {
    const box = $('c-weekly'); const rows = state.stats.weekly; const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar'); const ink2 = css('--ink-2');
    $('weekly-note').textContent = (sel ? state.stats.names[sel] + ' and the median judge' : 'The median judge') + ', week by week. The current week is not finished yet.';
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
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).attr('fill', 'transparent').attr('data-link', 1)
      .on('click', () => show('orders'))
      .on('mousemove', (e) => {
        const t = x.invert(d3.pointer(e)[0]);
        const r = rows.reduce((best, q) => (Math.abs(q.dt - t) < Math.abs(best.dt - t) ? q : best), rows[0]);
        ruleLine.attr('x1', x(r.dt)).attr('x2', x(r.dt)).attr('opacity', 1);
        showTip(box, tip, e, ['Week of ' + d3.utcFormat('%b %-d')(r.dt), ...series.map(([k, label]) => label + ': ' + fmt.d1(r[k] || 0))]);
      })
      .on('mouseleave', () => { tip.hidden = true; ruleLine.attr('opacity', 0); });
  }

  // Columns stacked by ruling type, one per month; follows the picked judge. A segment opens those opinions in the finder.
  function monthlyChart() {
    const box = $('c-monthly'); const S = state.stats; const sel = state.selected; const panel = css('--panel');
    $('monthly-title').textContent = 'Written opinions by month' + (sel ? ': ' + S.names[sel] : '');
    $('monthly-note').textContent = (sel ? S.names[sel] + "'s opinions each month, by type." : 'All 16 judges combined, by type.') + ' Click a bar segment to see those opinions.';
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
      let acc = 0; const total = d3.sum(CATS, ([k]) => r.c[k]);
      CATS.forEach(([k, label]) => {
        const v = r.c[k]; if (!v) return;
        svg.append('rect').attr('x', x(r.month)).attr('width', x.bandwidth()).attr('y', y(acc + v)).attr('height', y(acc) - y(acc + v))
          .attr('fill', css('--c-' + k)).attr('stroke', panel).attr('stroke-width', 1).attr('data-link', 1)
          .on('click', () => goFinder({ type: k, month: r.month }))
          .on('mousemove', (e) => showTip(box, tip, e, tipHint([fmtMonth(r.month) + ': ' + fmt.int(total), label + ': ' + fmt.int(v)], 'Click to list these opinions')))
          .on('mouseleave', () => { tip.hidden = true; });
        acc += v;
      });
    });
  }

  // One 100% bar per judge, alphabetical. segs: [[key, label, color]]; value(r, key) and total(r) give the counts.
  function shareBars(boxId, label, segs, value, total, emptyText, few, onSeg) {
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
      const g = svg.append('g').attr('opacity', (!sel || r.code === sel ? 1 : 0.35) * (n && few && n < few ? 0.45 : 1));
      let acc = 0;
      segs.forEach(([k, l, color]) => {
        const v = n ? value(r, k) / n : 0; if (!v) return;
        g.append('rect').attr('x', x(acc)).attr('width', x(acc + v) - x(acc)).attr('y', y(r.name)).attr('height', y.bandwidth())
          .attr('fill', color).attr('stroke', panel).attr('stroke-width', 1).attr('data-link', 1)
          .on('click', () => onSeg(r, k))
          .on('mousemove', (e) => showTip(box, tip, e, tipHint([r.name + ': ' + fmt.int(n), ...segs.map(([k2, l2]) => l2 + ': ' + fmt.int(value(r, k2)) + (n ? ' (' + fmt.pct0(value(r, k2) / n) + ')' : ''))], 'Click to list: ' + l)))
          .on('mouseleave', () => { tip.hidden = true; });
        acc += v;
      });
      if (!n) g.append('text').attr('x', left + 4).attr('y', y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em').attr('font-size', 11).style('fill', ink2).text(emptyText);
    });
    svg.selectAll('.lbl').data(rows).join('text').attr('x', left - 8).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', (r) => (r.code === sel ? 600 : 400)).style('cursor', 'pointer')
      .on('click', (e, r) => select(r.code === sel ? '' : r.code)).text((r) => r.name);
    svg.selectAll('.val').data(rows).join('text').attr('x', W - right + 6).attr('y', (r) => y(r.name) + y.bandwidth() / 2).attr('dy', '0.35em')
      .attr('font-size', 11).style('fill', ink2).text((r) => 'n=' + fmt.int(total(r)));
  }

  function mixChart() {
    shareBars('c-mix', 'Mix of written opinions by judge', CATS.map(([k, l]) => [k, l, css('--c-' + k)]), (r, k) => r.mix[k], (r) => r.total, 'No opinions', 0,
      (r, k) => goFinder({ type: k }, r.code));
  }

  function outcomeChart() {
    const g = state.ocGroup;
    document.querySelectorAll('#oc-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === g)));
    const known = d3.sum(state.stats.opinions, (r) => r[g + '_known']); const n = d3.sum(state.stats.opinions, (r) => r[g + '_n']);
    $('oc-note').textContent = `How each judge's ${GROUPS[g].toLowerCase()} rulings came out, counting only rulings with a recorded outcome (${fmt.int(known)} of ${fmt.int(n)} so far). "n" is the number recorded. Faded bars rest on fewer than ${FEW} rulings, which is too few to read much into. Click a segment to see those opinions.`;
    shareBars('c-outcomes', 'Outcomes of ' + GROUPS[g] + ' rulings by judge', OC_SEGS.map(([k, l]) => [k, l, ocColor(k)]), (r, k) => r[g + '_' + k], (r) => r[g + '_known'], 'No outcomes on file yet', FEW,
      (r, k) => goFinder({ type: g === 'all' ? 'motion' : g, oc: k }, r.code));
  }

  // Share of timed orders by hour of entry: the court, plus the picked judge.
  function hoursChart() {
    const box = $('c-hours'); const S = state.stats; const sel = state.selected;
    const accent = css('--accent'); const muted = css('--muted-bar');
    $('hours-note').textContent = 'What time of day orders come out (Central), since ' + fmtDate(S.since.orders)
      + (sel ? ': ' + S.names[sel] + ' next to the whole court.' : '. Pick a judge to compare.');
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

  // Filter used by the finder and the profile list. type: a ruling type, "merits", "motion", or a motion category.
  const typeMatch = (o, type) => !type || (type === 'merits' ? Number(o.merits) && !Number(o.rr) : type === 'motion' ? isMotion(o) : mcatLabel[type] ? o.mcat === type : o.cat === type);
  const textMatch = (o, q) => !q || (o.case + ' ' + o.title + ' ' + o.event).toLowerCase().includes(q);

  // ------------------------------------------------------------ finder
  function finderRows() {
    const S = state.stats; const sel = state.selected; const F = state.finder; const q = F.q.trim().toLowerCase();
    return S.recent.filter((o) => (!sel || o.judge === sel) && typeMatch(o, F.type)
      && (!F.oc || ocMatch(o, F.oc))
      && (!F.pdf || linkKind(o) === 'pdf') && (!F.month || o.date.slice(0, 7) === F.month) && textMatch(o, q));
  }
  function drawFinder() {
    const S = state.stats; const F = state.finder;
    $('op-q').value = F.q; $('op-type').value = F.type; $('op-outcome').value = F.oc === 'rest' ? '' : F.oc; $('op-pdf').checked = F.pdf;
    const chips = [];
    if (F.month) chips.push(['Month: ' + fmtMonth(F.month), () => { F.month = ''; }]);
    if (F.oc === 'rest') chips.push(['Outcome: mixed, moot, or other', () => { F.oc = ''; }]);
    $('op-chips').replaceChildren(...chips.map(([label, clear]) => el('span', { className: 'fchip' }, label, el('button', { type: 'button', textContent: '×', title: 'Remove this filter', onclick: () => { clear(); drawFinder(); } }))));
    const rows = finderRows(); const shown = rows.slice(0, state.finderLimit);
    // Columns with nothing to show for this list stay hidden rather than filling with dashes.
    const hasDays = rows.some((o) => o.days != null); const hasPages = rows.some((o) => o.pages != null);
    const cols = ['Date', 'Judge', 'Case · doc', 'Ruling', 'Outcome'].concat(hasDays ? ['Days to ruling'] : [], hasPages ? ['Pages'] : [], ['Case name'], state.editor ? ['Record'] : []);
    const head = el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c }))));
    const body = el('tbody', {}, ...shown.map((o) => {
      const cells = [el('td', { textContent: fmtDate(o.date) }), el('td', { className: 'txt', textContent: S.names[o.judge] }), el('td', { className: 'txt' }, ...caseLink(o)),
        el('td', { className: 'left', textContent: o.event }), el('td', { className: 'txt' }, outcomePill(o))];
      if (hasDays) cells.push(el('td', { className: o.days == null ? 'dim' : '', textContent: o.days == null ? '—' : fmt.int(o.days), title: o.filed ? 'Motion filed ' + fmtDate(o.filed) : 'Motion filing date not on file' }));
      if (hasPages) cells.push(el('td', { className: o.pages == null ? 'dim' : '', textContent: o.pages == null ? '—' : fmt.int(o.pages), title: o.pages == null ? 'Page count not on file' : 'Pages in the PDF' }));
      cells.push(el('td', { className: 'left', textContent: o.title }));
      if (state.editor) cells.push(el('td', { className: 'txt' }, el('a', { href: recordLink(o), target: '_blank', rel: 'noopener noreferrer', textContent: o.oc ? 'Correct' : 'Record' })));
      return el('tr', {}, ...cells);
    }));
    $('recent-table').replaceChildren(head, body);
    $('op-count').textContent = rows.length ? 'Showing ' + fmt.int(shown.length) + ' of ' + fmt.int(rows.length) : 'No matching opinions';
    $('op-more').hidden = shown.length >= rows.length;
    $('finder-title').textContent = 'Opinion finder' + (state.selected ? ': ' + S.names[state.selected] : '');
  }

  // ------------------------------------------------------------ judge profile
  const fact = (k, v, sub, na) => el('div', { className: 'fact' + (na ? ' na' : '') }, el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: sub }));
  const rateText = (t) => (t.known ? `${pctOf(t.granted, t.known)} granted · ${pctOf(t.partial, t.known)} in part · ${pctOf(t.denied, t.known)} denied` : 'none coded yet');

  function drawProfile() {
    const S = state.stats; const sel = state.selected;
    $('profile-empty').hidden = !!sel; $('profile-body').hidden = !sel; $('profile-clear').hidden = !sel; $('profile-print').hidden = !sel;
    $('profile-title').textContent = sel ? 'Judge ' + S.names[sel] : 'Judge profile';
    const chips = $('profile-chips');
    if (!chips.childElementCount) chips.append(...state.data.judges.slice().sort((a, b) => a.name.localeCompare(b.name)).map((j) => el('button', { type: 'button', className: 'chip', textContent: j.name, onclick: () => select(j.code) })));
    chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    if (!sel) return;
    const or = S.orders.find((r) => r.code === sel); const op = S.opinions.find((r) => r.code === sel);
    $('profile-facts').replaceChildren(
      fact('Orders per working day', fmt.d1(or.per_day), 'court median ' + fmt.d1(S.totals.medPerDay)),
      fact('Civil orders', fmt.int(or.orders), fmt.int(or.last10) + ' in the last 10 working days'),
      fact('Written opinions', fmt.int(op.total), fmt.d2(op.per_week) + ' per week · median ' + fmt.d2(S.totals.medPerWeek)),
      fact('Merits rulings per month', fmt.d2(op.merits_month), 'court median ' + fmt.d2(S.totals.medMerits)),
      fact('Rule 12 rulings', fmt.int(op.cats.r12.n), rateText(op.cats.r12)),
      fact('Rule 56 rulings', fmt.int(op.cats.r56.n), rateText(op.cats.r56)),
      fact('Median days to ruling', op.motions.medDays == null ? 'not yet' : fmt.med(op.motions.medDays), op.motions.nDays ? `from ${fmt.int(op.motions.nDays)} motion rulings with filing dates` : 'filing dates still being collected', op.motions.medDays == null),
      fact('Median opinion length', op.n_pages ? fmt.med(op.med_pages) + ' pages' : 'not yet', op.n_pages ? `from ${fmt.int(op.n_pages)} opinions with a PDF` : 'page counts still being collected', !op.n_pages),
      fact('Counted from', fmtShort(op.start > or.start ? or.start : op.start), op.start === S.since.opinions ? 'start of the data' : 'first day in the period'),
    );
    $('profile-period').textContent = state.period ? '· last ' + state.period + ' days' : '';
    drawProfileList(); drawMotions(op); drawSpeed(op); drawWritten(or, op); drawCompare();
  }

  function drawProfileList() {
    const S = state.stats; const sel = state.selected; if (!sel) return;
    const q = state.pl.q.trim().toLowerCase();
    $('pl-q').value = state.pl.q; $('pl-type').value = state.pl.type;
    const rows = S.recent.filter((o) => o.judge === sel && typeMatch(o, state.pl.type) && textMatch(o, q));
    const shown = rows.slice(0, 12);
    $('pl-count').textContent = rows.length ? (rows.length > shown.length ? `latest ${shown.length} of ${fmt.int(rows.length)}` : `${rows.length} opinion${rows.length === 1 ? '' : 's'}`) : 'no matches';
    $('profile-latest').replaceChildren(...(shown.length ? shown.map((o) => el('li', {}, el('span', { className: 'd', textContent: fmtShort(o.date) }),
      el('span', {}, ...caseLink(o), ...(o.oc ? [' ', outcomePill(o)] : [])), el('span', { className: 't', textContent: o.event + ' · ' + o.title })))
      : [el('li', {}, el('span', { className: 'empty', textContent: q || state.pl.type ? 'No written opinions match this filter.' : 'No written opinions in this period.' }))]));
    const more = $('profile-more'); more.textContent = rows.length > shown.length ? `All ${fmt.int(rows.length)} in the finder` : "All of this judge's opinions in the finder";
  }

  // Motion outcomes by category for the picked judge; every figure opens the opinions behind it.
  function drawMotions(op) {
    const S = state.stats; const sel = state.selected;
    $('mo-note').textContent = `How ${S.names[sel]}'s motion rulings came out, by type of motion, since ${fmtDate(S.since.opinions)}. Percentages count only rulings with a recorded outcome; "coded" is how many that is. "Granted" means the motion was granted, no matter who filed it. Click any number to see the opinions behind it.`;
    const cols = ['Motion category', 'Rulings', 'Coded', 'Granted', 'Granted in part', 'Denied', 'Mixed, moot, other', 'Days to ruling', 'Pages'];
    const head = el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c }))));
    const line = (label, t, type) => {
      const tr = el('tr'); tr.dataset.cat = type;
      const n = (v, preset) => el('td', {}, v > 0 ? cellLink(fmt.int(v), { type, ...preset }, sel) : el('span', { className: 'dim', textContent: '0' }));
      const detail = { granted: t.grantedLeave ? `; ${fmt.int(t.grantedLeave)} with leave to amend` : '', denied: t.deniedWop ? `; ${fmt.int(t.deniedWop)} without prejudice` : '', rest: t.moot ? `; ${fmt.int(t.moot)} moot` : '', partial: '' };
      const pct = (v, oc) => el('td', {}, t.known && v > 0 ? cellLink(fmt.pct0(v / t.known), { type, oc }, sel, `${fmt.int(v)} of ${fmt.int(t.known)} coded rulings${detail[oc]}`) : el('span', { className: 'dim', textContent: t.known ? '0%' : '—' }));
      tr.append(el('td', { className: 'txt', textContent: label }), n(t.n, {}), el('td', {}, t.known ? cellLink(fmt.int(t.known), { type, oc: 'known' }, sel) : el('span', { className: 'dim', textContent: '0' })));
      if (t.n && !t.known) tr.append(el('td', { className: 'coding', colSpan: 4, textContent: 'outcome coding in progress' }));
      else if (!t.n) tr.append(el('td', { className: 'dim', colSpan: 4, textContent: 'no rulings in this period' }));
      else tr.append(pct(t.granted, 'granted'), pct(t.partial, 'partial'), pct(t.denied, 'denied'), pct(t.rest, 'rest'));
      tr.append(el('td', { className: t.medDays == null ? 'dim' : '', textContent: daysText(t), title: t.medDays == null ? 'No filing dates on file yet' : 'Median calendar days from the motion\'s docket date to the ruling, with the middle half of rulings in parentheses' }));
      tr.append(el('td', { className: t.medPages == null ? 'dim' : '', textContent: t.medPages == null ? '—' : fmt.med(t.medPages) + ' (n=' + t.nPages + ')', title: 'Median PDF length' }));
      return tr;
    };
    const body = el('tbody', {}, ...MCATS.map(([k, label]) => line(label, op.cats[k], k)), line('All motion rulings', op.motions, 'motion'));
    body.lastChild.style.fontWeight = '600';
    $('mo-table').replaceChildren(head, body);
  }

  // "45 (30–70, n=12)": the median, the middle half when four or more rulings have dates, and the count.
  const daysText = (t) => (t.medDays == null ? '—' : fmt.med(t.medDays) + (t.p25 != null ? ` (${fmt.med(t.p25)}–${fmt.med(t.p75)}, n=${t.nDays})` : ` (n=${t.nDays})`));

  function drawSpeed(op) {
    const S = state.stats; const t = op.motions;
    $('speed-note').textContent = 'How many days passed between a motion being filed and the written opinion deciding it. These are medians in calendar days. We collect filing dates one ruling at a time, so the numbers fill in gradually. '
      + (t.nDays ? `So far ${fmt.int(t.nDays)} of ${S.names[state.selected]}'s ${fmt.int(t.n)} motion rulings have a filing date.` : `None of ${S.names[state.selected]}'s rulings has a filing date yet; check back soon.`);
    const cell = (label, tt) => fact(label, tt.medDays == null ? 'not yet' : fmt.med(tt.medDays) + ' days',
      tt.nDays ? (tt.p25 != null ? `middle half ${fmt.med(tt.p25)}–${fmt.med(tt.p75)} days · n=${fmt.int(tt.nDays)}` : `from ${fmt.int(tt.nDays)} ruling${tt.nDays === 1 ? '' : 's'}`) : 'no filing dates yet', tt.medDays == null);
    const h = t.nHearing ? fact('Hearing set before ruling', pctOf(t.hearings, t.nHearing), `${fmt.int(t.hearings)} of ${fmt.int(t.nHearing)} motions with a hearing set in the case between filing and ruling`)
      : fact('Hearing set before ruling', 'not yet', 'needs motions filed and decided since ' + fmtShort(S.since.orders), true);
    $('speed-facts').replaceChildren(cell('All motions', t), ...MCATS.filter(([k]) => op.cats[k].n).map(([k, label]) => cell(label, op.cats[k])),
      fact('Court median, all motions', S.totals.medDays == null ? 'not yet' : fmt.med(S.totals.medDays) + ' days', S.totals.medDays == null ? `shown once three judges have ${FEW} or more dated rulings` : 'median of the judges\' medians', S.totals.medDays == null), h);
  }

  function drawWritten(or, op) {
    const S = state.stats;
    $('written-note').textContent = `How much of this judge's output is a written opinion versus a short order, since ${fmtDate(S.since.orders)}. "Written opinion" means chambers flagged the order for PACER's Written Opinions Report. The docket can't tell an unflagged reasoned order from a minute entry, so treat this as a measure of flagging habits.`;
    $('written-facts').replaceChildren(
      fact('Civil orders', fmt.int(or.orders), fmt.int(or.text_orders) + ' entered as text orders (' + pctOf(or.text_orders, or.orders) + ')'),
      fact('Written opinions in the same period', fmt.int(op.written_window), pctOf(op.written_window, or.orders) + ' of orders · court median ' + fmt.pct0(S.totals.medWrittenShare)),
      fact('Orders on motions', fmt.int(or.motion_orders), 'orders whose docket event names a motion'),
      fact('Written opinions on motions', fmt.int(op.written_motions), pctOf(op.written_motions, or.motion_orders) + ' of motion orders'),
    );
  }

  function drawCompare() {
    const S = state.stats; const sel = state.selected;
    const others = state.data.judges.filter((j) => j.code !== sel).sort((a, b) => a.name.localeCompare(b.name));
    ['cmp-1', 'cmp-2'].forEach((id, i) => {
      const s = $(id); s.replaceChildren(new Option('—', ''), ...others.map((j) => new Option(j.name, j.code))); s.value = state.compare[i] || '';
    });
    const codes = [sel, ...state.compare.filter((c) => c && c !== sel && S.names[c])];
    const ors = codes.map((c) => S.orders.find((r) => r.code === c)); const ops = codes.map((c) => S.opinions.find((r) => r.code === c));
    const rateCell = (t) => (t.known ? `${pctOf(t.granted, t.known)} granted · ${pctOf(t.denied, t.known)} denied (n=${t.known})` : t.n ? `${fmt.int(t.n)} rulings, none coded yet` : 'no rulings');
    const medRate = (k) => (S.totals.medRate[k] == null ? 'too few coded' : fmt.pct0(S.totals.medRate[k]) + ' granted');
    const rows = [
      ['Orders per working day', (i) => fmt.d1(ors[i].per_day), fmt.d1(S.totals.medPerDay)],
      ['Written opinions per week', (i) => fmt.d2(ops[i].per_week), fmt.d2(S.totals.medPerWeek)],
      ['Merits rulings per month', (i) => fmt.d2(ops[i].merits_month), fmt.d2(S.totals.medMerits)],
      ['Written opinions as a share of orders', (i) => fmt.pct0(ors[i].written_share), fmt.pct0(S.totals.medWrittenShare)],
      ['Median opinion length', (i) => (ops[i].n_pages ? fmt.med(ops[i].med_pages) + ' pages (n=' + ops[i].n_pages + ')' : 'not yet'), S.totals.medPages ? fmt.med(S.totals.medPages) + ' pages' : '—'],
      ...MCATS.filter(([k]) => ops.some((o) => o.cats[k].n)).map(([k, label]) => [label + ' outcomes', (i) => rateCell(ops[i].cats[k]), medRate(k)]),
      ['Median days to ruling, all motions', (i) => (ops[i].motions.medDays == null ? 'not yet' : fmt.med(ops[i].motions.medDays) + ' (n=' + ops[i].motions.nDays + ')'), S.totals.medDays == null ? '—' : fmt.med(S.totals.medDays)],
    ];
    const head = el('thead', {}, el('tr', {}, el('th', { textContent: 'Figure' }), ...codes.map((c) => el('th', { textContent: S.names[c] })), el('th', { textContent: 'Court median' })));
    const body = el('tbody', {}, ...rows.map(([label, f, med]) => el('tr', {}, el('td', { className: 'txt', textContent: label }), ...codes.map((c, i) => el('td', { className: 'txt', textContent: f(i) })), el('td', { className: 'txt dim', textContent: med }))));
    $('cmp-table').replaceChildren(head, body);
  }

  function flashPanel(id, cat) {
    const p = $(id); if (!p) return;
    p.scrollIntoView({ behavior: 'smooth', block: 'start' }); p.focus({ preventScroll: true });
    p.classList.add('flash'); setTimeout(() => p.classList.remove('flash'), 1800);
    if (cat) { const tr = p.querySelector(`tr[data-cat="${cat}"]`); if (tr) { tr.classList.add('hl'); setTimeout(() => tr.classList.remove('hl'), 1800); } }
  }

  // ------------------------------------------------------------ overview
  function drawTiles() {
    const S = state.stats; const T = S.totals; const D = state.data;
    $('t-orders').textContent = fmt.int(T.orders);
    $('t-perday').textContent = fmt.d1(T.perDay);
    $('t-opinions').textContent = fmt.int(T.opinions);
    $('t-opinions-sub').textContent = `since ${fmtDate(S.since.opinions)} · ${fmt.int(T.pdf)} with a PDF`;
    $('t-merits').textContent = fmt.int(T.merits);
    $('t-merits-sub').textContent = `Rule 12, Rule 56, trial · outcomes coded for ${fmt.int(T.known)} of ${fmt.int(T.motions)} motion rulings`;
    $('t-through').textContent = fmtShort(S.through);
    const lastRun = D.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    $('t-updated').textContent = lastRun ? 'updated ' + String(lastRun.at).slice(5, 16).replace('T', ' ') + ' Central' : '';
    $('t-perday-spark').replaceChildren(sparkline(S.weekly.map((w) => w.all), 120, 22));
    $('t-opinions-spark').replaceChildren(sparkline(S.monthly.map((m) => d3.sum(CATS, ([k]) => m.all[k])), 120, 22));
  }

  // ------------------------------------------------------------ submitted motions
  function motionRows() {
    const S = state.stats; const sel = state.selected; const v = state.mt.view; const q = state.mt.q.trim().toLowerCase();
    return S.motions.filter((m) => (!sel || m.judge === sel) && (v === 'all' || (v === 'pending' ? !m.ruled : m.past))
      && (!q || (m.case + ' ' + m.title + ' ' + m.event).toLowerCase().includes(q)));
  }
  function drawMotions() {
    const S = state.stats; const sel = state.selected; const all = S.motions.filter((m) => !sel || m.judge === sel);
    $('mt-title').textContent = 'Submitted motions' + (sel ? ': ' + S.names[sel] : '');
    $('mt-since').textContent = S.motionsSince ? fmtDate(S.motionsSince) : 'the day this page went live';
    $('n-motions').textContent = fmt.int(S.motions.filter((m) => m.past).length);
    $('mt-view').value = state.mt.view; $('mt-q').value = state.mt.q;
    const past = all.filter((m) => m.past);
    $('mt-facts').replaceChildren(
      fact('Motions on file', fmt.int(all.length), S.motionsSince ? 'since ' + fmtShort(S.motionsSince) : 'none yet'),
      fact('With a submission date', fmt.int(all.filter((m) => m.submit).length), 'read from the docket text so far'),
      fact('Ruling found', fmt.int(all.filter((m) => m.ruled).length), 'a later order or opinion names the motion type'),
      fact('Past submission, no ruling found', fmt.int(past.length), past.length ? 'median ' + fmt.med(median(past.map((m) => m.daysPast))) + ' days past' : 'none right now'),
    );
    const rows = motionRows(); const shown = rows.slice(0, state.mt.limit);
    const head = el('thead', {}, el('tr', {}, ...['Judge', 'Case · doc', 'Motion', 'Filed', 'Submission', 'Days past', 'Status', 'Case name'].map((c) => el('th', { textContent: c }))));
    const body = el('tbody', {}, ...(shown.length ? shown.map((m) => el('tr', {},
      el('td', { className: 'txt', textContent: S.names[m.judge] || '—', title: m.judge ? '' : 'Judge not yet known for this case' }),
      el('td', { className: 'txt' }, el('a', { href: CL + '?type=r&court=laed&docket_number=' + encodeURIComponent(m.case), target: '_blank', rel: 'noopener noreferrer', textContent: m.case + ' · ' + m.doc, title: 'Search CourtListener for this case' })),
      el('td', { className: 'left', textContent: m.event }),
      el('td', { textContent: fmtDate(m.date) }),
      el('td', { className: m.submit ? '' : 'dim', textContent: m.submit ? fmtDate(m.submit) : 'not read yet' }),
      el('td', { className: m.daysPast == null ? 'dim' : '', textContent: m.daysPast == null ? '—' : fmt.int(m.daysPast) }),
      el('td', { className: 'txt' }, m.ruled ? el('span', { className: 'pill' }, (() => { const i = el('i'); i.style.background = css('--o-partial'); return i; })(), 'Ruling found ' + fmtShort(m.ruled))
        : m.past ? el('span', { className: 'pill' }, (() => { const i = el('i'); i.style.background = css('--amber'); return i; })(), 'Past submission')
        : el('span', { className: 'pill none', textContent: m.submit ? 'Not yet submitted' : 'Awaiting' })),
      el('td', { className: 'left', textContent: m.title }),
    )) : [el('tr', {}, el('td', { className: 'left dim', colSpan: 8, textContent: S.motions.length ? 'No motions match.' : 'No motions on file yet. The updater records them from the court\'s feed as they are filed.' }))]));
    $('mt-table').replaceChildren(head, body);
    $('mt-count').textContent = rows.length ? 'Showing ' + fmt.int(shown.length) + ' of ' + fmt.int(rows.length) : '';
    $('mt-more').hidden = shown.length >= rows.length;
    drawTable('mj-table');
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
    orders: () => { drawTable('or-table'); drawTable('dow-table'); barChart('c-perday', state.stats.orders, 'per_day', fmt.d1, 'Orders per working day', state.stats.totals.medPerDay);
      $('dow-days').textContent = fmt.int(state.stats.workingDays); if ($('curio-hours').open) hoursChart(); },
    opinions: () => { drawTable('op-table'); barChart('c-merits', state.stats.opinions, 'merits_month', fmt.d2, 'Merits rulings per month', state.stats.totals.medMerits); mixChart(); },
    outcomes: () => { drawTable('oc-table'); outcomeChart(); },
    finder: drawFinder,
    motions: drawMotions,
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

  // The address carries the section, judge, comparison set, and period: #overview?judge=BSL&vs=EEF,JTM&period=90
  function writeHash() {
    const p = new URLSearchParams();
    if (state.selected) p.set('judge', state.selected);
    if (state.compare.filter(Boolean).length) p.set('vs', state.compare.filter(Boolean).join(','));
    if (state.period) p.set('period', state.period);
    const h = '#' + state.tab + (p.toString() ? '?' + p : '');
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  const judgeCode = (v) => { if (!state.data) return v; const j = state.data.judges.find((x) => x.code === v || x.name.toLowerCase() === String(v).toLowerCase()); return j ? j.code : ''; };
  function readHash() {
    const raw = location.hash.slice(1);
    const [tab, query] = raw.includes('?') || !raw.includes('=') ? raw.split('?') : ['', raw];  // also accepts #judge=Africk
    if (TABS.includes(tab)) state.tab = tab;
    const p = new URLSearchParams(query || '');
    if (p.has('judge')) state.selected = judgeCode(p.get('judge'));
    if (p.has('vs')) state.compare = p.get('vs').split(',').map(judgeCode).filter(Boolean).slice(0, 2);
    if (p.has('period')) state.period = ['30', '90'].includes(p.get('period')) ? p.get('period') : '';
  }

  function update(recompute) {
    if (!state.data) return;
    if (recompute) state.stats = compute(state.data, state.period);
    if (state.selected && !state.stats.names[state.selected]) state.selected = '';
    state.compare = state.compare.filter((c) => c && c !== state.selected && state.stats.names[c]);
    store.set('edla-judge', state.selected);
    writeHash(); render();
  }
  function select(code) { state.selected = code || ''; state.finderLimit = 100; state.pl = { q: '', type: '' }; update(false); }
  function show(tab) { state.tab = tab; update(false); window.scrollTo({ top: Math.min(window.scrollY, document.querySelector('.bar').offsetTop) }); }

  async function load() {
    const names = ['opinions', 'orders', 'judges', 'calendar', 'runs', 'outcomes', 'motions'];
    try {
      const files = await Promise.all(names.map((n) => fetch('data/' + n + '.json', { cache: 'no-cache' })
        .then((r) => { if (!r.ok) { if (n === 'outcomes' || n === 'motions') return []; throw new Error(n + ' ' + r.status); } return r.json(); })));
      state.data = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      $('judge-pick').append(...state.data.judges.slice().sort((a, b) => a.name.localeCompare(b.name)).map((j) => new Option(j.name, j.code)));
      readHash();  // again, now that judge names can be resolved
      update(true);
    } catch (e) {
      const s = $('status'); s.textContent = 'The data files did not load. Reload the page to try again.'; s.className = 'status err';
    }
  }

  // ------------------------------------------------------------ wiring
  const legendItem = (color, label) => { const i = el('i'); i.style.background = color; return el('span', {}, i, label); };
  document.querySelectorAll('[data-legend="cats"]').forEach((n) => n.replaceChildren(...CATS.map(([k, l]) => legendItem(`var(--c-${k})`, l))));
  document.querySelectorAll('[data-legend="outcomes"]').forEach((n) => n.replaceChildren(...OC_SEGS.map(([k, l]) => legendItem(`var(--o-${k === 'rest' ? 'other' : k})`, l))));
  readHash();
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  document.querySelectorAll('.tile[data-go]').forEach((b) => b.addEventListener('click', () => {
    const go = b.dataset.go; if (go === 'finder') goFinder({}); else if (go === 'merits') goFinder({ type: 'merits' }); else show(go);
  }));
  $('judge-pick').addEventListener('change', (e) => select(e.target.value));
  $('period-pick').addEventListener('change', (e) => { state.period = e.target.value; update(true); });
  $('bars-pick').addEventListener('change', (e) => { state.bars = e.target.checked; store.set('edla-bars', state.bars ? '1' : '0'); update(false); });
  $('profile-clear').addEventListener('click', () => select(''));
  $('profile-more').addEventListener('click', (e) => { e.preventDefault(); goFinder({ q: state.pl.q, type: state.pl.type }); });
  $('profile-print').addEventListener('click', () => { document.body.classList.add('print-profile'); window.print(); });
  window.addEventListener('afterprint', () => document.body.classList.remove('print-profile'));
  document.querySelectorAll('.q').forEach((b) => b.addEventListener('click', () => flashPanel(b.dataset.q, b.dataset.cat)));
  $('pl-q').addEventListener('input', (e) => { state.pl.q = e.target.value; drawProfileList(); });
  $('pl-type').addEventListener('change', (e) => { state.pl.type = e.target.value; drawProfileList(); });
  ['cmp-1', 'cmp-2'].forEach((id, i) => $(id).addEventListener('change', (e) => { state.compare[i] = e.target.value; update(false); }));
  document.querySelectorAll('#oc-seg button').forEach((b) => b.addEventListener('click', () => { state.ocGroup = b.dataset.g; outcomeChart(); }));
  $('curio-hours').addEventListener('toggle', () => { if ($('curio-hours').open && state.stats) hoursChart(); });
  document.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', () => state.stats && downloadCsv(b.dataset.csv)));
  Object.keys(TABLES).forEach(wireTable);
  const refind = () => { state.finderLimit = 100; if (state.stats) drawFinder(); };
  $('op-q').addEventListener('input', (e) => { state.finder.q = e.target.value; refind(); });
  $('op-type').addEventListener('change', (e) => { state.finder.type = e.target.value; refind(); });
  $('op-outcome').addEventListener('change', (e) => { state.finder.oc = e.target.value; refind(); });
  $('op-pdf').addEventListener('change', (e) => { state.finder.pdf = e.target.checked; refind(); });
  $('op-more').addEventListener('click', () => { state.finderLimit += 200; drawFinder(); });
  $('mt-view').addEventListener('change', (e) => { state.mt.view = e.target.value; state.mt.limit = 100; drawMotions(); });
  $('mt-q').addEventListener('input', (e) => { state.mt.q = e.target.value; state.mt.limit = 100; drawMotions(); });
  $('mt-more').addEventListener('click', () => { state.mt.limit += 200; drawMotions(); });
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(state.tab); const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { e.preventDefault(); show(TABS[(i + d + TABS.length) % TABS.length]); $('tab-' + state.tab).focus(); }
  });
  window.addEventListener('hashchange', () => { readHash(); update(false); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.stats && render(), 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.stats && render());
  load();
})();
