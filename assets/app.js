/* EDLA Analyzer: computes every figure in the browser from data/*.json. */
(() => {
  const fmt = { int: d3.format(','), d1: d3.format('.1f'), d2: d3.format('.2f'), pct0: d3.format('.0%') };
  fmt.med = (v) => (Number.isInteger(v) ? fmt.int(v) : fmt.d1(v));  // medians of counts can land on a half
  const utc = (s) => new Date(s + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmtDate = (s) => d3.utcFormat('%b %-d, %Y')(utc(s));
  const fmtShort = (s) => d3.utcFormat('%b %-d')(utc(s));
  const fmtMDY = (s) => s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(2, 4);
  const fmtMonth = (m) => d3.utcFormat('%B %Y')(utc(m + '-01'));
  const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
  const later = (a, b) => (a > b ? a : b);
  const median = (v) => { const s = v.slice().sort((a, b) => a - b); const m = s.length / 2; return s.length ? (s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2) : 0; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); n.append(...kids.flat().filter((k) => k != null && k !== false)); return n; };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } } };
  const plural = (n, one, many) => fmt.int(n) + ' ' + (n === 1 ? one : (many || one + 's'));

  // Each written opinion falls in exactly one ruling type, checked in this order.
  const CATS = [['r12', 'Rule 12'], ['r56', 'Rule 56'], ['trial', 'Trial and post-trial'], ['rr', 'Magistrate R&Rs'], ['other', 'Other opinions']];
  const category = (o) => (Number(o.rr) ? 'rr' : Number(o.r12) ? 'r12' : Number(o.r56) ? 'r56' : Number(o.merits) ? 'trial' : 'other');
  const zeroCats = () => Object.fromEntries(CATS.map(([k]) => [k, 0]));
  const catLabel = Object.fromEntries(CATS);
  const meritsOf = (c) => c.r12 + c.r56 + c.trial;

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
  const MCAT_LONG = { r12: 'Rule 12 (dismissal, pleadings)', r56: 'Rule 56 (summary judgment)' };

  // Outcomes of motion rulings. "unclear" means the order text was read and no outcome was found.
  const OUTCOMES = { granted: 'Granted', granted_leave: 'Granted, leave to amend', partial: 'Granted in part', denied: 'Denied', denied_wop: 'Denied without prejudice',
    mixed: 'Mixed', moot: 'Moot', other: 'Other', unclear: 'Not determined' };
  const KNOWN = ['granted', 'granted_leave', 'partial', 'denied', 'denied_wop', 'mixed', 'moot', 'other'];
  // Outcome families: rates and bars group "granted, leave to amend" with granted and "denied without prejudice" with denied.
  const FAMILY = { granted_leave: 'granted', denied_wop: 'denied' };
  const family = (v) => FAMILY[v] || v;
  const ocMatch = (o, f) => (f === 'known' ? KNOWN.includes(o.oc) : f === 'none' ? isMotion(o) && !KNOWN.includes(o.oc)
    : f === 'rest' ? ['mixed', 'moot', 'other'].includes(o.oc) : (f === 'granted' || f === 'denied') ? family(o.oc) === f : o.oc === f);
  const OC_SEGS = [['granted', 'Granted'], ['partial', 'Granted in part'], ['denied', 'Denied'], ['rest', 'Mixed, moot, or other']];
  const ocVar = (k) => '--o-' + (k === 'rest' ? 'other' : k);
  const ocColor = (v) => css(ocVar(['granted', 'partial', 'denied'].includes(family(v)) ? family(v) : 'rest'));
  const OC_SRC = { manual: 'entered by hand', docket_text: 'read from the docket text', opinion_text: 'read from the order', govinfo_text: 'read from the order (GovInfo copy)' };
  const FEW = 5;
  const GROUPS = { r12: 'Rule 12', r56: 'Rule 56', all: 'All motions' };
  const inGroup = (o, g) => isMotion(o) && (g === 'all' || Number(o[g]) === 1);
  const TYPE_OPTS = [['', 'All rulings'], ['merits', 'Merits rulings'], ['r12', 'Rule 12'], ['r56', 'Rule 56'], ['trial', 'Trial and post-trial'], ['rr', 'Magistrate R&Rs'], ['other', 'Other opinions'],
    ['|', 'Motion category'], ['motion', 'Any motion ruling'], ...MCATS.slice(2)];
  const typeLabel = Object.fromEntries(TYPE_OPTS);

  // Links go to the opinion's PDF (GovInfo or CourtListener), else its CourtListener docket entry, else a CourtListener search.
  const CL = 'https://www.courtlistener.com/';
  const CL_PDF = 'https://storage.courtlistener.com/recap/';
  const GOV_PDF = 'https://www.govinfo.gov/content/pkg/USCOURTS-laed-';
  const REPO = 'https://github.com/ggb52-wq/edla-judge-tracker';
  const linkKind = (o) => (typeof o.pdf === 'string' && (o.pdf.startsWith(CL_PDF) || o.pdf.startsWith(GOV_PDF)) ? 'pdf'
    : typeof o.url === 'string' && o.url.startsWith(CL + 'docket/') ? 'page' : 'search');
  const opinionLink = (o, kind) => (kind === 'pdf' ? o.pdf : kind === 'page' ? o.url
    : CL + '?type=r&court=laed&docket_number=' + encodeURIComponent(o.case));
  const linkTitle = { pdf: 'Open the opinion (PDF)', page: 'Open the docket entry on CourtListener', search: 'Search CourtListener for this case' };
  const recordLink = (o) => REPO + '/issues/new?template=outcome.yml&title=' + encodeURIComponent('Outcome: ' + o.case + ' doc ' + o.doc)
    + '&case=' + encodeURIComponent(o.case) + '&doc=' + encodeURIComponent(o.doc);

  const PAGES = ['judges', 'judge', 'compare', 'opinions', 'motions', 'court', 'log'];
  const NAV = { judges: 'judges', judge: 'judges', compare: 'judges', opinions: 'opinions', motions: 'motions', court: 'court', log: '' };
  const VIEWS = [['orders', 'Civil orders'], ['opinions', 'Written opinions'], ['outcomes', 'Motion outcomes'], ['weekdays', 'Weekdays'], ['hours', 'Time of day']];
  // Addresses from the earlier, tabbed layout still open the matching page.
  const LEGACY = { overview: ['judges'], orders: ['court', 'orders'], outcomes: ['court', 'outcomes'], finder: ['opinions'] };
  const emptyFinder = () => ({ q: '', judge: '', type: '', oc: '', pdf: false, month: '' });
  const state = { page: 'judges', judge: '', cmp: [], vs: [], view: 'orders', period: '', f: emptyFinder(), limit: 100,
    mt: { view: 'past', q: '', judge: '', limit: 100 }, jf: { q: '', type: '', judge: '' }, ocGroup: 'r12', hoursJudge: '', sorts: {},
    editor: false, data: null, stats: null, cases: [] };
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
      const wd = workdays(s, through).length;
      const row = { name: j.name, code: j.code, start: s, working_days: wd, total: R.length, rr: R.length - ch.length, district: ch.length,
        cases: new Set(R.map((o) => o.case)).size, days_with: ds.length, per_week: wd ? ch.length / (wd / 5) : 0, merits: mer.length,
        merits_month: wd ? mer.length / (wd / 21) : 0, r12: mer.filter((o) => Number(o.r12)).length, r56: mer.filter((o) => Number(o.r56)).length, mix,
        last: ds.length ? ds[ds.length - 1] : '', pdf: R.filter((o) => linkKind(o) === 'pdf').length };
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
    // Outcomes pooled across every judge, for the "all judges" comparison bars.
    const pool = (get) => { const T = opinions.map(get); const out = {}; ['n', 'known', 'granted', 'partial', 'denied', 'rest', 'nDays'].forEach((k) => { out[k] = d3.sum(T, (t) => t[k]); }); return out; };
    const pooled = { motions: pool((r) => r.motions), ...Object.fromEntries(MCATS.map(([k]) => [k, pool((r) => r.cats[k])])) };
    Object.keys(GROUPS).forEach((g) => { pooled['g_' + g] = pool((r) => ({ n: r[g + '_n'], known: r[g + '_known'], granted: r[g + '_granted'], partial: r[g + '_partial'], denied: r[g + '_denied'], rest: r[g + '_rest'], nDays: 0 })); });

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
    const dowAll = [0, 0, 0, 0, 0, 0, 0];
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
      R.forEach((o) => { const w = utc(o.date).getUTCDay(); dow[w] += 1; dowAll[w] += 1; });
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
    const dowTotal = d3.sum(dowAll);
    const dowCourt = Object.fromEntries([['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5]].map(([k, w]) => [k, dowTotal ? dowAll[w] / dowTotal : 0]));

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
      const M = motions.filter((m) => (m.judge || '') === j.code);
      const P = M.filter((m) => m.past);
      return { ...j, seen: M.length, dated: M.filter((m) => m.submit).length, awaiting: M.filter((m) => !m.ruled).length, past: P.length,
        med_past: P.length ? median(P.map((m) => m.daysPast)) : 0, ruled: M.filter((m) => m.ruled).length };
    }).filter((j) => j.code || j.seen);
    const sum = (rows, k) => d3.sum(rows, (r) => r[k]);
    const medOf = (vals, min = 1) => { const v = vals.filter((x) => x != null); return v.length >= min ? median(v) : null; };
    return {
      through, names, opinions, orders, weekly, recent, monthly, hours, pooled, dowCourt, since: { orders: orStart, opinions: opStart }, workingDays: allDays.length,
      motions, motionsSince, motionsByJudge: byJudge,
      totals: {
        orders: sum(orders, 'orders'), perDay: allDays.length ? sum(orders, 'orders') / allDays.length : 0,
        opinions: sum(opinions, 'total'), merits: sum(opinions, 'merits'), motions: sum(opinions, 'all_n'), known: sum(opinions, 'all_known'),
        pdf: sum(opinions, 'pdf'),
        medPerDay: median(orders.map((r) => r.per_day)), medMerits: median(opinions.map((r) => r.merits_month)),
        medPerWeek: median(opinions.map((r) => r.per_week)), medOrders: median(orders.map((r) => r.orders)), medTotal: median(opinions.map((r) => r.total)),
        medDays: medOf(opinions.map((r) => (r.motions.nDays >= FEW ? r.motions.medDays : null)), 3),
        medWrittenShare: median(orders.map((r) => r.written_share)),
        medPages: medOf(opinions.map((r) => (r.n_pages >= FEW ? r.med_pages : null)), 3),
      },
    };
  }

  // Every case seen in the data, for looking up a case number: its name, its judge, and its latest docket date.
  function buildCases(D) {
    const names = Object.fromEntries(D.judges.map((j) => [j.code, j.name]));
    const m = new Map();
    const add = (r, kind) => {
      if (!r.case) return;
      let c = m.get(r.case); if (!c) { c = { case: r.case, title: '', judge: '', last: '', opinions: 0, orders: 0 }; m.set(r.case, c); }
      if (r.title && !c.title) c.title = r.title;
      if (names[r.judge] && (r.date >= c.last || !c.judge)) c.judge = r.judge;
      if (r.date > c.last) c.last = r.date;
      if (kind === 'op') c.opinions += 1; else if (kind === 'or') c.orders += 1;
    };
    D.orders.forEach((r) => add(r, 'or')); D.opinions.forEach((r) => add(r, 'op')); (D.motions || []).forEach((r) => add(r, 'mo'));
    return [...m.values()].map((c) => { const p = c.case.match(/:(\d{2})-[a-z]+-0*(\d+)/i); return { ...c, yy: p ? p[1] : '', num: p ? p[2] : '', lt: (c.case + ' ' + c.title).toLowerCase() }; });
  }

  // ------------------------------------------------------------ addresses
  // #judges · #judge/BSL · #compare/BSL,EEF · #opinions?judge=BSL&type=r12&oc=granted&q=... · #motions · #court/outcomes · #log
  // Any of them can carry period=30 or period=90. #overview?judge=BSL and #judge=Africk from the earlier layout still work.
  const judgeCode = (v) => { if (!state.data || !v) return ''; const s = String(v).toLowerCase().replace(/[-_]/g, ' '); const j = state.data.judges.find((x) => x.code.toLowerCase() === s || x.name.toLowerCase() === s); return j ? j.code : ''; };
  function readHash() {
    let raw = location.hash.slice(1);
    if (raw && !raw.includes('?') && raw.includes('=')) raw = '?' + raw;
    const [path, query] = raw.split('?');
    const p = new URLSearchParams(query || '');
    let parts = decodeURIComponent(path || '').split('/').filter(Boolean);
    if (LEGACY[parts[0]]) parts = LEGACY[parts[0]].concat(parts.slice(1));
    let page = PAGES.includes(parts[0]) ? parts[0] : 'judges';
    if (page === 'judges' && p.get('judge')) { page = 'judge'; parts = ['judge', p.get('judge')]; }
    if (p.has('vs')) state.vs = p.get('vs').split(',').map(judgeCode).filter(Boolean).slice(0, 3);
    if (p.has('period')) state.period = ['30', '90'].includes(p.get('period')) ? p.get('period') : '';
    state.page = page;
    if (page === 'judge') state.judge = judgeCode(parts[1] || p.get('judge'));
    if (page === 'compare') state.cmp = [...new Set((parts[1] || '').split(',').map(judgeCode).filter(Boolean))].slice(0, 4);
    if (page === 'court') state.view = VIEWS.some(([k]) => k === parts[1]) ? parts[1] : 'orders';
    if (page === 'opinions') {
      const f = emptyFinder(); f.q = p.get('q') || ''; f.judge = judgeCode(p.get('judge')); f.type = typeLabel[p.get('type')] && p.get('type') !== '|' ? p.get('type') : '';
      f.oc = p.get('oc') || ''; f.pdf = p.get('pdf') === '1'; f.month = /^\d{4}-\d{2}$/.test(p.get('month') || '') ? p.get('month') : '';
      state.f = f;
    }
    if (page === 'motions') { state.mt.judge = judgeCode(p.get('judge')); state.mt.view = ['past', 'pending', 'all'].includes(p.get('view')) ? p.get('view') : 'past'; }
  }
  function hashFor(page, o = {}) {
    const p = new URLSearchParams(); let path = page;
    if (page === 'judge') path += '/' + o.judge;
    if (page === 'compare' && o.cmp && o.cmp.length) path += '/' + o.cmp.join(',');
    if (page === 'court') path += '/' + (o.view || 'orders');
    if (page === 'opinions' && o.f) { const f = o.f; if (f.q) p.set('q', f.q); if (f.judge) p.set('judge', f.judge); if (f.type) p.set('type', f.type); if (f.oc) p.set('oc', f.oc); if (f.pdf) p.set('pdf', '1'); if (f.month) p.set('month', f.month); }
    if (page === 'motions' && o.mt) { if (o.mt.judge) p.set('judge', o.mt.judge); if (o.mt.view && o.mt.view !== 'past') p.set('view', o.mt.view); }
    if (state.period) p.set('period', state.period);
    return '#' + path + (p.toString() ? '?' + p : '');
  }
  const currentHash = () => hashFor(state.page, { judge: state.judge, cmp: state.cmp, view: state.view, f: state.f, mt: state.mt });
  const judgeHref = (code) => hashFor('judge', { judge: code });
  const findHref = (preset) => hashFor('opinions', { f: { ...emptyFinder(), ...preset } });
  function writeHash() { const h = currentHash(); if (location.hash !== h) history.replaceState(null, '', h); }
  const judgesAlpha = () => state.data.judges.slice().sort((a, b) => a.name.localeCompare(b.name));

  // ------------------------------------------------------------ tooltip: one floating box for charts and [data-tip] elements
  const tipEl = $('tip'); let tipFrom = '';
  function tipShow(lines, x, y, from) {
    tipEl.replaceChildren(...lines.map((l, i) => {
      if (l && typeof l === 'object') { const k = el('i'); k.style.background = l.color; return el('div', { className: 'row' }, k, el('b', { textContent: l.value }), el('span', { textContent: l.label })); }
      return el('div', { className: i === 0 ? 'tk' : /^(Click|Open)/.test(l) ? 'th' : '', textContent: l });
    }));
    tipEl.hidden = false; tipFrom = from || 'chart';
    const r = tipEl.getBoundingClientRect();
    let L = x + 14; let T = y + 16;
    if (L + r.width > innerWidth - 8) L = Math.max(8, x - r.width - 14);
    if (T + r.height > innerHeight - 8) T = Math.max(8, y - r.height - 12);
    tipEl.style.left = L + 'px'; tipEl.style.top = T + 'px';
  }
  function tipHide() { tipEl.hidden = true; tipFrom = ''; }
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) tipShow(t.dataset.tip.split('\n'), e.clientX, e.clientY, 'attr'); else if (tipFrom === 'attr') tipHide();
  });
  document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) { const r = t.getBoundingClientRect(); tipShow(t.dataset.tip.split('\n'), r.left, r.bottom, 'attr'); } });
  document.addEventListener('focusout', () => { if (tipFrom === 'attr') tipHide(); });
  document.addEventListener('scroll', tipHide, { passive: true });

  // ------------------------------------------------------------ small components
  const pctOf = (n, d) => (d ? fmt.pct0(n / d) : '—');
  // Readable label ink for a fill color.
  const inkOn = (c) => { const l = d3.lab(c).l; return l > 62 ? '#0a0d12' : '#ffffff'; };

  // A 100% bar of coded outcomes. opts: { href(k) for links, labels: true to print shares inside wide segments, thin, few }
  function ocBar(t, opts = {}) {
    if (!t || !t.known) return el('div', { className: 'ocbar empty' + (opts.thin ? ' thin' : ''), textContent: opts.thin ? '' : (t && t.n ? 'outcomes not coded yet' : 'no rulings') });
    const few = !opts.thin && t.known < FEW;
    const bar = el('div', { className: 'ocbar' + (opts.thin ? ' thin' : '') + (few ? ' few' : '') });
    const who = opts.who ? opts.who + ': ' : '';
    OC_SEGS.forEach(([k, label]) => {
      const v = t[k]; if (!v) return;
      const share = v / t.known;
      const detail = k === 'granted' && t.grantedLeave ? `, ${fmt.int(t.grantedLeave)} with leave to amend` : k === 'denied' && t.deniedWop ? `, ${fmt.int(t.deniedWop)} without prejudice` : k === 'rest' && t.moot ? `, ${fmt.int(t.moot)} moot` : '';
      const tip = [who + label + ' ' + fmt.pct0(share), `${fmt.int(v)} of ${plural(t.known, 'coded ruling')}${detail}`].concat(few ? ['Fewer than ' + FEW + ' coded rulings'] : [], opts.href ? ['Click to list these opinions'] : []).join('\n');
      const seg = opts.href ? el('a', { href: opts.href(k) }) : el('span');
      seg.className = 'seg-' + k; seg.style.width = `calc(${share * 100}% - ${2 * (1 - share)}px)`; seg.dataset.tip = tip;
      if (opts.labels && !few && share >= 0.17) { seg.textContent = fmt.pct0(share); seg.style.color = inkOn(css(ocVar(k))); }
      if (opts.href) seg.setAttribute('aria-label', label + ' ' + fmt.pct0(share) + ', ' + fmt.int(v) + ' of ' + fmt.int(t.known));
      bar.append(seg);
    });
    return bar;
  }
  // Where one judge's figure falls among all judges: a tick per judge, the median, and this judge as a dot.
  function strip(values, mine, format, label) {
    const v = values.filter((x) => x != null && Number.isFinite(x));
    if (v.length < 3 || mine == null) return null;
    const hi = d3.max(v) || 1; const pos = (x) => (x / hi) * 100;
    const med = median(v);
    const box = el('div', { className: 'strip' });
    box.dataset.tip = [label, 'This judge ' + format(mine) + ' · median judge ' + format(med), 'All ' + v.length + ' judges: ' + format(d3.min(v)) + ' to ' + format(hi)].join('\n');
    box.append(el('span', { className: 'base' }), ...v.map((x) => { const i = el('i'); i.style.left = pos(x) + '%'; return i; }));
    const m = el('b'); m.style.left = pos(med) + '%'; const me = el('em'); me.style.left = pos(mine) + '%';
    box.append(m, me);
    return box;
  }
  // A headline figure: label, value, a line of context, and optionally the position strip.
  function kpi({ label, value, unit, sub, na, stripEl, href, tip }) {
    const node = el(href ? 'a' : 'div', { className: 'kpi' + (na ? ' na' : '') });
    if (href) node.href = href;
    if (tip) node.title = tip;
    node.append(el('span', { className: 'l', textContent: label }), el('span', { className: 'v' }, value, unit ? el('small', { textContent: unit }) : null));
    if (sub) node.append(el('span', { className: 's' }, sub));
    if (stripEl) node.append(stripEl);
    return node;
  }
  const fact = (k, v, sub) => el('div', { className: 'fact' }, el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: sub }));
  function caseLink(o) {
    const kind = linkKind(o);
    const a = el('a', { className: 'case', href: opinionLink(o, kind), target: '_blank', rel: 'noopener noreferrer', textContent: o.case + ' · ' + o.doc, title: linkTitle[kind] });
    return kind === 'pdf' ? [a, el('span', { className: 'tag', textContent: 'PDF' })] : [a];
  }
  function outcomePill(o) {
    if (!o.oc) return isMotion(o) ? el('span', { className: 'pill none', textContent: 'Not coded', title: 'No outcome on file yet' }) : null;
    const i = el('i'); i.style.background = o.oc === 'unclear' ? 'transparent' : ocColor(o.oc);
    if (o.oc === 'unclear') i.style.boxShadow = 'inset 0 0 0 1px ' + css('--ink-3');
    return el('span', { className: 'pill', title: 'Outcome ' + (OC_SRC[o.ocSrc] || 'on file') }, i, OUTCOMES[o.oc] || o.oc, o.ocSrc === 'manual' ? el('small', { textContent: 'hand' }) : null);
  }
  const numLink = (text, href, title) => el('a', { className: 'n', href, textContent: text, title: title || 'List these opinions' });
  const legendItem = (color, label, kind) => { const i = el('i', { className: kind || '' }); i.style.background = color; return el('span', {}, i, label); };
  function fillTypeSelect(sel) {
    if (sel.options.length) return;
    let group = null;
    TYPE_OPTS.forEach(([k, label]) => { if (k === '|') { group = el('optgroup', { label }); sel.append(group); } else (group || sel).append(new Option(label, k)); });
  }

  // Filters used by the opinion search and the judge page's list. type: a ruling type, "merits", "motion", or a motion category.
  const typeMatch = (o, type) => !type || (type === 'merits' ? Number(o.merits) && !Number(o.rr) : type === 'motion' ? isMotion(o) : mcatLabel[type] ? o.mcat === type : o.cat === type);
  const textMatch = (o, q) => !q || (o.case + ' ' + o.title + ' ' + o.event).toLowerCase().includes(q);

  // ------------------------------------------------------------ charts
  function frame(box, H, label) {
    const W = Math.max(220, Math.floor(box.clientWidth || 300));
    const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', W).attr('height', H).attr('role', 'img').attr('aria-label', label);
    box.replaceChildren(svg.node());
    return { svg, W };
  }
  // Chart colors are CSS variables set as styles, so a theme switch or the print sheet restyles a drawn chart.
  const axisStyle = (g) => g.attr('font-size', null).attr('font-family', null)
    .call((a) => a.select('.domain').remove()).call((a) => a.selectAll('line').attr('stroke', null).style('stroke', 'var(--line)'));
  const emptyChart = (box, H, text) => { const { svg, W } = frame(box, H, text); svg.append('text').attr('class', 'empty').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text(text); };

  // Lines over weeks; a crosshair snaps to the nearest week and lists every series.
  function lineChart(box, { rows, series, fmtY, H = 168, label, href }) {
    if (rows.length < 2) { emptyChart(box, H, 'Not enough weeks in this period'); return; }
    const m = { t: 8, r: 12, b: 22, l: 30 };
    const { svg, W } = frame(box, H, label);
    const x = d3.scaleUtc(d3.extent(rows, (r) => r.dt), [m.l, W - m.r]);
    const y = d3.scaleLinear([0, (d3.max(rows, (r) => d3.max(series, (s) => s.get(r))) || 1) * 1.08], [H - m.b, m.t]).nice(4);
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.min(rows.length, Math.floor(W / 80)))).tickFormat(d3.utcFormat('%b %-d')).tickSize(0).tickPadding(8)).call(axisStyle);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickPadding(6).tickFormat(d3.format('~g'))).call(axisStyle);
    const last = rows[rows.length - 1];
    series.slice().reverse().forEach((s) => {
      svg.append('path').datum(rows).attr('fill', 'none').style('stroke', s.color).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round')
        .attr('d', d3.line().x((r) => x(r.dt)).y((r) => y(s.get(r))));
      svg.append('circle').attr('cx', x(last.dt)).attr('cy', y(s.get(last))).attr('r', 4).style('fill', s.color).style('stroke', 'var(--panel)').attr('stroke-width', 2);
    });
    const rule = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--ink-3)').attr('stroke-width', 1).attr('opacity', 0);
    const hit = svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H - m.b).attr('fill', 'transparent')
      .on('pointermove', (e) => {
        const t = x.invert(d3.pointer(e)[0]);
        const r = rows.reduce((best, q) => (Math.abs(q.dt - t) < Math.abs(best.dt - t) ? q : best), rows[0]);
        rule.attr('x1', x(r.dt)).attr('x2', x(r.dt)).attr('opacity', 1);
        tipShow(['Week of ' + d3.utcFormat('%b %-d')(r.dt), ...series.map((s) => ({ color: s.color, value: fmtY(s.get(r)), label: s.label }))].concat(href ? ['Click to open the court view'] : []), e.clientX, e.clientY);
      })
      .on('pointerleave', () => { rule.attr('opacity', 0); tipHide(); });
    if (href) hit.style('cursor', 'pointer').on('click', () => { location.hash = href; });
  }

  // Stacked columns by month. keys: [{k, label, color}]; get(row, k) gives a count; href(row, k) opens those opinions.
  function monthColumns(box, { rows, keys, get, H = 168, label, href }) {
    if (!rows.length) { emptyChart(box, H, 'No months in this period'); return; }
    const m = { t: 8, r: 4, b: 22, l: 30 };
    const { svg, W } = frame(box, H, label);
    const x = d3.scaleBand(rows.map((r) => r.month), [m.l, W - m.r]).paddingInner(0.3).paddingOuter(0.1);
    const total = (r) => d3.sum(keys, (k) => get(r, k.k));
    const y = d3.scaleLinear([0, d3.max(rows, total) || 1], [H - m.b, m.t]).nice(4);
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(W / 46)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(rows.map((r) => r.month).filter((_, i) => i % every === 0)).tickSize(0).tickPadding(8).tickFormat((k) => d3.utcFormat(k.endsWith('-01') ? '%b ’%y' : '%b')(utc(k + '-01')))).call(axisStyle);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickPadding(6).tickFormat(d3.format('~s'))).call(axisStyle);
    const bw = Math.min(24, x.bandwidth());
    rows.forEach((r) => {
      const x0 = x(r.month) + (x.bandwidth() - bw) / 2; let acc = 0;
      keys.forEach((k, i) => {
        const v = get(r, k.k); if (!v) return;
        const top = y(acc + v); const h = y(acc) - top - (acc > 0 ? 2 : 0);
        if (h > 0) svg.append('rect').attr('x', x0).attr('y', top).attr('width', bw).attr('height', h).attr('rx', i === keys.length - 1 || acc + v === total(r) ? 2 : 0).style('fill', k.color);
        acc += v;
      });
      const hitRect = svg.append('rect').attr('x', x(r.month) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
        .on('pointermove', (e) => tipShow([fmtMonth(r.month) + ': ' + plural(total(r), 'opinion'), ...keys.map((k) => ({ color: k.color, value: fmt.int(get(r, k.k)), label: k.label }))].concat(href ? ['Click to list these opinions'] : []), e.clientX, e.clientY))
        .on('pointerleave', tipHide);
      if (href) hitRect.style('cursor', 'pointer').on('click', () => { location.hash = href(r); });
    });
  }

  // Columns side by side for each category (weekday or hour). series: [{label, color, values}] aligned with cats.
  function groupedColumns(box, { cats, catLabel: lab, series, fmtY, H = 168, label, tipTitle }) {
    const m = { t: 8, r: 4, b: 22, l: 34 };
    const { svg, W } = frame(box, H, label);
    const x = d3.scaleBand(cats, [m.l, W - m.r]).paddingInner(0.28).paddingOuter(0.1);
    const xi = d3.scaleBand(series.map((s) => s.label), [0, x.bandwidth()]).padding(0.12);
    const y = d3.scaleLinear([0, d3.max(series, (s) => d3.max(s.values)) || 1], [H - m.b, m.t]).nice(4);
    const every = Math.ceil(cats.length / Math.max(2, Math.floor(W / 44)));
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(cats.filter((_, i) => i % every === 0)).tickFormat(lab).tickSize(0).tickPadding(8)).call(axisStyle);
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickPadding(6).tickFormat(fmtY)).call(axisStyle);
    const bw = Math.min(24, xi.bandwidth());
    cats.forEach((c, ci) => {
      series.forEach((s) => {
        const v = s.values[ci]; const h = y(0) - y(v); if (h <= 0) return;
        const x0 = x(c) + xi(s.label) + (xi.bandwidth() - bw) / 2;
        svg.append('path').style('fill', s.color).attr('d', `M${x0},${y(0)}V${y(v) + Math.min(2, h)}q0,-2 2,-2H${x0 + bw - 2}q2,0 2,2V${y(0)}Z`);
      });
      svg.append('rect').attr('x', x(c) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
        .on('pointermove', (e) => tipShow([tipTitle(c), ...series.map((s) => ({ color: s.color, value: fmtY(s.values[ci]) + (s.counts ? ' (' + fmt.int(s.counts[ci]) + ')' : ''), label: s.label }))], e.clientX, e.clientY))
        .on('pointerleave', tipHide);
    });
  }

  function sparkline(values, w = 84, h = 18) {
    const svg = d3.create('svg').attr('width', w).attr('height', h).attr('aria-hidden', 'true').style('display', 'block').style('margin-left', 'auto');
    if (values.length < 2) return svg.node();
    const x = d3.scaleLinear([0, values.length - 1], [2, w - 4]);
    const y = d3.scaleLinear([0, d3.max(values) || 1], [h - 3, 3]);
    svg.append('path').attr('fill', 'none').style('stroke', 'var(--judge)').attr('stroke-width', 1.5).attr('stroke-linejoin', 'round').attr('d', d3.line().x((_, i) => x(i)).y((v) => y(v))(values));
    svg.append('circle').attr('cx', x(values.length - 1)).attr('cy', y(values[values.length - 1])).attr('r', 2.5).style('fill', 'var(--judge)');
    return svg.node();
  }

  // ------------------------------------------------------------ sortable judge tables (court page, motions by judge)
  // cols: { k, label, title, f, num, bar, sum, href(row) for a link on the value, render(row) for a custom cell, gstart }
  const TABLES = {};
  function drawTable(id) {
    const cfg = TABLES[id]; const all = cfg.rows();
    const s = state.sorts[id] || (state.sorts[id] = { ...cfg.sort });
    const cols = cfg.cols.filter((c) => !(c.hide && c.hide(all)));
    const val = (r, c) => (c.sortVal ? c.sortVal(r) : r[c.k]);
    const sortCol = cols.find((c) => c.k === s.k) || cols[0];
    const rows = all.slice().sort((a, b) => { const x = val(a, sortCol); const y = val(b, sortCol); return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * s.dir || a.name.localeCompare(b.name); });
    const max = Object.fromEntries(cols.filter((c) => c.bar).map((c) => [c.k, d3.max(all, (r) => r[c.k]) || 1]));
    const head = el('thead');
    if (cols.some((c) => c.group)) {
      const tr = el('tr', { className: 'group' }); let i = 0;
      while (i < cols.length) { const g = cols[i].group || ''; let n = 0; while (i + n < cols.length && (cols[i + n].group || '') === g) n += 1; tr.append(el('th', { colSpan: n, textContent: g, className: g ? 'gstart' : '' })); i += n; }
      head.append(tr);
    }
    head.append(el('tr', {}, ...cols.map((c) => {
      const th = el('th', { className: (c.gstart ? 'gstart ' : '') + (c.r || c.num || (c.f && !c.render) ? 'r' : '') }); if (c.title) th.title = c.title;
      if (c.nosort) { th.append(el('span', { textContent: c.label })); return th; }
      th.dataset.k = c.k; th.setAttribute('aria-sort', c.k === s.k ? (s.dir > 0 ? 'ascending' : 'descending') : 'none');
      th.append(el('button', { type: 'button', textContent: c.label }));
      return th;
    })));
    const body = el('tbody', {}, ...rows.map((r) => {
      const tr = el('tr'); if (r.code) { tr.className = 'go'; tr.dataset.href = judgeHref(r.code); }
      cols.forEach((c, ci) => {
        const td = el('td', { className: (c.gstart ? 'gstart ' : '') + (c.num ? 'num' : c.cls || '') });
        if (ci === 0) td.append(r.code ? el('a', { className: 'judge', href: judgeHref(r.code), textContent: r.name }) : el('span', { className: 'dim', textContent: r.name }));
        else if (c.render) td.append(c.render(r));
        else {
          const text = c.f ? c.f(r[c.k]) : String(r[c.k]);
          const node = c.href && r[c.k] > 0 ? numLink(text, c.href(r)) : document.createTextNode(text);
          if (c.bar) { const tr2 = el('span', { className: 'tr' }, el('i')); tr2.firstChild.style.width = Math.max(0, Math.min(100, (r[c.k] / max[c.k]) * 100)) + '%'; td.append(el('span', { className: 'nb' }, node, tr2)); } else td.append(node);
        }
        tr.append(td);
      });
      return tr;
    }));
    const foot = el('tfoot');
    (cfg.foot || []).forEach(([label, f]) => foot.append(el('tr', {}, ...cols.map((c, i) => { const td = el('td', { className: (c.gstart ? 'gstart ' : '') + (c.num ? 'num' : '') }); const v = i === 0 ? label : f(c, all); if (v instanceof Node) td.append(v); else td.textContent = v == null ? '' : v; return td; }))));
    $(id).replaceChildren(head, body, foot);
  }
  function wireTable(id) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('th button');
      if (b) { const k = b.parentElement.dataset.k; const s = state.sorts[id]; s.dir = s.k === k ? -s.dir : (k === 'name' ? 1 : -1); s.k = k; drawTable(id); return; }
      const tr = e.target.closest('tbody tr.go');
      if (tr && !e.target.closest('a,button')) location.hash = tr.dataset.href;
    });
  }
  const sumFoot = ['All judges', (c, all) => (c.sum ? c.f(d3.sum(all, (r) => r[c.k])) : '')];
  const medFoot = ['Median judge', (c, all) => (c.med === false || !c.f || c.render ? '' : c.f(median(all.map((r) => r[c.k]))))];

  // ------------------------------------------------------------ page: judges (home)
  function renderJudges() {
    const S = state.stats; const T = S.totals;
    document.title = 'EDLA Analyzer · Judges of the Eastern District of Louisiana';
    $('court-kpis').replaceChildren(
      kpi({ label: 'Written opinions', value: fmt.int(T.opinions), sub: 'since ' + fmtDate(S.since.opinions) + ' · ' + fmt.int(T.pdf) + ' with a PDF', href: findHref({}) }),
      kpi({ label: 'Merits rulings', value: fmt.int(T.merits), sub: 'Rule 12, Rule 56, and trial rulings', href: findHref({ type: 'merits' }) }),
      kpi({ label: 'Motion outcomes coded', value: fmt.int(T.known), unit: 'of ' + fmt.int(T.motions), sub: 'motion rulings, read from the docket or the order', href: hashFor('court', { view: 'outcomes' }) }),
      kpi({ label: 'Civil orders', value: fmt.int(T.orders), sub: fmt.d1(T.perDay) + ' per working day since ' + fmtShort(S.since.orders), href: hashFor('court', { view: 'orders' }) }),
      kpi({ label: 'Data through', value: fmtShort(S.through), sub: lastRunText(), href: '#log' }),
    );
    const recent = recentJudges().filter((c) => S.names[c]);
    $('recent').hidden = !recent.length;
    $('recent').replaceChildren(...(recent.length ? [el('span', { textContent: 'Recently viewed' }), ...recent.map((c) => el('a', { href: judgeHref(c), textContent: S.names[c] }))] : []));
    $('cards').replaceChildren(...judgesAlpha().map((j) => {
      const op = S.opinions.find((r) => r.code === j.code); const or = S.orders.find((r) => r.code === j.code);
      const stat = (label, v, tip) => el('div', { title: tip }, el('span', { textContent: label }), el('b', { textContent: v }));
      return el('a', { className: 'jcard', href: judgeHref(j.code) },
        el('div', { className: 'jc-head' }, el('span', { className: 'jc-name', textContent: j.name }), el('span', { className: 'code', textContent: j.code })),
        el('div', { className: 'jc-stats' },
          stat('Opinions', fmt.int(op.total), 'Written opinions in the period'),
          stat('Merits / mo', fmt.d1(op.merits_month), 'Rule 12, Rule 56, and trial rulings per 21 working days'),
          stat('Orders / day', fmt.d1(or.per_day), 'Civil orders per working day since ' + fmtShort(or.start))),
        el('div', { className: 'jc-oc' }, el('span', { className: 'l', textContent: 'Motion outcomes, coded' }), ocBar(op.motions, { who: j.name }), el('span', { className: 'n', textContent: 'n=' + fmt.int(op.motions.known) })),
        el('div', { className: 'jc-foot' }, el('span', { textContent: op.last ? 'Latest opinion ' + fmtShort(op.last) : 'No opinions in period' }), el('span', { textContent: fmt.int(op.cats.r12.n) + ' Rule 12 · ' + fmt.int(op.cats.r56.n) + ' Rule 56' })));
    }));
  }
  const recentJudges = () => { try { return JSON.parse(store.get('edla-recent') || '[]'); } catch (e) { return []; } };
  const rememberJudge = (code) => store.set('edla-recent', JSON.stringify([code, ...recentJudges().filter((c) => c !== code)].slice(0, 5)));
  function lastRunText() {
    const runs = state.data.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const at = runs.length ? String(runs[0].at) : '';
    return at ? 'updated ' + fmtShort(at.slice(0, 10)) + ', ' + at.slice(11, 16) + ' Central' : '';
  }

  // ------------------------------------------------------------ page: one judge
  function renderJudge() {
    const S = state.stats; const T = S.totals; const code = state.judge;
    const name = S.names[code];
    const or = S.orders.find((r) => r.code === code); const op = S.opinions.find((r) => r.code === code);
    if (state.jf.judge !== code) state.jf = { q: '', type: '', judge: code };
    rememberJudge(code);
    document.title = 'Judge ' + name + ' · EDLA Analyzer';
    $('j-name').textContent = 'Judge ' + name; $('j-crumb').textContent = name; $('j-code').textContent = code;
    $('j-meta').textContent = (state.period ? 'Last ' + state.period + ' days. ' : '') + 'Written opinions counted from ' + fmtDate(op.start) + '; civil orders from ' + fmtDate(or.start) + '. Data through ' + fmtDate(S.through) + '.';
    const list = judgesAlpha(); const i = list.findIndex((j) => j.code === code);
    $('j-prev').href = judgeHref(list[(i - 1 + list.length) % list.length].code); $('j-next').href = judgeHref(list[(i + 1) % list.length].code);
    const pick = $('j-pick'); if (!pick.options.length) pick.append(...list.map((j) => new Option('Judge ' + j.name, j.code))); pick.value = code;
    $('j-compare').href = hashFor('compare', { cmp: [code, ...state.vs.filter((c) => c !== code)] });

    // Headline figures, each with where the judge falls among all 16.
    const vals = (rows, f) => rows.map(f);
    const days = op.motions;
    const daysVals = S.opinions.map((r) => (r.motions.nDays >= FEW ? r.motions.medDays : null));
    const pageVals = S.opinions.map((r) => (r.n_pages >= FEW ? r.med_pages : null));
    $('j-kpis').replaceChildren(
      kpi({ label: 'Written opinions', value: fmt.int(op.total), sub: [el('b', { textContent: fmt.d2(op.per_week) }), ' a week · median judge ' + fmt.d2(T.medPerWeek)], href: findHref({ judge: code }),
        stripEl: strip(vals(S.opinions, (r) => r.per_week), op.per_week, fmt.d2, 'Written opinions per week, excluding magistrate R&Rs') }),
      kpi({ label: 'Merits rulings', value: fmt.int(op.merits), sub: [el('b', { textContent: fmt.d2(op.merits_month) }), ' a month · median judge ' + fmt.d2(T.medMerits)], href: findHref({ judge: code, type: 'merits' }),
        stripEl: strip(vals(S.opinions, (r) => r.merits_month), op.merits_month, fmt.d2, 'Rule 12, Rule 56, and trial rulings per 21 working days') }),
      kpi({ label: 'Orders per working day', value: fmt.d1(or.per_day), sub: fmt.int(or.orders) + ' civil orders · median judge ' + fmt.d1(T.medPerDay), href: hashFor('court', { view: 'orders' }),
        stripEl: strip(vals(S.orders, (r) => r.per_day), or.per_day, fmt.d1, 'Civil orders per working day') }),
      kpi({ label: 'Orders flagged as opinions', value: fmt.pct0(or.written_share), sub: 'of civil orders · median judge ' + fmt.pct0(T.medWrittenShare),
        stripEl: strip(vals(S.orders, (r) => r.written_share), or.written_share, fmt.pct0, 'Share of civil orders flagged for the Written Opinions Report') }),
      days.nDays < FEW
        ? kpi({ label: 'Median days to ruling', value: 'Not yet', na: true, sub: days.nDays ? `${fmt.int(days.nDays)} of ${plural(days.n, 'ruling')} dated so far; a median needs ${FEW}` : 'filing dates are still being collected' })
        : kpi({ label: 'Median days to ruling', value: fmt.med(days.medDays), unit: 'days', sub: 'from ' + plural(days.nDays, 'ruling') + (T.medDays == null ? '' : ' · median judge ' + fmt.med(T.medDays)),
          stripEl: strip(daysVals, days.medDays, fmt.med, 'Median calendar days from a motion\'s filing to the opinion deciding it') }),
      op.n_pages >= FEW
        ? kpi({ label: 'Median opinion length', value: fmt.med(op.med_pages), unit: 'pages', sub: 'from ' + plural(op.n_pages, 'PDF') + (T.medPages ? ' · median judge ' + fmt.med(T.medPages) : ''),
          stripEl: strip(pageVals, op.med_pages, fmt.med, 'Median pages per written opinion with a PDF on file') })
        : kpi({ label: 'Median opinion length', value: 'Not yet', na: true, sub: op.n_pages ? `${plural(op.n_pages, 'PDF')} measured so far; a median needs ${FEW}` : 'page counts are still being collected' }),
    );

    drawJudgeOutcomes(op, name);
    drawJudgeActivity(or, op, name);
    drawJudgeHabits(or, op, name);
    drawJudgeMotions(code);
    drawFeed();
  }

  function drawJudgeOutcomes(op, name) {
    const S = state.stats; const code = op.code;
    $('j-oc-cap').textContent = `How Judge ${name}'s motion rulings came out, by type of motion. Shares count only rulings whose outcome has been coded; "granted" means the motion was granted, whoever filed it. The thin bar under each is all 16 judges combined. Outlined bars rest on fewer than ${FEW} coded rulings, too few to read much into. Click a segment or a count to see the opinions.`;
    const shown = MCATS.filter(([k]) => op.cats[k].n);
    const hasDays = shown.some(([k]) => op.cats[k].nDays);
    const cols = ['Motion type', 'Rulings', 'Coded', 'Outcomes', 'Granted', 'All judges'].concat(hasDays ? ['Median days to ruling'] : []);
    const head = el('thead', {}, el('tr', {}, ...cols.map((c, i) => {
      const th = el('th', { textContent: c, className: i === 0 || i === 3 ? '' : 'r' });
      if (c === 'Coded') th.title = 'Rulings whose outcome has been read from the docket text or the order';
      if (c === 'Granted') th.title = 'Share of coded rulings granted in full (with or without leave to amend)';
      if (c === 'All judges') th.title = 'The same share for all 16 judges combined';
      if (c === 'Median days to ruling') th.title = 'Calendar days from the motion\'s docket date to the ruling; n is how many rulings have a filing date';
      return th;
    })));
    const line = (label, t, pool, type, total) => {
      const preset = { judge: code, type };
      const few = t.known && t.known < FEW;
      const tr = el('tr', { className: total ? 'total' : '' });
      tr.append(el('td', { className: 'txt', textContent: label, title: MCAT_LONG[type] || '' }),
        el('td', { className: 'num' }, t.n ? numLink(fmt.int(t.n), findHref(preset)) : '0'),
        el('td', { className: 'num' + (t.known ? '' : ' dim') }, t.known ? numLink(fmt.int(t.known), findHref({ ...preset, oc: 'known' }), 'List the coded rulings') : '0'));
      const cell = el('td', { className: 'ocwrap' }, ocBar(t, { labels: true, who: 'Judge ' + name, href: (k) => findHref({ ...preset, oc: k }) }), ocBar(pool, { thin: true, who: 'All judges' }));
      tr.append(cell,
        el('td', { className: 'num' + (few || !t.known ? ' dim' : '') }, t.known ? fmt.pct0(t.granted / t.known) : '—'),
        el('td', { className: 'num dim allj' }, pool.known ? fmt.pct0(pool.granted / pool.known) : '—'));
      tr.children[1].dataset.l = 'rulings'; tr.children[2].dataset.l = 'coded'; tr.children[4].dataset.l = 'granted';
      if (hasDays) tr.append(el('td', { className: 'num days' + (t.medDays == null ? ' dim' : ''), textContent: t.medDays == null ? '—' : fmt.med(t.medDays) + ' (n=' + t.nDays + ')', title: t.p25 != null ? 'Middle half: ' + fmt.med(t.p25) + ' to ' + fmt.med(t.p75) + ' days' : '' }));
      return tr;
    };
    const body = el('tbody', {}, ...shown.map(([k, label]) => line(label, op.cats[k], S.pooled[k], k)), line('All motion rulings', op.motions, S.pooled.motions, 'motion', true));
    if (!shown.length) body.prepend(el('tr', {}, el('td', { className: 'txt dim', colSpan: cols.length, textContent: 'No motion rulings among this judge\'s written opinions in this period.' })));
    $('j-oc-table').replaceChildren(head, body);
    const none = MCATS.filter(([k]) => !op.cats[k].n).map(([, l]) => l);
    const t = op.motions; const notes = [];
    if (none.length && shown.length) notes.push('No written rulings in this period on: ' + none.join(', ') + '.');
    notes.push(t.nDays ? `Time to ruling rests on ${fmt.int(t.nDays)} of ${plural(t.n, 'motion ruling')} so far; filing dates are collected a few at a time.` : 'Time to ruling will appear as motion filing dates are collected.');
    if (t.nHearing) notes.push(`A hearing was set in the case while the motion was pending for ${fmt.int(t.hearings)} of ${plural(t.nHearing, 'ruling')} with dates on file.`);
    $('j-oc-foot').textContent = notes.join(' ');
  }

  function drawJudgeActivity(or, op, name) {
    const S = state.stats; const code = op.code; const judge = 'var(--judge)'; const court = 'var(--court)';
    $('j-act-legend').replaceChildren(legendItem(judge, 'Judge ' + name), legendItem(court, 'Court'));
    lineChart($('c-j-weekly'), { rows: S.weekly, fmtY: fmt.d1, label: 'Orders per working day by week, Judge ' + name + ' and the median judge',
      series: [{ label: 'Judge ' + name, color: judge, get: (r) => r[code] || 0 }, { label: 'Median judge', color: court, get: (r) => r.median || 0 }] });
    monthColumns($('c-j-monthly'), { rows: S.monthly, label: 'Written opinions by month, Judge ' + name,
      keys: [{ k: 'merits', label: 'Merits rulings', color: judge }, { k: 'rest', label: 'Other opinions and R&Rs', color: court }],
      get: (r, k) => { const c = r.by[code] || zeroCats(); return k === 'merits' ? meritsOf(c) : c.other + c.rr; },
      href: (r) => findHref({ judge: code, month: r.month }) });
    const days = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri']];
    if (!or.orders) emptyChart($('c-j-dow'), 168, 'No civil orders in this period');
    else groupedColumns($('c-j-dow'), { cats: days.map(([k]) => k), catLabel: (k) => days.find((d) => d[0] === k)[1], fmtY: fmt.pct0, label: 'Share of orders by weekday',
      tipTitle: (k) => days.find((d) => d[0] === k)[1] + ': share of civil orders',
      series: [{ label: 'Judge ' + name, color: judge, values: days.map(([k]) => or[k]) }, { label: 'All judges', color: court, values: days.map(([k]) => S.dowCourt[k]) }] });
  }

  function drawJudgeHabits(or, op, name) {
    const S = state.stats;
    $('j-habits-cap').textContent = `Since ${fmtDate(or.start)}, how many of Judge ${name}'s civil orders chambers flagged for PACER's Written Opinions Report. The docket cannot tell an unflagged reasoned order from a minute entry, so this measures flagging practice, not how often a judge gives reasons.`;
    $('j-habits').replaceChildren(
      fact('Civil orders', fmt.int(or.orders), fmt.int(or.text_orders) + ' entered as text orders (' + pctOf(or.text_orders, or.orders) + ')'),
      fact('Flagged as written opinions', fmt.int(op.written_window), pctOf(op.written_window, or.orders) + ' of orders · median judge ' + fmt.pct0(S.totals.medWrittenShare)),
      fact('Orders on motions', fmt.int(or.motion_orders), 'orders whose docket event names a motion'),
      fact('Written opinions on motions', fmt.int(op.written_motions), pctOf(op.written_motions, or.motion_orders) + ' of orders on motions'),
    );
  }

  function drawJudgeMotions(code) {
    const S = state.stats; const M = S.motions.filter((m) => m.judge === code);
    $('j-motions-all').href = hashFor('motions', { mt: { judge: code, view: 'pending' } });
    const box = $('j-motions');
    if (!M.length) {
      box.replaceChildren(el('p', { className: 'cap', textContent: S.motionsSince
        ? `No civil motions recorded for this judge's cases since ${fmtDate(S.motionsSince)}, when recording began. Motions appear here as they are filed, with their submission dates.`
        : 'Recording of submitted motions has just begun. Motions in this judge\'s cases appear here as they are filed, with their submission dates.' }));
      return;
    }
    const past = M.filter((m) => m.past); const waiting = M.filter((m) => !m.ruled);
    const rows = waiting.slice(0, 8);
    box.replaceChildren(
      el('div', { className: 'facts' }, fact('Motions recorded', fmt.int(M.length), 'since ' + fmtShort(S.motionsSince)), fact('Awaiting a ruling', fmt.int(waiting.length), 'no ruling found yet'),
        fact('Past submission', fmt.int(past.length), past.length ? 'median ' + fmt.med(median(past.map((m) => m.daysPast))) + ' days past' : 'none right now'), fact('Ruling found', fmt.int(M.length - waiting.length), 'a later order names the motion type')),
      rows.length ? el('div', { className: 'scroll', style: 'margin-top:12px' }, motionTable(rows, false)) : null);
  }

  function drawFeed() {
    const S = state.stats; const code = state.judge; const J = state.jf; const q = J.q.trim().toLowerCase();
    const sel = $('j-op-type'); fillTypeSelect(sel); sel.value = J.type; if ($('j-op-q').value !== J.q) $('j-op-q').value = J.q;
    const rows = S.recent.filter((o) => o.judge === code && typeMatch(o, J.type) && textMatch(o, q));
    const shown = rows.slice(0, 15);
    $('j-op-count').textContent = rows.length > shown.length ? 'latest ' + shown.length + ' of ' + fmt.int(rows.length) : plural(rows.length, 'opinion');
    $('j-feed').replaceChildren(...(shown.length ? shown.map((o) => el('li', {},
      el('span', { className: 'd', textContent: fmtShort(o.date) }),
      el('span', { className: 'h' }, el('span', {}, ...caseLink(o)), outcomePill(o)),
      el('span', { className: 'e', textContent: o.event }),
      el('span', { className: 'c', textContent: o.title, title: o.title })))
      : [el('li', {}, el('span', { className: 'empty', textContent: q || J.type ? 'No written opinions match this filter.' : 'No written opinions in this period.' }))]));
    $('j-op-all').href = findHref({ judge: code, q: J.q, type: J.type });
    $('j-op-all').textContent = rows.length > shown.length ? 'All ' + fmt.int(rows.length) + ' in the opinion search →' : 'Open in the opinion search →';
  }

  // ------------------------------------------------------------ page: compare
  function renderCompare() {
    const S = state.stats; const T = S.totals; const codes = state.cmp.filter((c) => S.names[c]);
    document.title = 'Compare judges · EDLA Analyzer';
    $('cmp-chips').replaceChildren(...codes.map((c) => el('span', { className: 'fchip' }, 'Judge ' + S.names[c],
      el('a', { href: hashFor('compare', { cmp: codes.filter((x) => x !== c) }), textContent: '×', title: 'Remove', 'aria-label': 'Remove Judge ' + S.names[c] }))));
    const add = $('cmp-add');
    add.replaceChildren(new Option(codes.length >= 4 ? 'Four judges at most' : '+ Add a judge', ''), ...judgesAlpha().filter((j) => !codes.includes(j.code)).map((j) => new Option(j.name, j.code)));
    add.disabled = codes.length >= 4;
    const table = $('cmp-table');
    if (!codes.length) { table.replaceChildren(el('tbody', {}, el('tr', {}, el('td', { className: 'txt dim', textContent: 'Add a judge to begin.' })))); return; }
    const ors = codes.map((c) => S.orders.find((r) => r.code === c)); const ops = codes.map((c) => S.opinions.find((r) => r.code === c));
    const head = el('thead', {}, el('tr', {}, el('th', { textContent: 'Figure' }), ...codes.map((c) => el('th', {}, el('a', { href: judgeHref(c), textContent: 'Judge ' + S.names[c] }))), el('th', { textContent: 'All judges' })));
    const body = el('tbody');
    const grp = (label) => body.append(el('tr', { className: 'grp' }, el('td', { colSpan: codes.length + 2, textContent: label })));
    const row = (label, f, all, tip) => body.append(el('tr', {}, el('td', { textContent: label, title: tip || '' }), ...codes.map((c, i) => { const v = f(i); return el('td', { className: 'num' }, v); }), el('td', { className: 'num dim' }, all)));
    grp('Volume, ' + (state.period ? 'last ' + state.period + ' days' : 'all data'));
    row('Civil orders', (i) => fmt.int(ors[i].orders), fmt.int(T.medOrders) + ' (median)');
    row('Orders per working day', (i) => fmt.d1(ors[i].per_day), fmt.d1(T.medPerDay) + ' (median)');
    row('Written opinions', (i) => fmt.int(ops[i].total), fmt.med(T.medTotal) + ' (median)');
    row('Written opinions per week', (i) => fmt.d2(ops[i].per_week), fmt.d2(T.medPerWeek) + ' (median)', 'Excluding magistrate R&Rs');
    row('Merits rulings per month', (i) => fmt.d2(ops[i].merits_month), fmt.d2(T.medMerits) + ' (median)', 'Rule 12, Rule 56, and trial rulings per 21 working days');
    row('Orders flagged as written opinions', (i) => fmt.pct0(ors[i].written_share), fmt.pct0(T.medWrittenShare) + ' (median)');
    row('Median opinion length', (i) => (ops[i].n_pages ? fmt.med(ops[i].med_pages) + ' pages (n=' + ops[i].n_pages + ')' : 'not yet'), T.medPages ? fmt.med(T.medPages) + ' pages (median)' : '—');
    grp('Motion outcomes · share granted in full, of coded rulings');
    const ocCell = (t, who, href) => (t.known ? el('div', { className: 'cv' }, ocBar(t, { who, href }), el('span', { textContent: fmt.pct0(t.granted / t.known) + ' ' }), el('small', { textContent: 'n=' + t.known }))
      : el('span', { className: 'dim', textContent: t.n ? plural(t.n, 'ruling') + ', not coded yet' : 'no rulings' }));
    [['motion', 'All motion rulings'], ...MCATS].filter(([k]) => k === 'motion' || ops.some((o) => o.cats[k].n)).forEach(([k, label]) => {
      const get = (o) => (k === 'motion' ? o.motions : o.cats[k]);
      const pool = k === 'motion' ? S.pooled.motions : S.pooled[k];
      row(label, (i) => ocCell(get(ops[i]), 'Judge ' + S.names[codes[i]], (oc) => findHref({ judge: codes[i], type: k, oc })), ocCell(pool, 'All judges'));
    });
    grp('Time to ruling');
    row('Median days, all motions', (i) => (ops[i].motions.medDays == null ? 'not yet' : fmt.med(ops[i].motions.medDays) + ' (n=' + ops[i].motions.nDays + ')'), T.medDays == null ? 'not yet' : fmt.med(T.medDays) + ' (median)');
    table.replaceChildren(head, body);
  }

  // ------------------------------------------------------------ page: opinion search
  function finderRows() {
    const S = state.stats; const F = state.f; const q = F.q.trim().toLowerCase();
    return S.recent.filter((o) => (!F.judge || o.judge === F.judge) && typeMatch(o, F.type) && (!F.oc || ocMatch(o, F.oc))
      && (!F.pdf || linkKind(o) === 'pdf') && (!F.month || o.date.slice(0, 7) === F.month) && textMatch(o, q));
  }
  function renderOpinions() {
    const S = state.stats; const F = state.f;
    document.title = 'Written opinions · EDLA Analyzer';
    $('op-sub').textContent = `${fmt.int(S.recent.length)} written opinions since ${fmtDate(S.since.opinions)}, newest first. Click a case number to open the opinion; "PDF" means the opinion itself is one click away.`;
    const js = $('op-judge'); if (js.options.length < 2) js.append(new Option('All judges', ''), ...judgesAlpha().map((j) => new Option(j.name, j.code)));
    fillTypeSelect($('op-type'));
    if ($('op-q').value !== F.q) $('op-q').value = F.q;
    js.value = F.judge; $('op-type').value = F.type; $('op-outcome').value = F.oc === 'rest' ? '' : F.oc; $('op-pdf').checked = F.pdf;
    const chips = [];
    if (F.month) chips.push(['Month: ' + fmtMonth(F.month), { month: '' }]);
    if (F.oc === 'rest') chips.push(['Outcome: mixed, moot, or other', { oc: '' }]);
    if (F.q || F.judge || F.type || F.oc || F.pdf || F.month) chips.push(['Clear all', emptyFinder()]);
    $('op-chips').replaceChildren(...chips.map(([label, patch]) => el('span', { className: 'fchip' }, label, el('a', { href: hashFor('opinions', { f: { ...F, ...patch } }), textContent: '×', title: 'Remove this filter', 'aria-label': 'Remove: ' + label }))));
    const rows = finderRows(); const shown = rows.slice(0, state.limit);
    const hasDays = rows.some((o) => o.days != null); const hasPages = rows.some((o) => o.pages != null);
    const cols = ['Date', 'Judge', 'Case · doc', 'Ruling', 'Outcome'].concat(hasDays ? ['Days to ruling'] : [], hasPages ? ['Pages'] : [], ['Case name'], state.editor ? ['Record'] : []);
    const head = el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c, className: /^(Days|Pages)/.test(c) ? 'r' : '' }))));
    const body = el('tbody', {}, ...(shown.length ? shown.map((o) => {
      const cells = [el('td', { className: 'mono', textContent: fmtMDY(o.date) }),
        el('td', { className: 'txt' }, el('a', { className: 'judge', href: judgeHref(o.judge), textContent: S.names[o.judge] })),
        el('td', { className: 'txt' }, ...caseLink(o)), el('td', { className: 'ev', textContent: o.event }), el('td', { className: 'txt' }, outcomePill(o))];
      if (hasDays) cells.push(el('td', { className: 'num' + (o.days == null ? ' dim' : ''), textContent: o.days == null ? '—' : fmt.int(o.days), title: o.filed ? 'Motion filed ' + fmtDate(o.filed) : 'Motion filing date not on file' }));
      if (hasPages) cells.push(el('td', { className: 'num' + (o.pages == null ? ' dim' : ''), textContent: o.pages == null ? '—' : fmt.int(o.pages) }));
      cells.push(el('td', { className: 'wrap', textContent: o.title }));
      if (state.editor) cells.push(el('td', { className: 'txt' }, el('a', { href: recordLink(o), target: '_blank', rel: 'noopener noreferrer', textContent: o.oc ? 'Correct' : 'Record' })));
      return el('tr', {}, ...cells);
    }) : [el('tr', {}, el('td', { className: 'txt dim', colSpan: cols.length, textContent: 'No written opinions match. Try fewer filters or a shorter search.' }))]));
    $('op-table').replaceChildren(head, body);
    $('op-count').textContent = rows.length ? (shown.length < rows.length ? fmt.int(shown.length) + ' of ' : '') + plural(rows.length, 'opinion') : '';
    $('op-more').hidden = shown.length >= rows.length;
  }

  // ------------------------------------------------------------ page: submitted motions
  function motionTable(rows, withJudge) {
    const S = state.stats;
    const cols = (withJudge ? ['Judge'] : []).concat(['Case · doc', 'Motion', 'Filed', 'Submission', 'Days past', 'Status', 'Case name']);
    return el('table', { className: 't' }, el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c, className: c === 'Days past' ? 'r' : '' })))),
      el('tbody', {}, ...rows.map((m) => el('tr', {},
        withJudge ? el('td', { className: 'txt' }, m.judge ? el('a', { className: 'judge', href: judgeHref(m.judge), textContent: S.names[m.judge] }) : el('span', { className: 'dim', textContent: 'Not yet known' })) : null,
        el('td', { className: 'txt' }, el('a', { className: 'case', href: CL + '?type=r&court=laed&docket_number=' + encodeURIComponent(m.case), target: '_blank', rel: 'noopener noreferrer', textContent: m.case + ' · ' + m.doc, title: 'Search CourtListener for this case' })),
        el('td', { className: 'ev', textContent: m.event }),
        el('td', { className: 'mono', textContent: fmtMDY(m.date) }),
        el('td', { className: 'mono' + (m.submit ? '' : ' dim'), textContent: m.submit ? fmtMDY(m.submit) : 'not read yet' }),
        el('td', { className: 'num' + (m.daysPast == null ? ' dim' : ''), textContent: m.daysPast == null ? '—' : fmt.int(m.daysPast) }),
        el('td', { className: 'txt' }, m.ruled ? el('span', { className: 'pill' }, (() => { const i = el('i'); i.style.background = css('--o-partial'); return i; })(), 'Ruling found ' + fmtShort(m.ruled))
          : m.past ? el('span', { className: 'pill warn' }, el('i'), 'Past submission') : el('span', { className: 'pill none', textContent: m.submit ? 'Not yet submitted' : 'Awaiting' })),
        el('td', { className: 'wrap', textContent: m.title })))));
  }
  function motionRows() {
    const S = state.stats; const M = state.mt; const q = M.q.trim().toLowerCase();
    return S.motions.filter((m) => (!M.judge || m.judge === M.judge) && (M.view === 'all' || (M.view === 'pending' ? !m.ruled : m.past))
      && (!q || (m.case + ' ' + m.title + ' ' + m.event).toLowerCase().includes(q)));
  }
  function renderMotions() {
    const S = state.stats; const M = state.mt; const all = S.motions.filter((m) => !M.judge || m.judge === M.judge);
    document.title = 'Submitted motions · EDLA Analyzer';
    $('mt-since').textContent = S.motionsSince ? 'on ' + fmtDate(S.motionsSince) : 'when this page went live';
    const js = $('mt-judge'); if (js.options.length < 2) js.append(new Option('All judges', ''), ...judgesAlpha().map((j) => new Option(j.name, j.code)));
    js.value = M.judge; $('mt-view').value = M.view; if ($('mt-q').value !== M.q) $('mt-q').value = M.q;
    const past = all.filter((m) => m.past);
    $('mt-kpis').replaceChildren(
      kpi({ label: 'Motions recorded', value: fmt.int(all.length), sub: S.motionsSince ? 'since ' + fmtShort(S.motionsSince) : 'none yet' }),
      kpi({ label: 'With a submission date', value: fmt.int(all.filter((m) => m.submit).length), sub: 'read from the docket text so far' }),
      kpi({ label: 'Ruling found', value: fmt.int(all.filter((m) => m.ruled).length), sub: 'a later order names the motion type' }),
      kpi({ label: 'Past submission', value: fmt.int(past.length), sub: past.length ? 'no ruling found · median ' + fmt.med(median(past.map((m) => m.daysPast))) + ' days past' : 'none right now' }),
    );
    const rows = motionRows(); const shown = rows.slice(0, M.limit);
    const table = shown.length ? motionTable(shown, true) : el('table', { className: 't' }, el('tbody', {}, el('tr', {}, el('td', { className: 'txt dim', textContent: S.motions.length ? 'No motions match.' : 'No motions on file yet. The updater records them from the court\'s feed as they are filed.' }))));
    table.id = 'mt-table'; $('mt-table').replaceWith(table);
    $('mt-count').textContent = rows.length ? (shown.length < rows.length ? fmt.int(shown.length) + ' of ' : '') + plural(rows.length, 'motion') : '';
    $('mt-more').hidden = shown.length >= rows.length;
    $('mj-table').closest('.panel').hidden = !S.motions.length;
    if (S.motions.length) drawTable('mj-table');
  }

  // ------------------------------------------------------------ page: court
  const finderCount = (preset) => (r) => findHref({ judge: r.code, ...preset });
  TABLES['t-orders'] = { rows: () => state.stats.orders, sort: { k: 'name', dir: 1 }, foot: [sumFoot, medFoot], cols: [
    { k: 'name', label: 'Judge', med: false },
    { k: 'working_days', label: 'Working days', f: fmt.int, num: true, title: 'Weekdays other than court holidays, from the judge\'s first day on the bench' },
    { k: 'orders', label: 'Orders', f: fmt.int, num: true, bar: true, sum: true, title: 'Civil orders entered in the period' },
    { k: 'per_day', label: 'Per working day', f: fmt.d1, num: true, bar: true, title: 'Orders per working day' },
    { k: 'cases', label: 'Cases', f: fmt.int, num: true, sum: true, title: 'Distinct cases with at least one order' },
    { k: 'per_case', label: 'Per case', f: fmt.d1, num: true, title: 'Orders per case with orders' },
    { k: 'last10', label: 'Last 10 days', f: fmt.int, num: true, sum: true, title: 'Orders in the last 10 working days' },
    { k: 'text_orders', label: 'Text orders', f: fmt.int, num: true, sum: true, title: 'Orders whose docket event begins "Text Order"' },
    { k: 'written_share', label: 'Flagged as opinions', f: fmt.pct0, num: true, title: 'Share of civil orders flagged for the Written Opinions Report' },
    { k: 'spark', label: 'Weekly trend', nosort: true, render: (r) => sparkline(r.spark), title: 'Orders per working day, week by week' },
  ] };
  TABLES['t-opinions'] = { rows: () => state.stats.opinions, sort: { k: 'name', dir: 1 }, foot: [sumFoot, medFoot], cols: [
    { k: 'name', label: 'Judge', med: false },
    { k: 'working_days', label: 'Working days', f: fmt.int, num: true },
    { k: 'total', label: 'Opinions', f: fmt.int, num: true, bar: true, sum: true, href: finderCount({}), title: 'Entries on PACER\'s Written Opinions Report' },
    { k: 'rr', label: 'R&Rs', f: fmt.int, num: true, sum: true, href: finderCount({ type: 'rr' }), title: 'Magistrate judges\' reports and recommendations in the judge\'s cases' },
    { k: 'per_week', label: 'Per week', f: fmt.d2, num: true, bar: true, title: 'Opinions by the judge (excluding R&Rs) per five working days' },
    { k: 'merits', label: 'Merits', f: fmt.int, num: true, sum: true, href: finderCount({ type: 'merits' }), title: 'Rule 12, Rule 56, and trial or post-trial rulings' },
    { k: 'merits_month', label: 'Merits / month', f: fmt.d2, num: true, bar: true, title: 'Merits rulings per 21 working days' },
    { k: 'r12', label: 'Rule 12', f: fmt.int, num: true, sum: true, href: finderCount({ type: 'r12' }), title: 'Rulings on motions to dismiss or for judgment on the pleadings' },
    { k: 'r56', label: 'Rule 56', f: fmt.int, num: true, sum: true, href: finderCount({ type: 'r56' }), title: 'Rulings on motions for summary judgment' },
    { k: 'cases', label: 'Cases', f: fmt.int, num: true, sum: true, title: 'Distinct cases with an opinion' },
    { k: 'pdf', label: 'With PDF', f: fmt.int, num: true, sum: true, href: (r) => findHref({ judge: r.code, pdf: true }), title: 'Opinions whose PDF is one click away' },
    { k: 'med_pages', label: 'Median pages', f: (v) => (v ? fmt.med(v) : '—'), num: true, title: 'Median PDF length of opinions with a page count on file', hide: (all) => all.filter((r) => r.n_pages >= FEW).length < 8 },
    { k: 'last', label: 'Latest', f: (v) => (v ? fmtShort(v) : '—'), num: true, med: false, title: 'Date of the most recent written opinion' },
  ] };
  const ocTableCols = (g) => [
    { k: 'name', label: 'Judge' },
    { k: g + '_n', label: 'Rulings', f: fmt.int, num: true, sum: true, href: finderCount({ type: g === 'all' ? 'motion' : g }) },
    { k: g + '_known', label: 'Coded', f: fmt.int, num: true, sum: true, href: finderCount({ type: g === 'all' ? 'motion' : g, oc: 'known' }), title: 'Rulings with a coded outcome' },
    { k: g + '_granted', label: 'Granted', f: fmt.int, num: true, sum: true, gstart: true, href: finderCount({ type: g === 'all' ? 'motion' : g, oc: 'granted' }) },
    { k: g + '_partial', label: 'In part', f: fmt.int, num: true, sum: true, href: finderCount({ type: g === 'all' ? 'motion' : g, oc: 'partial' }) },
    { k: g + '_denied', label: 'Denied', f: fmt.int, num: true, sum: true, href: finderCount({ type: g === 'all' ? 'motion' : g, oc: 'denied' }) },
    { k: g + '_rest', label: 'Other', f: fmt.int, num: true, sum: true, title: 'Mixed, moot, or other', href: finderCount({ type: g === 'all' ? 'motion' : g, oc: 'rest' }) },
    { k: g + '_share', label: 'Outcome shares', nosort: true, cls: 'ocwrap', gstart: true,
      render: (r) => ocBar({ n: r[g + '_n'], known: r[g + '_known'], granted: r[g + '_granted'], partial: r[g + '_partial'], denied: r[g + '_denied'], rest: r[g + '_rest'] },
        { labels: true, who: 'Judge ' + r.name, href: (k) => findHref({ judge: r.code, type: g === 'all' ? 'motion' : g, oc: k }) }) },
  ];
  TABLES['t-outcomes'] = { rows: () => state.stats.opinions, sort: { k: 'name', dir: 1 }, get cols() { return ocTableCols(state.ocGroup); },
    foot: [['All judges', (c, all) => (c.render ? ocBar(state.stats.pooled['g_' + state.ocGroup], { labels: true, who: 'All judges' }) : c.sum ? c.f(d3.sum(all, (r) => r[c.k])) : '')]] };
  const dayCols = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri']];
  const heatCell = (v) => { const sp = el('span', { className: 'heat', textContent: fmt.pct0(v) }); const c = d3.interpolateRgb(css('--panel'), css('--heat-hi'))(Math.max(0, Math.min(1, (v - 0.05) / 0.35))); sp.style.background = c; sp.style.color = inkOn(c); return sp; };
  TABLES['t-dow'] = { rows: () => state.stats.orders, sort: { k: 'name', dir: 1 },
    foot: [['All judges', (c, all) => (c.k === 'orders' ? fmt.int(d3.sum(all, (r) => r.orders)) : c.k in state.stats.dowCourt ? fmt.pct0(state.stats.dowCourt[c.k]) : '')]],
    cols: [{ k: 'name', label: 'Judge' }, ...dayCols.map(([k, label]) => ({ k, label, r: true, render: (r) => heatCell(r[k]) })), { k: 'orders', label: 'Orders', f: fmt.int, num: true }] };
  TABLES['mj-table'] = { rows: () => state.stats.motionsByJudge, sort: { k: 'past', dir: -1 }, foot: [sumFoot], cols: [
    { k: 'name', label: 'Judge' },
    { k: 'seen', label: 'Motions recorded', f: fmt.int, num: true, sum: true, title: 'Civil motions recorded from the feed' },
    { k: 'dated', label: 'With date', f: fmt.int, num: true, sum: true, title: 'Motions whose submission date has been read from the docket text' },
    { k: 'ruled', label: 'Ruling found', f: fmt.int, num: true, sum: true, title: 'Motions matched to a later order or opinion in the same case' },
    { k: 'awaiting', label: 'Awaiting', f: fmt.int, num: true, sum: true, title: 'Motions with no ruling found yet, whether or not past submission' },
    { k: 'past', label: 'Past submission', f: fmt.int, num: true, sum: true, title: 'Past the submission date with no ruling found' },
    { k: 'med_past', label: 'Median days past', f: (v) => (v ? fmt.med(v) : '—'), num: true, title: 'Median days since the submission date, for motions past it' },
  ] };

  function renderCourt() {
    const S = state.stats; const v = state.view;
    document.title = 'All judges · EDLA Analyzer';
    $('court-nav').replaceChildren(...VIEWS.map(([k, label]) => { const a = el('a', { href: hashFor('court', { view: k }), textContent: label }); if (k === v) a.setAttribute('aria-current', 'page'); return a; }));
    document.querySelectorAll('.cview').forEach((n) => { n.hidden = n.dataset.view !== v; });
    const blue = 'var(--judge)'; const gray = 'var(--court)';
    if (v === 'orders') {
      drawTable('t-orders');
      lineChart($('c-court-weekly'), { rows: S.weekly, fmtY: fmt.d1, H: 220, label: 'Civil orders per working day, all judges combined, by week', series: [{ label: 'All judges', color: blue, get: (r) => r.all }] });
    } else if (v === 'opinions') {
      drawTable('t-opinions');
      monthColumns($('c-court-monthly'), { rows: S.monthly, H: 220, label: 'Written opinions by month, all judges',
        keys: [{ k: 'merits', label: 'Merits rulings', color: blue }, { k: 'rest', label: 'Other opinions and R&Rs', color: gray }],
        get: (r, k) => (k === 'merits' ? meritsOf(r.all) : r.all.other + r.all.rr), href: (r) => findHref({ month: r.month }) });
    } else if (v === 'outcomes') {
      document.querySelectorAll('#oc-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === state.ocGroup)));
      const g = state.ocGroup; const pool = S.pooled['g_' + g];
      $('oc-cap').textContent = `How each judge's ${GROUPS[g].toLowerCase()} rulings came out, counting only rulings with a coded outcome (${fmt.int(pool.known)} of ${fmt.int(pool.n)} so far). Outlined bars rest on fewer than ${FEW} coded rulings, too few to read much into. Click a count or a segment to see the opinions.`;
      drawTable('t-outcomes');
    } else if (v === 'weekdays') {
      $('dow-days').textContent = 'Rests on ' + plural(S.workingDays, 'working day') + ' since ' + fmtShort(S.since.orders);
      drawTable('t-dow');
    } else if (v === 'hours') {
      const js = $('hours-judge'); if (js.options.length < 2) js.append(new Option('No judge', ''), ...judgesAlpha().map((j) => new Option(j.name, j.code)));
      js.value = state.hoursJudge; drawHours();
    }
  }
  function drawHours() {
    const S = state.stats; const sel = state.hoursJudge; const blue = 'var(--judge)'; const gray = 'var(--court)';
    const share = (a) => { const t = d3.sum(a); return a.map((x) => (t ? x / t : 0)); };
    const series = [{ label: 'All judges', color: gray, values: share(S.hours.all), counts: S.hours.all }];
    if (sel) series.push({ label: 'Judge ' + S.names[sel], color: blue, values: share(S.hours.by[sel]), counts: S.hours.by[sel] });
    $('hours-cap').textContent = 'Share of civil orders entered in each clock hour, Central, since ' + fmtDate(S.since.orders) + '. Entry time is when the clerk docketed the order, which can differ from when it was signed.';
    $('hours-legend').replaceChildren(...series.map((s) => legendItem(s.color, s.label)));
    const used = d3.range(24).filter((h) => series.some((s) => s.counts[h]));
    if (!used.length) { emptyChart($('c-hours'), 260, 'No entry times on file'); return; }
    const hrs = d3.range(Math.min(...used), Math.max(...used) + 1);
    const hourName = (h) => (h % 12 || 12) + (h < 12 ? 'a' : 'p');
    const hourLong = (h) => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
    groupedColumns($('c-hours'), { cats: hrs, catLabel: hourName, H: 260, fmtY: fmt.pct0, label: 'Share of civil orders by hour of entry', tipTitle: (h) => hourLong(h) + ' to ' + hourLong((h + 1) % 24),
      series: series.map((s) => ({ ...s, values: hrs.map((h) => s.values[h]), counts: hrs.map((h) => s.counts[h]) })) });
  }

  function renderLog() {
    document.title = 'Update log · EDLA Analyzer';
    const runs = state.data.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
    $('t-log').replaceChildren(el('thead', {}, el('tr', {}, ...['Run (Central)', 'Orders added', 'Opinions added', 'Note'].map((c, i) => el('th', { textContent: c, className: i === 1 || i === 2 ? 'r' : '' })))),
      el('tbody', {}, ...runs.map((r) => el('tr', {}, el('td', { className: 'mono', textContent: String(r.at).slice(0, 16).replace('T', ' ') }), el('td', { className: 'num', textContent: fmt.int(+r.orders_added || 0) }),
        el('td', { className: 'num', textContent: fmt.int(+r.opinions_added || 0) }), el('td', { className: 'wrap', textContent: r.note || '' })))));
  }

  // ------------------------------------------------------------ CSV export
  function csvRows(which) {
    const S = state.stats;
    if (which === 'op') {
      const head = ['Date', 'Judge', 'Case', 'Doc', 'Ruling type', 'Motion category', 'Ruling', 'Outcome', 'Outcome source', 'Motion filed', 'Days to ruling', 'Pages', 'Hearing set', 'Case name', 'Link'];
      return [head, ...finderRows().map((o) => [o.date, S.names[o.judge], o.case, o.doc, catLabel[o.cat], mcatLabel[o.mcat] || '',
        o.event, OUTCOMES[o.oc] || '', o.ocSrc || '', o.filed, o.days == null ? '' : o.days, o.pages == null ? '' : o.pages, o.hearing == null ? '' : o.hearing ? 'yes' : 'no', o.title, opinionLink(o, linkKind(o))])];
    }
    if (which === 'mt') {
      return [['Judge', 'Case', 'Doc', 'Motion', 'Filed', 'Submission date', 'Days past submission', 'Ruling found', 'Case name'],
        ...motionRows().map((m) => [S.names[m.judge] || '', m.case, m.doc, m.event, m.date, m.submit, m.daysPast == null ? '' : m.daysPast, m.ruled, m.title])];
    }
    const id = which === 'mj' ? 'mj-table' : { orders: 't-orders', opinions: 't-opinions', outcomes: 't-outcomes', weekdays: 't-dow', hours: 't-dow' }[state.view];
    const cfg = TABLES[id]; const all = cfg.rows(); const cols = cfg.cols.filter((c) => !c.nosort && !(c.hide && c.hide(all)));
    return [cols.map((c) => c.label), ...all.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => cols.map((c) => (typeof r[c.k] === 'number' ? +r[c.k].toFixed(4) : r[c.k])))];
  }
  function downloadCsv(which) {
    if (!state.stats) return;
    const text = csvRows(which).map((row) => row.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
    const name = which === 'op' ? 'opinions' : which === 'mt' ? 'motions' : which === 'mj' ? 'motions-by-judge' : 'court-' + state.view;
    const a = el('a', { href: URL.createObjectURL(new Blob([text + '\n'], { type: 'text/csv' })), download: `edla-${name}-${state.stats.through}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------ search box: judges, case numbers, and opinion keywords
  // "2:25-cv-01750", "25-cv-1750", "25cv1750", or "1750" all find the same case.
  function caseQuery(q) {
    const s = q.replace(/\s+/g, '').toLowerCase();
    let m = s.match(/^(?:\d:)?(\d{2})[-:]?(?:cv|civ|c)?[-:]?0*(\d{1,5})(?:-[a-z]+)*$/);
    if (m && /\D/.test(s)) return { yy: m[1], num: m[2] };
    m = s.match(/^0*(\d{3,5})$/); if (m) return { yy: '', num: m[1] };
    return null;
  }
  function omniResults(raw) {
    const q = raw.trim(); if (!q || !state.stats) return [];
    const S = state.stats; const lc = q.toLowerCase(); const out = [];
    judgesAlpha().filter((j) => j.name.toLowerCase().startsWith(lc) || (lc.length >= 3 && j.name.toLowerCase().includes(lc)) || j.code.toLowerCase() === lc).slice(0, 4).forEach((j) => {
      const op = S.opinions.find((r) => r.code === j.code);
      out.push({ kind: 'Judge', label: 'Judge ' + j.name, sub: plural(op.total, 'written opinion') + ' · ' + j.code, href: judgeHref(j.code) });
    });
    const cq = caseQuery(q);
    let cases = cq ? state.cases.filter((c) => c.num === cq.num && (!cq.yy || c.yy === cq.yy)) : [];
    if (!cases.length && cq && cq.num.length >= 3) cases = state.cases.filter((c) => c.num.startsWith(cq.num) && (!cq.yy || c.yy === cq.yy));
    if (!cq && lc.length >= 3) cases = state.cases.filter((c) => c.lt.includes(lc));
    cases.slice().sort((a, b) => b.last.localeCompare(a.last)).slice(0, 6).forEach((c) => out.push({ kind: 'Case', label: el('code', { textContent: c.case }),
      sub: (c.judge ? 'Judge ' + S.names[c.judge] : 'Judge not yet known') + ' · ' + (c.title || 'case name not on file'), href: c.judge ? judgeHref(c.judge) : findHref({ q: c.case }) }));
    out.push({ kind: 'Search', label: 'Opinions matching “' + q + '”', sub: 'Search every written opinion by party, case number, or motion', href: findHref({ q }) });
    return out;
  }
  const omnis = [];
  function omnibox(root) {
    const input = root.querySelector('input');
    const list = el('div', { className: 'omni-list', id: root.id + '-list', hidden: true }); list.setAttribute('role', 'listbox'); root.append(list);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', list.id); input.setAttribute('aria-autocomplete', 'list');
    let items = []; let active = 0;
    const close = (clear) => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); if (clear) { input.value = ''; input.blur(); } };
    const paint = () => {
      if (!input.value.trim()) { close(false); return; }
      list.replaceChildren(...(items.length ? items.map((it, i) => {
        const a = el('a', { className: 'opt', href: it.href, id: list.id + '-' + i }, el('span', { className: 'k', textContent: it.kind }), el('span', {}, el('span', { className: 'l' }, it.label), it.sub ? el('span', { className: 's', textContent: it.sub }) : null));
        a.setAttribute('role', 'option'); a.setAttribute('aria-selected', String(i === active));
        a.addEventListener('mousedown', (e) => e.preventDefault()); a.addEventListener('click', () => close(true));
        return a;
      }) : [el('div', { className: 'opt-empty', textContent: 'Still loading the data…' })]));
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); if (items.length) input.setAttribute('aria-activedescendant', list.id + '-' + active);
    };
    const draw = () => { items = omniResults(input.value); active = 0; paint(); };
    input.addEventListener('input', draw);
    input.addEventListener('focus', () => { if (input.value.trim()) draw(); });
    input.addEventListener('blur', () => setTimeout(() => close(false), 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); list.children[active].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!items.length) draw(); const it = items[active]; if (it) { close(true); location.hash = it.href; } }
      else if (e.key === 'Escape') { close(true); }
    });
    omnis.push({ root, input });
  }

  // ------------------------------------------------------------ render
  const RENDER = { judges: renderJudges, judge: renderJudge, compare: renderCompare, opinions: renderOpinions, motions: renderMotions, court: renderCourt, log: renderLog };
  function render() {
    const S = state.stats;
    if (state.page === 'judge' && !S.names[state.judge]) state.page = 'judges';
    document.body.dataset.page = state.page;
    PAGES.forEach((p) => { $('page-' + p).hidden = p !== state.page; });
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const k = a.dataset.nav; a.href = hashFor(k, { f: emptyFinder(), mt: { view: 'past' }, view: 'orders' });
      if (NAV[state.page] === k) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('.period button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
    document.querySelectorAll('[data-since]').forEach((n) => { n.textContent = 'Since ' + fmtDate(S.since[n.dataset.since]); });
    $('live-text').textContent = ['Through ' + fmtShort(S.through), lastRunText().replace(' Central', ' CT')].filter(Boolean).join(' · ');
    RENDER[state.page]();
    writeHash();
  }
  let lastPeriod = null; let lastPage = '';
  function update() {
    if (!state.data) return;
    if (state.period !== lastPeriod) { state.stats = compute(state.data, state.period); lastPeriod = state.period; }
    const pageKey = state.page + '/' + state.judge + '/' + state.view;
    render();
    if (pageKey !== lastPage) { if (lastPage) window.scrollTo({ top: 0 }); lastPage = pageKey; }
  }

  async function load() {
    const names = ['opinions', 'orders', 'judges', 'calendar', 'runs', 'outcomes', 'motions'];
    $('status').textContent = 'Loading the docket data…';
    try {
      const files = await Promise.all(names.map((n) => fetch('data/' + n + '.json', { cache: 'no-cache' })
        .then((r) => { if (!r.ok) { if (n === 'outcomes' || n === 'motions') return []; throw new Error(n + ' ' + r.status); } return r.json(); })));
      state.data = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      state.cases = buildCases(state.data);
      $('status').textContent = '';
      readHash();  // again, now that judge names can be resolved
      update();
    } catch (e) {
      const s = $('status'); s.textContent = 'The data files did not load. Reload the page to try again.'; s.className = 'status err';
    }
  }

  // ------------------------------------------------------------ wiring
  document.querySelectorAll('[data-legend="outcomes"]').forEach((n) => n.replaceChildren(...OC_SEGS.map(([k, l]) => legendItem(`var(${ocVar(k)})`, l)), legendItem('transparent', 'Under ' + FEW + ' coded', 'few'), legendItem('var(--o-granted)', 'All judges', 'thin')));
  document.querySelectorAll('[data-legend="outcomes-short"]').forEach((n) => n.replaceChildren(el('span', { textContent: 'Motion outcome bars:' }), ...OC_SEGS.map(([k, l]) => legendItem(`var(${ocVar(k)})`, l)), legendItem('transparent', 'Under ' + FEW + ' coded', 'few')));
  document.querySelectorAll('[data-legend="types"]').forEach((n) => n.replaceChildren(legendItem('var(--judge)', 'Merits rulings'), legendItem('var(--court)', 'Other opinions and R&Rs')));
  omnibox($('omni-top')); omnibox($('omni-hero'));
  Object.keys(TABLES).forEach(wireTable);
  document.querySelectorAll('.period button').forEach((b) => b.addEventListener('click', () => { state.period = b.dataset.period; update(); }));
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next; store.set('edla-theme', next); if (state.stats) render();
  });
  $('j-pick').addEventListener('change', (e) => { location.hash = judgeHref(e.target.value); });
  $('j-print').addEventListener('click', () => window.print());
  $('j-copy').addEventListener('click', (e) => {
    const b = e.currentTarget; const done = () => { b.textContent = 'Link copied'; b.classList.add('done'); setTimeout(() => { b.textContent = 'Copy link'; b.classList.remove('done'); }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, () => window.prompt('Copy this link:', location.href)); else window.prompt('Copy this link:', location.href);
  });
  $('j-op-q').addEventListener('input', (e) => { state.jf.q = e.target.value; drawFeed(); });
  $('j-op-type').addEventListener('change', (e) => { state.jf.type = e.target.value; drawFeed(); });
  $('cmp-add').addEventListener('change', (e) => { if (e.target.value) location.hash = hashFor('compare', { cmp: [...state.cmp, e.target.value] }); });
  const refind = (patch) => { Object.assign(state.f, patch); state.limit = 100; if (state.stats) { renderOpinions(); writeHash(); } };
  $('op-q').addEventListener('input', (e) => refind({ q: e.target.value }));
  $('op-judge').addEventListener('change', (e) => refind({ judge: e.target.value }));
  $('op-type').addEventListener('change', (e) => refind({ type: e.target.value }));
  $('op-outcome').addEventListener('change', (e) => refind({ oc: e.target.value }));
  $('op-pdf').addEventListener('change', (e) => refind({ pdf: e.target.checked }));
  $('op-more').addEventListener('click', () => { state.limit += 200; renderOpinions(); });
  const remotion = (patch) => { Object.assign(state.mt, patch, { limit: 100 }); if (state.stats) { renderMotions(); writeHash(); } };
  $('mt-view').addEventListener('change', (e) => remotion({ view: e.target.value }));
  $('mt-judge').addEventListener('change', (e) => remotion({ judge: e.target.value }));
  $('mt-q').addEventListener('input', (e) => remotion({ q: e.target.value }));
  $('mt-more').addEventListener('click', () => { state.mt.limit += 200; renderMotions(); });
  document.querySelectorAll('#oc-seg button').forEach((b) => b.addEventListener('click', () => { state.ocGroup = b.dataset.g; renderCourt(); }));
  $('hours-judge').addEventListener('change', (e) => { state.hoursJudge = e.target.value; drawHours(); });
  document.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', () => downloadCsv(b.dataset.csv)));
  $('court-csv').addEventListener('click', () => downloadCsv('court'));
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      const o = omnis.find((x) => x.root.offsetParent !== null && getComputedStyle(x.root).visibility !== 'hidden');
      if (o) { e.preventDefault(); o.input.focus(); }
    } else if ((e.key === '[' || e.key === ']') && !typing && state.page === 'judge') {
      location.hash = $(e.key === '[' ? 'j-prev' : 'j-next').getAttribute('href');
    } else if (e.key === 'Escape' && typing) document.activeElement.blur();
  });
  window.addEventListener('hashchange', () => { readHash(); update(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.stats && render(), 150); });
  readHash();
  load();
})();
