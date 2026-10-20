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

  const PAGES = ['judges', 'judge', 'compare', 'cases', 'case', 'notices', 'activity', 'calendar', 'opinions', 'motions', 'rules', 'court', 'log'];
  const NAV = { judges: 'judges', judge: 'judges', compare: 'judges', cases: 'cases', case: 'cases', notices: '', activity: 'activity', calendar: 'calendar', opinions: 'opinions', motions: 'motions', rules: 'rules', court: 'court', log: '' };
  const VIEWS = [['orders', 'Civil orders'], ['opinions', 'Written opinions'], ['outcomes', 'Motion outcomes'], ['weekdays', 'Weekdays'], ['hours', 'Time of day']];
  // Addresses from the earlier, tabbed layout still open the matching page.
  const LEGACY = { overview: ['judges'], orders: ['court', 'orders'], outcomes: ['court', 'outcomes'], finder: ['opinions'] };
  const emptyFinder = () => ({ q: '', judge: '', type: '', oc: '', pdf: false, month: '' });
  const state = { page: 'judges', judge: '', cmp: [], vs: [], view: 'orders', period: '', f: emptyFinder(), limit: 100,
    mt: { view: 'past', q: '', judge: '', limit: 100 }, jf: { q: '', type: '', judge: '' }, ocGroup: 'r12', hoursJudge: '', sorts: {},
    rtab: '', rq: '', act: { q: '', judge: '', kind: '', days: '7', limit: 300 }, cal: { week: '', judge: '', view: '', subs: false }, editor: false, data: null, stats: null, cases: [], pages: {} };
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
    // the same relief ("Compel" and "Order on Motion to Compel"), or an outcome that cites the motion's docket number,
    // taken as its ruling.
    const byCase = {};
    const addRuling = (o, kind) => { if (/\bmotion\b/i.test(o.event || '')) (byCase[o.case] = byCase[o.case] || []).push({ date: o.date, doc: o.doc, event: (o.event || '').toLowerCase(), raw: o.event || '', kind }); };
    D.orders.forEach((o) => addRuling(o, 'order'));
    D.opinions.forEach((o) => addRuling(o, 'opinion'));
    const cited = new Set((D.outcomes || []).filter((r) => r.motion_doc).map((r) => r.case + '|' + r.motion_doc));
    const citedDate = Object.fromEntries((D.outcomes || []).filter((r) => r.motion_doc).map((r) => [r.case + '|' + r.motion_doc, (D.opinions.find((o) => o.case === r.case && o.doc === r.doc) || {}).date || '']));
    const citedBy = Object.fromEntries((D.outcomes || []).filter((r) => r.motion_doc).map((r) => [r.case + '|' + r.motion_doc, r.doc]));
    // Every motion on file (the case pages use them all); the Motions page and judge pages use those in the period.
    const allMotions = (D.motions || []).map((m) => {
      const keys = reliefKeys(m.event);
      let ruled = ''; let ruling = null;
      if (cited.has(m.case + '|' + m.doc)) { ruled = citedDate[m.case + '|' + m.doc] || m.date; ruling = (byCase[m.case] || []).find((r) => r.doc === citedBy[m.case + '|' + m.doc]) || null; }
      else {
        ruling = (byCase[m.case] || []).filter((r) => r.date >= m.date && keys.some((k) => r.event.includes(k))).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
        if (ruling) ruled = ruling.date;
      }
      const past = !!m.submit && m.submit < through && !ruled;
      return { ...m, core: keys[0] || '', kind: motionKind(m.event), ruled, ruling, past, daysPast: past ? daysBetween(m.submit, through) : null, daysToRule: ruled ? daysBetween(m.date, ruled) : null };
    });
    const motions = allMotions.filter((m) => (!m.judge || names[m.judge]) && m.date <= through && (!floor || m.date >= floor))
      .sort((a, b) => (b.daysPast || -1) - (a.daysPast || -1) || b.date.localeCompare(a.date));
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
      motions, allMotions, motionsSince, motionsByJudge: byJudge,
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
    if (page === 'judge') { state.judge = judgeCode(parts[1] || p.get('judge')); if (p.has('tab')) state.rtab = p.get('tab'); }
    if (page === 'rules') state.rq = p.get('q') || '';
    if (page === 'case') { const id = normCase(parts[1]); if (id) state.caseId = id; else page = state.page = 'cases'; }
    if (page === 'cases' && p.get('w') && state.data) {
      const n = importWatch(p.get('w').split(','));
      state.importNote = n ? 'Added ' + plural(n, 'case') + ' from the link to your list.' : 'Every case in the link is already on your list.';
    }
    if (page === 'calendar') state.cal = { week: /^\d{4}-\d{2}-\d{2}$/.test(p.get('week') || '') ? p.get('week') : '', judge: judgeCode(p.get('judge')),
      view: ['week', 'list'].includes(p.get('view')) ? p.get('view') : '', subs: p.get('subs') === '1' };
    if (page === 'activity') state.act = { q: p.get('q') || '', judge: judgeCode(p.get('judge')), kind: ACT_KINDS.some(([k]) => k === p.get('kind')) ? p.get('kind') : '',
      days: ['1', '3', '7', '14'].includes(p.get('days')) ? p.get('days') : '7', limit: 300 };
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
    if (page === 'judge') { path += '/' + o.judge; if (o.tab) p.set('tab', o.tab); }
    if (page === 'case') path += '/' + o.caseId;
    if (page === 'rules' && o.q) p.set('q', o.q);
    if (page === 'calendar' && o.cal) { const c = o.cal; if (c.week) p.set('week', c.week); if (c.judge) p.set('judge', c.judge); if (c.view) p.set('view', c.view); if (c.subs) p.set('subs', '1'); }
    if (page === 'activity' && o.act) { const a = o.act; if (a.q) p.set('q', a.q); if (a.judge) p.set('judge', a.judge); if (a.kind) p.set('kind', a.kind); if (a.days && a.days !== '7') p.set('days', a.days); }
    if (page === 'compare' && o.cmp && o.cmp.length) path += '/' + o.cmp.join(',');
    if (page === 'court') path += '/' + (o.view || 'orders');
    if (page === 'opinions' && o.f) { const f = o.f; if (f.q) p.set('q', f.q); if (f.judge) p.set('judge', f.judge); if (f.type) p.set('type', f.type); if (f.oc) p.set('oc', f.oc); if (f.pdf) p.set('pdf', '1'); if (f.month) p.set('month', f.month); }
    if (page === 'motions' && o.mt) { if (o.mt.judge) p.set('judge', o.mt.judge); if (o.mt.view && o.mt.view !== 'past') p.set('view', o.mt.view); }
    if (state.period) p.set('period', state.period);
    return '#' + path + (p.toString() ? '?' + p : '');
  }
  const currentHash = () => hashFor(state.page, { caseId: state.caseId, judge: state.judge, cmp: state.cmp, view: state.view, f: state.f, mt: state.mt, q: state.rq, act: state.act, cal: state.cal,
    tab: state.page === 'judge' && (state.pages[state.judge] || { sections: [] }).sections.some((x) => slug(x.title) === state.rtab) ? state.rtab : '' });
  const slug = (t) => String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
    drawHomeCases(); drawHomeNotices();
    $('home-act').classList.add('withjudge');
    $('home-act').replaceChildren(...actItems(activity().rows.slice(0, 8), { judge: true }));
    const recent = recentJudges().filter((c) => S.names[c]);
    $('recent').hidden = !recent.length;
    $('recent').replaceChildren(...(recent.length ? [el('span', { textContent: 'Recently viewed' }), ...recent.map((c) => el('a', { href: judgeHref(c), textContent: S.names[c] }))] : []));
    $('cards').replaceChildren(...judgesAlpha().map((j) => {
      const op = S.opinions.find((r) => r.code === j.code); const or = S.orders.find((r) => r.code === j.code);
      const stat = (label, v, tip) => el('div', { title: tip }, el('span', { textContent: label }), el('b', { textContent: v }));
      return el('a', { className: 'jcard', href: judgeHref(j.code) },
        el('div', { className: 'jc-head' }, el('span', { className: 'jc-name', textContent: j.name }),
          el('span', { className: 'chips' }, sectionOf(j.code) ? el('span', { className: 'code', textContent: 'Sec. ' + sectionOf(j.code), title: 'Section ' + sectionOf(j.code) }) : null, el('span', { className: 'code', textContent: j.code }))),
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
  // When the updater last read the court's feed: data/status.json, rewritten on every check (every 15 minutes), or
  // failing that the latest run in the log. Times are Central, as written by the updater.
  const STALE_MINUTES = 45;
  const ctToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const ctStamp = (iso) => {  // "10:46 AM", or "Oct 18, 10:46 PM" on another day
    const h = +iso.slice(11, 13);
    return (iso.slice(0, 10) === ctToday() ? '' : fmtShort(iso.slice(0, 10)) + ', ') + (h % 12 || 12) + ':' + iso.slice(14, 16) + (h < 12 ? ' AM' : ' PM');
  };
  function lastCheck() {
    const st = state.data.status || {};
    const at = st.checked || state.data.runs.map((r) => String(r.at)).reduce((a, b) => (b > a ? b : a), '');
    if (!at) return null;
    return { at, stamp: ctStamp(at), stale: (Date.now() - Date.parse(at)) / 60000 > STALE_MINUTES, paused: st.cl_paused_until || '', rss: st.rss_items };
  }
  function lastRunText() {
    const c = lastCheck();
    return c ? (c.stale ? 'last feed check ' : 'feed checked ') + c.stamp + ' CT' : '';
  }
  function drawLive() {
    const c = lastCheck(); const S = state.stats;
    $('live').classList.toggle('stale', !!(c && c.stale));
    $('live-text').textContent = c ? (c.stale ? 'Last check ' : 'Checked ') + c.stamp : 'Through ' + fmtShort(S.through);
    $('live').title = (c ? `The court's docket feed was ${c.stale ? 'last ' : ''}read at ${c.stamp} Central. It is read every 15 minutes, around the clock`
      + (c.stale ? '; the next check is overdue. ' : '. ') : '') + 'Orders and opinions are counted through ' + fmtDate(S.through) + '. Open the update log.';
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
    const P = state.pages[code]; const sec = P && P.contact && P.contact.section;
    $('j-section').hidden = !sec; $('j-section').textContent = sec ? 'Section ' + sec : '';
    $('j-full').textContent = P && P.title ? P.title : '';
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

    drawRules(code, name);
    drawJudgeOutcomes(op, name);
    drawJudgeActivity(or, op, name);
    drawJudgeHabits(or, op, name);
    drawJudgeMotions(code);
    drawJudgeCal(code, name);
    $('j-act').replaceChildren(...actItems(activity().rows.filter((r) => r.judge === code).slice(0, 12), { empty: 'No docket activity in this judge\'s cases in the last ' + ACT_DAYS + ' days.' }));
    $('j-act-all').href = hashFor('activity', { act: { judge: code, days: '14' } });
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
        el('td', { className: 'txt' }, caseNumLink(m.case, m.doc)),
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
    const c = lastCheck();
    $('log-status').textContent = (c ? (c.stale ? `The last feed check was at ${c.stamp} CT; the next is overdue. ` : `The feed was last checked at ${c.stamp} CT`
      + (c.rss ? ` (${plural(c.rss, 'item', 'items')} on it)` : '') + '. ') : '')
      + `Orders and opinions are counted through ${fmtDate(state.stats.through)}, the last full CourtListener search`
      + (c && c.paused && c.paused > c.at ? `; CourtListener's rate limits pause its lookups until ${ctStamp(c.paused)} CT. ` : '. ')
      + 'New docket entries show under Activity as soon as a check finds them.';
    $('t-log').replaceChildren(el('thead', {}, el('tr', {}, ...['Run (Central)', 'Orders added', 'Opinions added', 'Note'].map((c, i) => el('th', { textContent: c, className: i === 1 || i === 2 ? 'r' : '' })))),
      el('tbody', {}, ...runs.map((r) => el('tr', {}, el('td', { className: 'mono', textContent: String(r.at).slice(0, 16).replace('T', ' ') }), el('td', { className: 'num', textContent: fmt.int(+r.orders_added || 0) }),
        el('td', { className: 'num', textContent: fmt.int(+r.opinions_added || 0) }), el('td', { className: 'wrap', textContent: r.note || '' })))));
  }

  // ------------------------------------------------------------ docket activity: the court's feed, cleaned up
  // Rows come from data/feed.json (every civil entry the RSS feed showed) merged with the orders, written opinions, and
  // motions already on file, so the page has history from before the feed was kept and opinions carry their links.
  const ACT_DAYS = 14;
  const ACT_KINDS = [['opinion', 'Opinions'], ['order', 'Orders'], ['motion', 'Motions'], ['newcase', 'New cases'], ['hearing', 'Hearings'], ['filing', 'Other filings']];
  const ACT_LABEL = { opinion: 'Opinion', order: 'Order', motion: 'Motion', newcase: 'New case', hearing: 'Hearing', filing: 'Filing' };
  const ORDER_PREFIXES = ['order', 'text order', 'scheduling order', 'judgment', 'set hearings', 'set/reset', '~util', 'terminate hearings', 'terminate deadlines',
    'case transferred out', 'report and recommendations', 'pauper order', 'contempt order', 'certificate of appealability'];
  const splitEvents = (t) => (t || '').split(/\s+AND\s+|\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
  const isOrderEvent = (t) => splitEvents(t).some((e) => ORDER_PREFIXES.some((p) => e.toLowerCase().startsWith(p)));
  // The feed often names a motion by its relief alone ("[Continue]" for a motion to continue, "[Reconsideration]").
  const RELIEF_RE = /^(?:proceed in forma pauperis|continue|expedite|reconsideration|extension of (?:time|deadlines)|leave to (?:file|amend|appeal|proceed)|dismiss|(?:partial )?summary judgment|judgment on the pleadings|compel|protective order|remand|stay|withdraw as attorney|enroll as counsel|substitute attorney|appear pro hac vice|default judgment|entry of default|quash|strike|in limine|exclude|intervene|amend|seal|attorney fees|sanctions|new trial|transfer|consolidate|miscellaneous relief|preliminary injunction|temporary restraining order|reopen|set aside|recuse|sever|bifurcate|certify class|vacate|substitute party|appoint counsel)\b/i;
  const isMotionEvent = (t) => (/^(?:[\w./-]+\s){0,2}motion\s+(?:to|for|in)\b/i.test(t || '') || splitEvents(t).some((e) => RELIEF_RE.test(e)))
    && !/response|reply|opposition|order|notice|memorand|judgment entered/i.test(t || '');
  // The relief a motion asks for, as words an order on it repeats: "Compel" and "Motion to Compel" give ["compel"];
  // "Extension of Deadlines AND Continue" gives ["extension of deadlines", "continue"].
  const reliefKeys = (t) => splitEvents(t).map((e) => {
    const x = e.replace(/^.*?\bmotion\s+(?:to|for|in)\s+/i, '');
    const m = x.match(RELIEF_RE);
    return (m ? m[0] : x.split(/\s+/).slice(0, 3).join(' ')).toLowerCase().trim();
  }).filter(Boolean);
  // A motion's kind, for comparing how long rulings take: the opinion categories (Rule 12, Rule 56, discovery, ...),
  // plus scheduling and procedural motions, which are usually decided by short order.
  const KIND_OF_RELIEF = { compel: 'discovery', quash: 'discovery', 'protective order': 'discovery', remand: 'remand', reconsideration: 'reconsideration',
    stay: 'stay', 'default judgment': 'default', 'entry of default': 'default', 'attorney fees': 'fees', 'in limine': 'limine', exclude: 'daubert',
    'preliminary injunction': 'injunction', 'temporary restraining order': 'injunction', 'summary judgment': 'r56', 'partial summary judgment': 'r56',
    dismiss: 'r12', 'judgment on the pleadings': 'r12' };
  const PROCEDURAL_RE = /^(?:continue|expedite|extension of|leave to|withdraw as attorney|enroll as counsel|substitute attorney|appear pro hac vice|seal|substitute party|proceed in forma pauperis|appoint counsel|amend|consolidate|sever|bifurcate|transfer|reopen|intervene)/;
  function motionKind(t) {
    const keys = reliefKeys(t);
    for (const k of keys) if (KIND_OF_RELIEF[k]) return KIND_OF_RELIEF[k];
    if (/summary judgment/i.test(t || '')) return 'r56';
    if (/\bdismiss|judgment on the pleadings|more definite statement/i.test(t || '')) return 'r12';
    const hit = MCAT_RULES.find(([, re]) => re.test(t || '')); if (hit) return hit[0];
    return keys.some((k) => PROCEDURAL_RE.test(k)) ? 'procedural' : 'othermotion';
  }
  const KIND_LABEL = { ...Object.fromEntries(MCATS), r12: 'motions to dismiss and other Rule 12 motions', r56: 'summary judgment motions', discovery: 'discovery motions',
    daubert: 'Daubert and expert motions', limine: 'motions in limine', injunction: 'injunction and TRO motions', remand: 'motions to remand', reconsideration: 'motions for reconsideration',
    stay: 'motions to stay', default: 'default judgment motions', fees: 'attorney fee motions', procedural: 'scheduling and procedural motions', othermotion: 'other motions' };
  const cleanEvent = (t) => splitEvents(t).map((e) => e.replace(/\s*~Util\s*-\s*/gi, ' · ').replace(/^ · /, '')).join(' · ') || 'Docket entry';
  const actKind = (r) => (r.opinion ? 'opinion' : r.isOrder || isOrderEvent(r.event) ? 'order' : isMotionEvent(r.event) ? 'motion'
    : /^(?:(?:verified|class action|amended)\s+)?complaint\b|^notice of removal|^petition\b/i.test(r.event || '') && !/amended/i.test(r.event || '') ? 'newcase'
      : /hearing|conference|trial|minute entry|oral argument/i.test(r.event || '') ? 'hearing' : 'filing');
  let actCache = null;
  // Docket entries from every source, merged: the feed, orders, written opinions (with their outcome and links), and
  // motions. keep(row) picks the rows (by date for the Activity page, by case for a case page).
  const unEntity = (t) => (t && t.includes('&') ? new DOMParser().parseFromString(t, 'text/html').documentElement.textContent : t);
  function mergeEntries(keep) {
    const D = state.data; const S = state.stats; const feed = D.feed || [];
    const rows = new Map();
    const keyOf = (r) => (r.doc ? r.case + '|' + r.doc : r.case + '||' + r.event + '|' + r.date + (r.time || ''));
    feed.forEach((f) => {
      const r = { date: f.at.slice(0, 10), time: f.at.slice(11, 16), case: f.case, doc: f.doc, event: f.event, title: unEntity(f.title), judge: f.judge, feed: true };
      if (keep(r) && !rows.has(keyOf(r))) rows.set(keyOf(r), r);
    });
    D.orders.forEach((o) => {
      if (!keep(o)) return;
      const r = rows.get(keyOf(o));
      if (r) { r.isOrder = true; r.judge = r.judge || o.judge; r.title = r.title || o.title; if (!r.time && o.time) r.time = o.time; }
      else rows.set(keyOf(o), { date: o.date, time: o.time || '', case: o.case, doc: o.doc, event: o.event, title: o.title, judge: o.judge, isOrder: true });
    });
    const full = new Map(S.recent.map((o) => [o.case + '|' + o.doc, o]));
    D.opinions.forEach((o) => {
      if (!keep(o)) return;
      const op = full.get(o.case + '|' + o.doc) || o; const r = rows.get(keyOf(o));
      if (r) { r.opinion = op; r.judge = r.judge || o.judge; } else rows.set(keyOf(o), { date: o.date, time: '', case: o.case, doc: o.doc, event: o.event, title: o.title, judge: o.judge, opinion: op });
    });
    (D.motions || []).forEach((m) => {
      if (keep(m) && !rows.has(keyOf(m))) rows.set(keyOf(m), { date: m.date, time: m.time || '', case: m.case, doc: m.doc, event: m.event, title: m.title, judge: m.judge });
    });
    const caseJudge = new Map(state.cases.map((c) => [c.case, c.judge]));
    return [...rows.values()].map((r) => ({ ...r, judge: r.judge || caseJudge.get(r.case) || '', kind: actKind(r),
      lt: (r.case + ' ' + (r.title || '') + ' ' + (r.event || '')).toLowerCase() }))
      .sort((a, b) => (b.date + (b.time || '00:00') + b.case + b.doc.padStart(6, '0')).localeCompare(a.date + (a.time || '00:00') + a.case + a.doc.padStart(6, '0')));
  }
  function activity() {
    const D = state.data; const S = state.stats; const feed = D.feed || [];
    if (actCache && actCache.stats === S && actCache.feed === feed) return actCache;
    const latest = [feed.length ? feed[0].at.slice(0, 10) : '', ...D.orders.map((o) => o.date), ...D.opinions.map((o) => o.date), ...(D.motions || []).map((m) => m.date)].reduce((a, b) => (b > a ? b : a), '');
    const floor = addDays(latest, 1 - ACT_DAYS);
    const out = mergeEntries((r) => r.date >= floor);
    const feedStart = feed.length ? feed[feed.length - 1].at.slice(0, 10) : '';
    actCache = { stats: S, feed, rows: out, latest, floor, feedStart };
    return actCache;
  }
  function actRowsEl(rows, opts = {}) {
    if (!rows.length) return [el('li', { className: 'none' }, el('span', { className: 'empty', textContent: opts.empty || 'No docket activity matches.' }))];
    const S = state.stats;
    return rows.map((r) => {
      const ev = el('span', { className: 'ev', textContent: cleanEvent(r.event) });
      if (r.opinion) { const p = outcomePill(r.opinion); if (p) ev.append(p); }
      const pdf = r.opinion && linkKind(r.opinion) === 'pdf' ? el('a', { className: 'tag', href: r.opinion.pdf, target: '_blank', rel: 'noopener noreferrer', textContent: 'PDF', title: 'Open the opinion (PDF)' }) : null;
      return el('li', {},
        el('span', { className: 'tm', textContent: opts.dates ? r.date.slice(5, 7) + '/' + r.date.slice(8, 10) + (r.time ? ' ' + r.time : '') : (r.time || '—'), title: fmtDate(r.date) }),
        el('span', { className: 'kind k-' + r.kind, textContent: ACT_LABEL[r.kind] }),
        ev, el('span', { className: 'cs' }, opts.noCase ? el('span', { className: 'docn', textContent: r.doc ? 'doc ' + r.doc : '' }) : caseNumLink(r.case, r.doc), pdf),
        opts.noCase ? null : el('span', { className: 'nm', textContent: r.title || '', title: r.title || '' }),
        opts.noCase ? null : el('span', { className: 'jg' }, S.names[r.judge] ? el('a', { href: judgeHref(r.judge), textContent: S.names[r.judge] }) : el('span', { className: 'dim', textContent: r.judge || '—', title: r.judge ? 'Not one of the 16 district judges the site covers' : 'Judge not yet known' })));
    });
  }
  function actFilter(A) {
    const F = state.act; const q = F.q.trim().toLowerCase(); const from = addDays(A.latest, 1 - Number(F.days));
    return A.rows.filter((r) => r.date >= from && (!F.judge || r.judge === F.judge) && (!q || q.split(/\s+/).every((w) => r.lt.includes(w))));
  }
  function renderActivity() {
    const S = state.stats; const A = activity(); const F = state.act;
    document.title = 'Docket activity · EDLA Analyzer';
    const js = $('act-judge'); if (js.options.length < 2) js.append(new Option('All judges', ''), ...judgesAlpha().map((j) => new Option(j.name, j.code)));
    js.value = F.judge; $('act-days').value = F.days; if ($('act-q').value !== F.q) $('act-q').value = F.q;
    const base = actFilter(A);
    const counts = Object.fromEntries(ACT_KINDS.map(([k]) => [k, base.filter((r) => r.kind === k).length]));
    $('act-kinds').replaceChildren(...[['', 'All', base.length], ...ACT_KINDS.map(([k, l]) => [k, l, counts[k]])].map(([k, l, n]) => {
      const b = el('button', { type: 'button', className: 'quick' }, l, el('b', { textContent: fmt.int(n) }));
      b.setAttribute('aria-pressed', String(F.kind === k));
      b.addEventListener('click', () => { Object.assign(state.act, { kind: k, limit: 300 }); renderActivity(); writeHash(); });
      return b;
    }));
    const rows = base.filter((r) => !F.kind || r.kind === F.kind);
    const shown = rows.slice(0, F.limit);
    const list = [];
    let day = '';
    const perDay = d3.rollup(rows, (v) => v.length, (r) => r.date);
    shown.forEach((r) => {
      if (r.date !== day) { day = r.date; list.push(el('li', { className: 'day' }, d3.utcFormat('%A, %B %-d')(utc(day)), el('span', { textContent: plural(perDay.get(day), 'entry', 'entries') }))); }
      list.push(...actRowsEl([r]));
    });
    $('act-list').replaceChildren(...(list.length ? list : actRowsEl([], { empty: F.q || F.judge || F.kind ? 'Nothing matches these filters in this period.' : 'No docket activity on file yet.' })));
    $('act-more').hidden = shown.length >= rows.length;
    const chk = lastCheck();
    $('act-live').textContent = chk ? (chk.stale ? 'Last feed check ' : 'Feed checked ') + chk.stamp + ' CT · every 15 minutes' : 'Feed checked every 15 minutes';
    $('act-note').textContent = `The court's feed gives each entry's docket event, not its text, so entries are labeled by event name. `
      + (A.feedStart ? `Every civil entry is on file since ${fmtDate(A.feedStart)}; ` : 'The site has just begun keeping every civil entry; ')
      + `before that, this page lists orders, written opinions, and motions only. Times are Central, when the clerk entered the item. Judges are the district judge on the case in the site's data.`;
  }
  // Panels on the home and judge pages: a date beside each entry rather than day headings.
  const actItems = (rows, opts = {}) => actRowsEl(rows, { ...opts, dates: true });

  // ------------------------------------------------------------ calendar: what each judge has scheduled
  // Sources: data/hearings.json (the court's seven-day calendar and proceedings set in docket text), proceedings held
  // (minute entries in the feed and orders), and motions set for submission. A proceeding on the court's calendar and
  // in a docket entry shows once.
  const CAL_SRC = { court: 'Court calendar', docket: 'Set in a docket entry', held: 'Held (minute entry)', subs: 'Motions set for submission', subday: 'Civil submission day (section calendar)' };
  const HELD_RE = /^(?:(?:telephone|video|in-person|zoom)\s+)?(?:(?:status|scheduling|pretrial|final pretrial|preliminary|settlement|rule 16|discovery)\s+)?conference$|^motion hearing|^(?:jury|bench|non-jury) trial|^oral argument|^evidentiary hearing|^preliminary injunction hearing/i;
  const SETTING_RE = /set hearings|set\/reset hearings|reset hearings|setting\/resetting hearing|order setting|scheduling order/i;
  const mondayOf = (d) => { const x = utc(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x); };
  const shortOf = (c) => { const m = (c || '').match(/:(\d\d)-[a-z]+-0*(\d+)/i); return m ? m[1] + '-' + m[2] : ''; };
  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };
  let calCache = null;
  function calEvents() {
    const D = state.data; const hs = D.hearings || [];
    if (calCache && calCache.h === hs && calCache.feed === D.feed && calCache.stats === state.stats) return calCache;
    const cases = new Map(state.cases.map((c) => [c.case, c]));
    const shortTo = new Map(); state.cases.forEach((c) => { if (/-cv-/.test(c.case) && c.yy && c.num) shortTo.set(c.yy + '-' + c.num, c.case); });
    const ev = []; const byKey = new Map();
    hs.forEach((h) => {
      const cs = h.case || shortTo.get(h.case_short) || ''; const info = cases.get(cs) || {};
      const e = { date: h.date, time: h.time || '', judge: h.judge || info.judge || '', case: cs, short: h.case_short || shortOf(cs), title: h.title || info.title || '',
        what: h.what || 'Proceeding', room: h.room || '', text: h.text || '', src: h.src === 'court_calendar' ? 'court' : 'docket', doc: h.doc || '' };
      const k = e.date + '|' + e.judge + '|' + (e.case || e.short || e.text);
      const prev = byKey.get(k);
      if (prev && !(prev.src === 'docket' && e.src === 'docket' && prev.what !== e.what)) {
        if (prev.src === 'docket' && e.src === 'court') { const doc = prev.doc; Object.assign(prev, e, { alsoDoc: doc }); }
        else if (e.src === 'docket') { prev.alsoDoc = e.doc; if (!prev.time) prev.time = e.time; }
        return;
      }
      byKey.set(k + (prev ? '|' + e.what : ''), e); ev.push(e);
    });
    const A = activity(); const docketDocs = new Set(hs.filter((h) => h.src === 'docket_text').map((h) => h.case + '|' + h.doc));
    const pending = [];
    A.rows.forEach((r) => {
      const first = splitEvents(r.event)[0] || '';
      if (HELD_RE.test(first.replace(/\s*~Util.*$/i, '').trim())) {
        ev.push({ date: r.date, time: '', entered: r.time, judge: r.judge, case: r.case, short: shortOf(r.case), title: r.title, what: first.trim(), room: '', text: cleanEvent(r.event), src: 'held', doc: r.doc });
      }
      if (SETTING_RE.test(r.event || '') && !docketDocs.has(r.case + '|' + r.doc)) pending.push(r);
    });
    const subs = d3.groups((D.motions || []).filter((m) => m.submit && m.judge), (m) => m.judge + '|' + m.submit).map(([k, list]) => {
      const [judge, date] = k.split('|');
      return { date, time: '', judge, case: '', short: '', title: '', what: plural(list.length, 'motion') + ' set for submission', room: '', text: list.map((m) => m.case + ' · ' + m.event).join('\n'), src: 'subs', n: list.length };
    });
    const subdays = Object.entries((D.submission_dates || {}).judges || {}).flatMap(([judge, r]) => (r.dates || []).map((date) => ({
      date, time: (r.time || '').match(/^(\d{1,2}):(\d\d)\s*([AP])M$/i) ? to24(r.time) : '', judge, case: '', short: '', title: '', what: 'Civil submission day', room: '',
      text: 'Section ' + r.section + ': motions noticed for this date are submitted to the judge' + (r.time ? ' at ' + r.time : '') + '.', src: 'subday', url: r.url })));
    const all = ev.concat(subs, subdays).sort((a, b) => (a.date + (a.time || '99') + a.judge).localeCompare(b.date + (b.time || '99') + b.judge));
    const courtDates = hs.filter((h) => h.src === 'court_calendar').map((h) => h.date).sort();
    calCache = { h: hs, feed: D.feed, stats: state.stats, events: all, pending, courtFrom: courtDates[0] || '', courtTo: courtDates[courtDates.length - 1] || '' };
    return calCache;
  }
  function calWeek() {
    const C = state.cal; const E = calEvents();
    const start = C.week || mondayOf(todayIso()); const end = addDays(start, 6);
    const events = E.events.filter((e) => e.date >= start && e.date <= end && (!C.judge || e.judge === C.judge) && (C.subs || (e.src !== 'subs' && e.src !== 'subday')));
    return { start, end, events };
  }
  function calChip(e, opts = {}) {
    const S = state.stats;
    const n = el('div', { className: 'cev src-' + e.src });
    const tip = [e.what + (e.time ? ' · ' + fmtTime(e.time) : ''), e.title || e.case || e.short, e.room ? 'Courtroom ' + e.room : '',
      CAL_SRC[e.src] + (e.src === 'docket' && e.doc ? ', doc ' + e.doc : '') + (e.alsoDoc ? ' · also set in doc ' + e.alsoDoc : ''), e.text && e.src !== 'subs' ? e.text.slice(0, 160) : ''].filter(Boolean);
    n.dataset.tip = tip.join('\n');
    if (!opts.noTime || e.src === 'held') n.append(el('span', { className: 'tm', textContent: e.src === 'held' ? (e.entered ? 'entered ' + fmtTime(e.entered) : 'minute entry') : (fmtTime(e.time) || 'time not listed') }));
    n.append(e.what);
    if (e.case || e.short) {
      n.append(' ', e.case ? el('a', { className: 'cn', href: caseHref(e.case), textContent: e.short || e.case, title: (e.title ? e.title + ' · ' : '') + 'Open the case page' })
        : el('span', { className: 'cn', textContent: e.short, style: 'color:var(--ink-2)' }));
    }
    if (e.src === 'subs') { const a = el('a', { className: 'cn', href: hashFor('motions', { mt: { judge: e.judge, view: 'all' } }), textContent: ' list →' }); n.append(a); }
    if (e.src === 'subday') n.querySelector('.tm') && n.querySelector('.tm').remove();
    return n;
  }
  function renderCalendar() {
    const S = state.stats; const C = state.cal; const E = calEvents(); const W = calWeek();
    document.title = 'Calendar · EDLA Analyzer';
    const view = C.view || (innerWidth < 900 ? 'list' : 'week');
    const js = $('cal-judge'); if (js.options.length < 2) js.append(new Option('All judges', ''), ...judgesAlpha().map((j) => new Option(j.name, j.code)));
    js.value = C.judge; $('cal-subs').checked = C.subs;
    document.querySelectorAll('#cal-view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === view)));
    $('cal-prev').href = hashFor('calendar', { cal: { ...C, week: addDays(W.start, -7) } });
    $('cal-next').href = hashFor('calendar', { cal: { ...C, week: addDays(W.start, 7) } });
    $('cal-today').href = hashFor('calendar', { cal: { ...C, week: '' } });
    $('cal-range').textContent = d3.utcFormat('%b %-d')(utc(W.start)) + ' – ' + d3.utcFormat('%b %-d, %Y')(utc(addDays(W.start, 4)));
    $('cal-legend').replaceChildren(...['court', 'docket', 'held', 'subday', 'subs'].filter((k) => (k !== 'subs' && k !== 'subday') || C.subs).map((k) => el('span', { className: 'ev' }, el('i', { className: 'swatch src-' + k }), CAL_SRC[k])));
    const today = todayIso();
    const days = d3.range(7).map((i) => addDays(W.start, i)).filter((d, i) => i < 5 || W.events.some((e) => e.date === d));
    const codes = C.judge ? [C.judge] : judgesAlpha().map((j) => j.code);
    const unknown = W.events.filter((e) => !S.names[e.judge]);
    $('cal-week-wrap').hidden = view !== 'week'; $('cal-list').hidden = view !== 'list';
    if (view === 'week') {
      const head = el('thead', {}, el('tr', {}, el('th', { textContent: 'Judge' }), ...days.map((d) => el('th', { className: d === today ? 'today' : '', textContent: d3.utcFormat('%a %-m/%-d')(utc(d)) }))));
      const row = (label, list, code) => el('tr', {}, el('td', {}, code ? el('a', { className: 'judge', href: judgeHref(code), textContent: label }) : el('span', { className: 'dim', textContent: label }),
        code && sectionOf(code) ? el('div', { className: 'dim', style: 'font:11px var(--mono)', textContent: 'Sec. ' + sectionOf(code) }) : null),
        ...days.map((d) => { const items = list.filter((e) => e.date === d); return el('td', { className: (d === today ? 'today ' : d < today ? 'past ' : '') + (items.length ? '' : 'empty-day') }, ...(items.length ? items.map(calChip) : ['—'])); }));
      const body = el('tbody', {}, ...codes.map((c) => row(S.names[c], W.events.filter((e) => e.judge === c), c)), ...(unknown.length && !C.judge ? [row('Judge not yet known', unknown, '')] : []));
      $('cal-week').replaceChildren(head, body);
    } else {
      const items = [];
      days.forEach((d) => {
        const list = W.events.filter((e) => e.date === d);
        items.push(el('li', { className: 'day' }, d3.utcFormat('%A, %B %-d')(utc(d)) + (d === today ? ' · today' : ''), el('span', { textContent: list.length ? plural(list.length, 'item') : 'nothing listed' })));
        list.forEach((e) => items.push(el('li', {}, el('span', { className: 'when', textContent: e.src === 'held' ? 'held' : (fmtTime(e.time) || '—') }),
          el('span', { className: 'jn' }, S.names[e.judge] ? el('a', { href: judgeHref(e.judge), textContent: S.names[e.judge] }) : el('span', { className: 'dim', textContent: 'Judge not yet known' })),
          el('span', { className: 'ch' }, calChip(e, { noTime: true })))));
      });
      $('cal-list').replaceChildren(...items);
    }
    const P = E.pending.filter((r) => !C.judge || r.judge === C.judge);
    $('cal-pending-count').textContent = P.length ? plural(P.length, 'entry', 'entries') : '';
    const shownP = state.calAllPending ? P : P.slice(0, 10);
    $('cal-pending').replaceChildren(...actItems(shownP, { judge: true, empty: 'None in the last two weeks.' }),
      ...(P.length > shownP.length ? [el('li', { className: 'none' }, el('button', { type: 'button', className: 'btn ghost', textContent: 'Show all ' + fmt.int(P.length), onclick: () => { state.calAllPending = true; renderCalendar(); } }))] : []));
    const maxDocket = (state.data.hearings || []).filter((h) => h.src === 'docket_text').map((h) => h.date).sort().pop();
    drawSubTable();
    $('cal-note').textContent = (E.courtFrom ? `The court's calendar currently covers ${fmtShort(E.courtFrom)} to ${fmtShort(E.courtTo)}; the court notes that some proceedings are left off it. ` : 'The court\'s calendar has not been read yet. ')
      + (maxDocket ? `Settings read from docket text reach ${fmtDate(maxDocket)}. ` : 'Settings read from docket text appear as entries are read. ')
      + 'Weeks beyond the court\'s calendar show only proceedings set in docket text the site has read, so an empty day does not mean the judge has nothing scheduled. Held proceedings come from minute entries; times there are when the clerk entered them. Criminal matters appear only as the court\'s calendar lists them.';
  }
  function drawJudgeCal(code, name) {
    const today = todayIso();
    const up = calEvents().events.filter((e) => e.judge === code && e.date >= today && e.src !== 'subs' && e.src !== 'subday').slice(0, 8);
    $('j-cal-all').href = hashFor('calendar', { cal: { judge: code } });
    $('j-cal').replaceChildren(...(up.length ? up.map((e) => el('li', {}, el('span', { className: 'when', textContent: d3.utcFormat('%a %-m/%-d')(utc(e.date)) }),
      el('span', {}, calChip(e)))) : [el('li', {}, el('span', { className: 'none', textContent: `Nothing for Judge ${name} on the court's calendar or in docket entries read so far.` }))]),
      ...subDatesItem(code));
  }

  // ------------------------------------------------------------ the judges' requirements, copied from the court's website
  const LOCAL_RULES = 'https://www.laed.uscourts.gov/localrules/localrules.htm';
  const JUDGE_LIST = 'https://www.laed.uscourts.gov/judges-information/district-judges';
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const sectionOf = (code) => ((state.pages[code] || {}).contact || {}).section || '';
  const todayIso = () => iso(new Date());
  // A document or section counts as new for 60 days after the first time the site saw it change, never on the first read.
  const isFresh = (d) => { const since = (state.data.judge_pages || {}).since || ''; return !!d && d > since && d >= addDays(todayIso(), -60); };
  const words = (q) => q.toLowerCase().split(/[^a-z0-9'’&/-]+/i).filter((w) => w.length >= 2);
  // A search word also finds its singular or plural: "copies" finds "copy", "order" finds "orders".
  const wordPattern = (w) => { const e = escapeRe(w); return /ies$/.test(w) ? e.slice(0, -3) + '(?:y|ies)' : /y$/.test(w) ? e.slice(0, -1) + '(?:y|ies)' : /[^s]s$/.test(w) && w.length > 3 ? e.slice(0, -1) + 's?' : e + '(?:s|es)?'; };
  const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segText = (segs) => segs.map((x) => (Array.isArray(x) ? x[0] : x)).join('');
  function marked(text, re) {
    if (!re) return [document.createTextNode(text)];
    const out = []; let last = 0;
    for (const m of text.matchAll(re)) { out.push(document.createTextNode(text.slice(last, m.index)), el('mark', { textContent: m[0] })); last = m.index + m[0].length; }
    out.push(document.createTextNode(text.slice(last)));
    return out;
  }
  function segNodes(segs, re) {
    return segs.flatMap((x) => {
      if (!Array.isArray(x)) return marked(x, re);
      const [text, url] = x;
      if (!SAFE_URL.test(url)) return marked(text, re);
      const a = el('a', { href: url }, ...marked(text, re));
      if (!/^mailto:/i.test(url)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      return [a];
    });
  }
  function blockEl(b, re) {
    const n = el('div', { className: (b.k === 'h' ? 'rb-h' : b.k === 'li' ? 'rb-li' : 'rb-p') + (segText(b.s).includes('\n') ? ' pre' : '') }, ...segNodes(b.s, re));
    if (b.k === 'li') n.style.setProperty('--d', Math.min(4, b.d || 0));
    return n;
  }
  const docKind = (url) => { const m = url.match(/\.([a-z0-9]{2,4})(?:$|[?#])/i); return m ? m[1].toUpperCase() : 'LINK'; };

  function drawRules(code, name) {
    const P = state.pages[code];
    $('j-rules-src').href = P ? P.url : JUDGE_LIST;
    if (!P) {
      $('j-contact').replaceChildren(); $('j-rtabs').replaceChildren(); $('j-docs').replaceChildren();
      $('j-rbody').replaceChildren(el('p', { className: 'empty', textContent: 'The site has not read this judge\'s page on the court\'s website yet. It reads every judge\'s page each day.' }));
      $('j-rules-note').textContent = '';
      return;
    }
    const c = P.contact || {}; const item = (k, v) => el('span', {}, el('b', { textContent: k }), v);
    $('j-contact').replaceChildren(...[
      c.section && item('Section', c.section),
      c.room && item('Chambers', 'Room ' + c.room + ', 500 Poydras St.'),
      c.phone && item('Phone', el('a', { href: 'tel:' + c.phone.replace(/[^\d]/g, ''), textContent: c.phone })),
      c.email && item('Email', el('a', { href: 'mailto:' + c.email, textContent: c.email })),
      c.bio && SAFE_URL.test(c.bio) && item('Biography', el('a', { href: c.bio, target: '_blank', rel: 'noopener noreferrer', textContent: 'Federal Judicial Center ↗' })),
    ].filter(Boolean));
    const secs = P.sections || [];
    if (!secs.some((x) => slug(x.title) === state.rtab)) state.rtab = secs.length ? slug(secs[0].title) : '';
    $('j-rtabs').replaceChildren(...secs.map((x) => {
      const b = el('button', { type: 'button', textContent: x.title }); b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(slug(x.title) === state.rtab));
      if (isFresh(x.changed)) b.append(el('span', { className: 'badge', textContent: 'Updated', title: 'Changed on the court\'s website ' + fmtDate(x.changed) }));
      b.addEventListener('click', () => { state.rtab = slug(x.title); drawRules(code, name); writeHash(); });
      return b;
    }));
    const cur = secs.find((x) => slug(x.title) === state.rtab);
    $('j-rbody').replaceChildren(...(cur ? cur.blocks.map((b) => blockEl(b)) : [el('p', { className: 'rb-p dim' }, `Judge ${name}'s page on the court's website lists no separate practice requirements; it gives the section and chambers contact above. The court's `, el('a', { href: LOCAL_RULES, target: '_blank', rel: 'noopener noreferrer', textContent: 'Local Rules' }), ' apply in every section.')]));
    const docs = P.docs || [];
    $('j-docs').replaceChildren(...(docs.length ? [el('span', { className: 'l', textContent: 'Standing orders and forms posted on the judge\'s page' }), ...docs.filter((d) => SAFE_URL.test(d.url)).map((d) => el('a', { className: 'doc', href: d.url, target: '_blank', rel: 'noopener noreferrer', title: d.title + ' (' + d.section + ')' },
      el('span', { className: 'tag', textContent: docKind(d.url) }), el('span', { className: 'dt', textContent: d.title }), isFresh(d.first_seen) ? el('span', { className: 'badge', textContent: 'New', title: 'First seen ' + fmtDate(d.first_seen) }) : null))] : []));
    $('j-rules-note').textContent = `Copied from the court's website; last checked ${fmtDate(P.checked)}${P.changed ? ', last change found ' + fmtDate(P.changed) : ''}. The court's page controls: check it before filing.`;
  }

  // Blocks on every judge's page that contain all the words of a search.
  function ruleHits(q) {
    const W = words(q).map((w) => new RegExp(wordPattern(w), 'i')); if (!W.length) return [];
    return judgesAlpha().map((j) => {
      const P = state.pages[j.code]; if (!P) return null;
      const hits = [];
      (P.sections || []).forEach((x) => x.blocks.forEach((b) => { const t = segText(b.s); if (W.every((re) => re.test(t))) hits.push({ section: x.title, block: b }); }));
      (P.docs || []).forEach((d) => { const t = d.title + ' ' + decodeURIComponent(d.url); if (W.every((re) => re.test(t))) hits.push({ section: 'Posted documents', block: { k: 'p', d: 0, s: [[d.title, d.url]] } }); });
      return hits.length ? { judge: j, hits } : null;
    }).filter(Boolean);
  }
  const QUICK = ['Courtesy copies', 'Oral argument', 'Continuance', 'Proposed order', 'Page limit', 'Settlement', 'Pretrial', 'Exhibits', 'Jury instructions', 'Email', 'Telephone', 'Sealed'];
  function renderRules() {
    document.title = 'Judges\' requirements · EDLA Analyzer';
    const q = state.rq; const data = state.data.judge_pages || {};
    if ($('rq').value !== q) $('rq').value = q;
    $('rq-quick').replaceChildren(...QUICK.map((t) => { const b = el('button', { type: 'button', className: 'quick', textContent: t }); b.setAttribute('aria-pressed', String(q.toLowerCase() === t.toLowerCase())); b.addEventListener('click', () => { state.rq = t; renderRules(); writeHash(); }); return b; }));
    const box = $('rq-results');
    if (!Object.keys(state.pages).length) { box.replaceChildren(el('p', { className: 'empty pad', textContent: 'The judges\' pages have not been read yet. The site reads them from the court\'s website each day.' })); $('rq-count').textContent = ''; }
    else if (!words(q).length) { box.replaceChildren(el('p', { className: 'cap pad', textContent: 'Type a word or phrase, or pick one of the common searches above, to see every judge\'s exact language on it.' })); $('rq-count').textContent = ''; }
    else {
      const W = words(q); const re = new RegExp(W.map(wordPattern).join('|'), 'gi');
      const res = ruleHits(q);
      $('rq-count').textContent = res.length ? plural(res.length, 'judge') + ' · ' + plural(d3.sum(res, (r) => r.hits.length), 'passage') : '';
      box.replaceChildren(...(res.length ? res.map(({ judge, hits }) => el('div', { className: 'rq-judge' },
        el('div', { className: 'rq-head' }, el('a', { className: 'judge', href: judgeHref(judge.code), textContent: 'Judge ' + judge.name }), sectionOf(judge.code) ? el('span', { textContent: 'Section ' + sectionOf(judge.code) }) : null, el('span', { textContent: plural(hits.length, 'passage') })),
        ...hits.slice(0, 8).map((h) => { const n = el('div', { className: 'rq-hit' }, el('small', {}, el('a', { href: hashFor('judge', { judge: judge.code, tab: h.section === 'Posted documents' ? '' : slug(h.section) }), textContent: h.section })), blockEl(h.block, re)); return n; }),
        hits.length > 8 ? el('p', { className: 'foot-note' }, el('a', { href: judgeHref(judge.code), textContent: (hits.length - 8) + ' more on Judge ' + judge.name + '\'s page →' })) : null))
        : [el('p', { className: 'empty pad', textContent: 'No judge\'s page mentions all of: ' + W.join(', ') + '. Try fewer or shorter words.' })]));
    }
    $('rq-checked').textContent = data.checked ? 'Checked ' + fmtDate(data.checked) : '';
    const head = el('thead', {}, el('tr', {}, ...['Judge', 'Section', 'Requirement tabs on the page', 'Documents', 'Last change found', 'Court page'].map((c, i) => el('th', { textContent: c, className: i === 3 ? 'r' : '' }))));
    const body = el('tbody', {}, ...judgesAlpha().map((j) => {
      const P = state.pages[j.code];
      const tr = el('tr', { className: 'go' }); tr.dataset.href = judgeHref(j.code);
      tr.append(el('td', {}, el('a', { className: 'judge', href: judgeHref(j.code), textContent: j.name })),
        el('td', { className: 'mono', textContent: sectionOf(j.code) || '—' }),
        el('td', { className: 'wrap' }, ...(P ? (P.sections.length ? P.sections.flatMap((x, i) => [i ? ' · ' : '', el('a', { href: hashFor('judge', { judge: j.code, tab: slug(x.title) }), textContent: x.title })]) : [el('span', { className: 'dim', textContent: 'none posted' })]) : [el('span', { className: 'dim', textContent: 'not read yet' })])),
        el('td', { className: 'num', textContent: P ? fmt.int((P.docs || []).length) : '—' }),
        el('td', { className: 'mono', textContent: P && P.changed ? fmtShort(P.changed) : '—' }),
        el('td', { className: 'txt' }, P && SAFE_URL.test(P.url) ? el('a', { href: P.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open ↗' }) : ''));
      return tr;
    }));
    $('t-rules').replaceChildren(head, body);
  }

  // ------------------------------------------------------------ my cases: a page per case, and a watchlist
  // A case page gathers what the site has on one civil case: its judge and the judge's posted requirements, its motions
  // with how long past rulings on that kind of motion took, its settings on the calendar, the judge's written rulings on
  // the same kinds of motion, and every docket entry on file. The watchlist, the last look at each case, and judges
  // picked by hand stay in this browser (localStorage); nothing about them leaves it.
  // "2:24-cv-01933", "24-cv-1933", "24-1933", "24cv1933", and "2:24-cv-01933-WBV-DPC" all give "2:24-cv-01933".
  function normCase(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^(?:(\d):)?(\d{2})[-:]?([a-z]{2})?[-:]?0*(\d{1,5})(?:-[a-z]+)*$/);
    return m ? (m[1] || '2') + ':' + m[2] + '-' + (m[3] || 'cv') + '-' + m[4].padStart(5, '0') : '';
  }
  const caseHref = (id) => '#case/' + id;
  const caseNumLink = (id, doc, cls) => el('a', { className: cls || 'case', href: caseHref(id), textContent: id + (doc ? ' · ' + doc : ''), title: 'Open the case page' });
  const clCase = (id) => CL + '?type=r&court=laed&docket_number=' + encodeURIComponent(id);
  const readJson = (k, empty) => { try { const v = JSON.parse(store.get(k) || 'null'); return v && typeof v === 'object' ? v : empty; } catch (e) { return empty; } };
  const watchList = () => { const w = readJson('edla-watch', []); return Array.isArray(w) ? w.filter((x) => x && normCase(x.case) === x.case) : []; };
  const saveWatch = (w) => store.set('edla-watch', JSON.stringify(w));
  const isWatched = (id) => watchList().some((x) => x.case === id);
  const judgePicks = () => readJson('edla-case-judge', {});
  function setJudgePick(id, code) { const p = judgePicks(); if (code) p[id] = code; else delete p[id]; store.set('edla-case-judge', JSON.stringify(p)); caseCache = null; }
  const stampOf = (r) => r.date + 'T' + (r.time || '00:00');
  function toggleWatch(id) {
    const w = watchList(); const i = w.findIndex((x) => x.case === id);
    if (i >= 0) w.splice(i, 1); else w.unshift({ case: id, added: todayIso(), seen: caseData(id).latest });
    saveWatch(w);
  }
  function markSeen(id, stamp) { const w = watchList(); const x = w.find((y) => y.case === id); if (x && stamp && stamp > (x.seen || '')) { x.seen = stamp; saveWatch(w); } }

  // Everything on file for one case.
  let caseCache = null; const caseMemo = new Map();
  function caseData(id) {
    const D = state.data; const S = state.stats;
    const sig = S === (caseCache && caseCache.S) && D.feed === caseCache.feed && D.hearings === caseCache.h;
    if (!sig) { caseMemo.clear(); caseCache = { S, feed: D.feed, h: D.hearings }; }
    if (caseMemo.has(id)) return caseMemo.get(id);
    const info = state.cases.find((c) => c.case === id) || null;
    const entries = mergeEntries((r) => r.case === id);
    const feedRow = (D.feed || []).find((f) => f.case === id && f.judge);
    const picked = judgePicks()[id] && S.names[judgePicks()[id]] ? judgePicks()[id] : '';
    const known = (info && info.judge) || (feedRow && feedRow.judge) || entries.map((e) => e.judge).find((j) => S.names[j]) || '';
    const cal = calEvents().events.filter((e) => e.case === id && e.src !== 'subs' && e.src !== 'subday');
    const today = ctToday();
    const out = {
      id, info, entries, judge: known || picked, judgePicked: !known && !!picked, title: (info && info.title) || (entries.find((e) => e.title) || {}).title || (cal.find((e) => e.title) || {}).title || '',
      motions: S.allMotions.filter((m) => m.case === id).sort((a, b) => b.date.localeCompare(a.date) || (+b.doc || 0) - (+a.doc || 0)),
      opinions: S.recent.filter((o) => o.case === id),
      upcoming: cal.filter((e) => e.date >= today && e.src !== 'held'), held: cal.filter((e) => e.date < today || e.src === 'held').reverse(),
      latest: entries.length ? stampOf(entries[0]) : '',
    };
    caseMemo.set(id, out);
    return out;
  }

  // How long past rulings took, from a motion's filing to the order deciding it: written opinions with the decided
  // motion's filing date (from CourtListener) and motions seen in the feed with a later order on the same relief.
  let waitCache = null;
  function waitSamples() {
    const S = state.stats; if (waitCache && waitCache.S === S) return waitCache.rows;
    const rows = []; const cited = new Set();
    S.recent.forEach((o) => { if (isMotion(o) && o.days != null && o.days >= 0) { rows.push({ judge: o.judge, kind: o.mcat, days: o.days }); if (o.motionDoc) cited.add(o.case + '|' + o.motionDoc); } });
    S.allMotions.forEach((m) => { if (m.daysToRule != null && m.daysToRule >= 0 && S.names[m.judge] && !cited.has(m.case + '|' + m.doc)) rows.push({ judge: m.judge, kind: m.kind, days: m.daysToRule }); });
    waitCache = { S, rows };
    return rows;
  }
  function waitFor(judge, kind) {
    const R = waitSamples(); const sorted = (f) => R.filter(f).map((r) => r.days).sort((a, b) => a - b);
    const own = sorted((r) => r.judge === judge && r.kind === kind);
    const court = sorted((r) => r.kind === kind);
    const v = own.length >= FEW ? own : court;
    if (v.length < FEW) return { scope: 'none', own: own.length, n: court.length };
    return { scope: v === own ? 'judge' : 'court', own: own.length, n: v.length, med: d3.quantileSorted(v, 0.5), p25: d3.quantileSorted(v, 0.25), p75: d3.quantileSorted(v, 0.75), p90: d3.quantileSorted(v, 0.9) };
  }
  const dayWord = (n) => plural(Math.round(n), 'day');
  function waitBar(age, w, judgeName) {
    const max = Math.max(14, w.p90 || 0, age) * 1.12;
    const pos = (d) => Math.min(100, (d / max) * 100) + '%';
    const track = el('div', { className: 'wb-track' });
    const band = el('i', { className: 'wb-band' + (w.scope === 'court' ? ' court' : '') }); band.style.left = pos(w.p25); band.style.width = 'calc(' + pos(w.p75) + ' - ' + pos(w.p25) + ')';
    const tick = el('i', { className: 'wb-med' + (w.scope === 'court' ? ' court' : '') }); tick.style.left = pos(w.med);
    const now = el('i', { className: 'wb-now' }); now.style.left = pos(age);
    const lab = el('span', { className: 'wb-lab', textContent: 'day ' + fmt.int(age) }); lab.style.left = pos(age);
    if (age / max < 0.06) lab.style.transform = 'translateX(-4px)'; else if (age / max > 0.94) lab.style.transform = 'translateX(-100%)';
    track.append(band, tick, now, lab);
    const who = w.scope === 'judge' ? 'Judge ' + judgeName : 'All judges';
    const tip = `${who}: half of past rulings came within ${dayWord(w.med)} of filing; the middle half took ${fmt.int(Math.round(w.p25))}–${dayWord(w.p75)}. Based on ${plural(w.n, 'ruling')}.`;
    track.dataset.tip = tip;
    return el('div', { className: 'wb' }, track, el('div', { className: 'wb-axis' }, el('span', { textContent: 'filed' }), el('span', { textContent: dayWord(max) })));
  }

  function motionCard(m, C, today) {
    const S = state.stats; const name = S.names[C.judge] || '';
    const age = daysBetween(m.date, today);
    const head = el('div', { className: 'mc-head' },
      el('span', { className: 'mc-ev', textContent: cleanEvent(m.event) }),
      el('span', { className: 'mc-doc', textContent: m.doc ? 'doc ' + m.doc : '' }),
      el('span', { className: 'mc-when', textContent: 'filed ' + fmtShort(m.date) + (m.time ? ' ' + fmtTime(m.time) : '') }));
    const facts = [];
    if (m.submit) facts.push(m.submit >= today ? 'Submission date ' + fmtDate(m.submit) + (m.submit === today ? ' (today)' : ' (in ' + dayWord(daysBetween(today, m.submit)) + ')')
      : 'Submitted ' + fmtDate(m.submit) + ' (' + dayWord(daysBetween(m.submit, today)) + ' ago)');
    else facts.push('Submission date not read yet');
    const card = el('li', { className: 'mc' }, head, el('p', { className: 'mc-facts', textContent: facts.join(' · ') }));
    if (m.ruled) {
      const r = m.ruling; const op = r && C.opinions.find((o) => o.doc === r.doc);
      card.classList.add('done');
      card.append(el('p', { className: 'mc-ruled' }, 'Ruling found ' + fmtDate(m.ruled) + ', ' + dayWord(m.daysToRule) + ' after filing' + (r && r.raw ? ': ' + cleanEvent(r.raw) : ''),
        op ? ' ' : null, op ? outcomePill(op) : null, op && linkKind(op) === 'pdf' ? el('a', { className: 'tag', href: op.pdf, target: '_blank', rel: 'noopener noreferrer', textContent: 'PDF' }) : null));
      return card;
    }
    if (!C.judge) { card.append(el('p', { className: 'mc-wait dim', textContent: 'Pick the judge above to compare with that judge\'s past rulings.' })); return card; }
    const w = waitFor(C.judge, m.kind);
    if (w.scope === 'none') {
      card.append(el('p', { className: 'mc-wait dim', textContent: `Day ${fmt.int(age)} since filing. Too few dated rulings on ${KIND_LABEL[m.kind] || 'this kind of motion'} to compare yet (${fmt.int(w.n)} on file; a comparison needs ${FEW}).` }));
      return card;
    }
    card.append(waitBar(age, w, name), el('p', { className: 'mc-wait' },
      el('b', { textContent: 'Day ' + fmt.int(age) + '.' }), ` ${w.scope === 'judge' ? 'Judge ' + name : 'All judges'}, ${KIND_LABEL[m.kind]}: median ${dayWord(w.med)}, middle half ${fmt.int(Math.round(w.p25))}–${fmt.int(Math.round(w.p75))}. `,
      el('span', { className: 'dim', textContent: plural(w.n, 'past ruling') + (w.scope === 'court' ? `; Judge ${name} has ${fmt.int(w.own)}, fewer than ${FEW}` : '') })));
    return card;
  }

  // Passages of the judge's posted requirements that bear on the case's motions.
  const REQ_TERMS = { r56: ['summary judgment', 'statement of uncontested', 'oral argument', 'page limit'], r12: ['dismiss', 'oral argument', 'page limit'],
    discovery: ['discovery', 'magistrate'], daubert: ['daubert', 'expert'], limine: ['limine'], injunction: ['injunction', 'restraining order'],
    procedural: ['continuance', 'extension', 'proposed order'], reconsideration: ['reconsider'], remand: ['remand'] };
  const REQ_ALWAYS = ['courtesy cop', 'oral argument', 'proposed order', 'memoranda'];
  function reqPassages(code, kinds) {
    const P = state.pages[code]; if (!P) return { hits: [], re: null };
    const terms = [...new Set(kinds.flatMap((k) => REQ_TERMS[k] || []).concat(REQ_ALWAYS))];
    const res = terms.map((t) => new RegExp(words(t).map(wordPattern).join('\\W+'), 'i'));
    const out = [];
    (P.sections || []).forEach((x) => x.blocks.forEach((b) => { if (b.k !== 'h' && res.some((re) => re.test(segText(b.s)))) out.push({ section: x.title, block: b }); }));
    return { hits: out, re: new RegExp(terms.map((t) => words(t).map(wordPattern).join('\\W+')).join('|'), 'gi') };
  }

  // A calendar file (.ics) for settings, which Outlook, Google Calendar, and Apple Calendar all open.
  const ICS_TZ = ['BEGIN:VTIMEZONE', 'TZID:America/Chicago', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT', 'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST', 'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  const icsText = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const icsFold = (line) => { const out = []; let rest = line; while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ' ' + rest.slice(74); } out.push(rest); return out.join('\r\n'); };
  function icsFile(events, name) {
    const S = state.stats; const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EDLA Analyzer//Case settings//EN', 'CALSCALE:GREGORIAN', ...ICS_TZ];
    events.forEach((e) => {
      const d = e.date.replace(/-/g, '');
      const when = e.time ? ['DTSTART;TZID=America/Chicago:' + d + 'T' + e.time.replace(':', '') + '00', 'DURATION:PT1H'] : ['DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + addDays(e.date, 1).replace(/-/g, '')];
      const src = e.src === 'court' ? 'the court\'s calendar' : 'docket entry' + (e.doc ? ' ' + e.doc : '');
      lines.push('BEGIN:VEVENT', 'UID:' + (e.case + '-' + e.date + '-' + (e.time || '') + '-' + e.what).replace(/[^\w-]/g, '') + '@edla-analyzer', 'DTSTAMP:' + stamp, ...when,
        'SUMMARY:' + icsText(e.what + ' · ' + (e.short || e.case) + (e.title ? ' ' + e.title : '')),
        'LOCATION:' + icsText((e.room ? 'Courtroom ' + e.room + ', ' : '') + 'U.S. District Court, 500 Poydras St., New Orleans'),
        'DESCRIPTION:' + icsText((S.names[e.judge] ? 'Judge ' + S.names[e.judge] + '. ' : '') + 'From ' + src + ', as read by EDLA Analyzer. Confirm on the docket.'), 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    const a = el('a', { href: URL.createObjectURL(new Blob([lines.map(icsFold).join('\r\n') + '\r\n'], { type: 'text/calendar' })), download: name + '.ics' });
    document.body.append(a); a.click(); a.remove();
  }

  function settingRow(e, opts = {}) {
    return el('li', {}, el('span', { className: 'when', textContent: d3.utcFormat('%a %-m/%-d')(utc(e.date)) }),
      el('span', {}, el('span', { className: 'what', textContent: e.what }), e.time ? el('span', { className: 'dim', textContent: ' · ' + fmtTime(e.time) }) : null,
        el('p', { className: 'sub', textContent: [e.room ? 'Courtroom ' + e.room : '', CAL_SRC[e.src] + (e.src === 'docket' && e.doc ? ', doc ' + e.doc : '')].filter(Boolean).join(' · ') }),
        opts.ics ? el('p', { className: 'sub' }, el('button', { type: 'button', className: 'linklike', textContent: '+ Add to calendar', title: 'Download a calendar file (.ics) for this setting', onclick: () => icsFile([e], 'setting-' + e.date + '-' + slug(e.what)) })) : null));
  }

  // ---- the case page
  function renderCase() {
    const S = state.stats; const id = state.caseId; const C = caseData(id); const today = ctToday();
    const name = S.names[C.judge] || '';
    const w = watchList().find((x) => x.case === id);
    if (!state.caseSeen || state.caseSeen.id !== id) state.caseSeen = { id, prev: w ? w.seen || '' : '' };
    const prev = state.caseSeen.prev;
    if (w) markSeen(id, C.latest);
    document.title = (C.title || id) + ' · EDLA Analyzer';
    $('c-crumb').textContent = id;
    $('c-title').textContent = C.title || 'Case ' + id;
    $('c-num').textContent = id;
    $('c-judge').replaceChildren(...(C.judge ? [el('a', { href: judgeHref(C.judge), textContent: 'Judge ' + name }), sectionOf(C.judge) ? ' · Section ' + sectionOf(C.judge) : '',
      C.judgePicked ? el('span', { className: 'dim' }, ' · picked by you ', el('button', { type: 'button', className: 'linklike', textContent: 'change', onclick: () => { setJudgePick(id, ''); renderCase(); } })) : '']
      : [judgePicker(id)]));
    const wbtn = $('c-watch'); const on = !!w;
    wbtn.setAttribute('aria-pressed', String(on)); wbtn.textContent = on ? '★ Watching' : '☆ Watch this case';
    wbtn.title = on ? 'Stop watching this case' : 'Keep this case on your list, with new entries marked';
    $('c-cl').href = clCase(id);
    const K = docketOf(id) || {};
    const facts = [K.referred ? 'Magistrate Judge ' + K.referred.replace(/^(?:magistrate\s+judge\s+)/i, '') : '', K.nos ? 'Nature of suit: ' + K.nos : '', K.cause ? 'Cause: ' + K.cause : '',
      K.jury ? 'Jury demand: ' + K.jury : '', K.filed ? 'Filed ' + fmtDate(K.filed) : '', K.terminated ? 'Terminated ' + fmtDate(K.terminated) : ''].filter(Boolean);
    $('c-facts').textContent = facts.join(' · ');
    $('c-facts').hidden = !facts.length;
    const moved = (K.reassigned || []).filter((x) => S.names[x.from] || S.names[x.to]);
    $('c-reassigned').hidden = !moved.length;
    $('c-reassigned').textContent = moved.map((x) => 'Reassigned from Judge ' + (S.names[x.from] || x.from) + ' to Judge ' + (S.names[x.to] || x.to) + ' (seen ' + fmtDate(x.date) + ')').join(' · ');
    const att = K.attorneys || []; const firms = K.firms || []; const parties = K.parties || [];
    $('c-counsel').replaceChildren(...(att.length || parties.length ? [
      parties.length ? el('div', { className: 'cn-group' }, el('b', { textContent: 'Parties' }), el('span', { textContent: parties.join(' · ') })) : null,
      att.length ? el('div', { className: 'cn-group' }, el('b', { textContent: 'Attorneys' }), el('span', { textContent: att.join(' · ') })) : null,
      firms.length ? el('div', { className: 'cn-group' }, el('b', { textContent: 'Firms' }), el('span', { textContent: firms.join(' · ') })) : null,
      el('p', { className: 'foot-note', textContent: 'As CourtListener lists them' + (K.seen ? ', read ' + fmtDate(K.seen) : '') + '. CourtListener does not say which attorney represents which party here; check the docket.' })]
      : [el('p', { className: 'dim', textContent: K.case ? 'CourtListener lists no counsel for this case yet. It has counsel only for dockets someone has bought from PACER with the parties included.' : 'The site has not read this case\'s docket details from CourtListener yet. They are read as the case appears in the site\'s periodic searches.' })]));
    $('c-cl2').href = K.docket_id ? CL + 'docket/' + K.docket_id + '/' : clCase(id); $('c-cl2').textContent = 'CourtListener ↗';
    const ap = appealsOf(id);
    $('c-appeals-panel').hidden = !ap.length;
    $('c-appeals').replaceChildren(...ap.map((a) => el('li', {}, el('span', { className: 'd', textContent: fmtShort(a.date) }),
      el('span', { className: 'h' }, el('b', { textContent: a.disposition || 'Decided' }), el('a', { className: 'nt', href: a.pdf, target: '_blank', rel: 'noopener noreferrer', textContent: (a.kind || 'Opinion') + ' ↗' })),
      el('span', { className: 'c', textContent: 'Fifth Circuit No. ' + a.ca5 + ' · ' + a.caption }))));
    const pending = C.motions.filter((m) => !m.ruled); const decided = C.motions.filter((m) => m.ruled);
    const next = C.upcoming[0];
    const newCount = prev ? C.entries.filter((e) => stampOf(e) > prev).length : 0;
    $('c-kpis').replaceChildren(
      kpi({ label: 'Pending motions', value: fmt.int(pending.length), sub: pending.length ? 'oldest filed ' + fmtShort(pending[pending.length - 1].date) : C.motions.length ? 'all with a ruling found' : 'none on file', href: '#c-motions' }),
      next ? kpi({ label: 'Next setting', value: d3.utcFormat('%b %-d')(utc(next.date)), unit: next.time ? fmtTime(next.time) : '', sub: next.what, href: '#c-cal' })
        : kpi({ label: 'Next setting', value: 'None found', na: true, sub: 'on the court\'s calendar or in docket text read so far', href: '#c-cal' }),
      kpi({ label: 'Latest entry', value: C.entries.length ? d3.utcFormat('%b %-d')(utc(C.entries[0].date)) : '—', sub: C.entries.length ? cleanEvent(C.entries[0].event) : 'nothing on file yet', href: '#c-docket' }),
      kpi({ label: 'Written opinions', value: fmt.int(C.opinions.length), sub: C.opinions.length ? 'latest ' + fmtShort(C.opinions[0].date) : 'none in this case yet', href: '#c-docket' }),
      kpi({ label: w ? 'New since your last look' : 'Entries on file', value: fmt.int(w ? newCount : C.entries.length), sub: w ? (prev ? 'entries after ' + ctStamp(prev) : 'your first look')  : 'orders, opinions, motions, filings', href: '#c-docket' }));
    $('c-empty').hidden = C.entries.length > 0 || C.upcoming.length > 0;
    $('c-empty').textContent = `The site has nothing on file for ${id} yet. It keeps every civil entry in the court's feed from ${fmtDate((state.data.feed || []).map((f) => f.at.slice(0, 10)).sort()[0] || todayIso())}, civil orders from ${fmtDate(S.since.orders)}, and written opinions from ${fmtDate(S.since.opinions)}, so a case with no entry since then shows nothing. Check the number, or watch the case: its entries appear here as they are filed.`;

    // Motions
    $('c-mcount').textContent = C.motions.length ? plural(pending.length, 'pending motion') + (decided.length ? ' · ' + fmt.int(decided.length) + ' with a ruling' : '') : '';
    const mlist = [...pending.map((m) => motionCard(m, C, today)), ...decided.slice(0, state.caseAllDecided ? 99 : 3).map((m) => motionCard(m, C, today))];
    $('c-motion-list').replaceChildren(...(mlist.length ? mlist : [el('li', { className: 'mc none' }, el('p', { className: 'dim', textContent: `No motions on file for this case. The site records motions from the court's feed as they are filed (since ${fmtDate(S.motionsSince || todayIso())}).` }))]),
      ...(decided.length > 3 && !state.caseAllDecided ? [el('li', { className: 'mc none' }, el('button', { type: 'button', className: 'btn ghost', textContent: 'Show all ' + decided.length + ' with a ruling', onclick: () => { state.caseAllDecided = true; renderCase(); } }))] : []));
    $('c-motion-note').textContent = 'Each bar counts days from the motion\'s filing (▲ is today). The shaded span is the middle half of past rulings on the same kind of motion, from filing to the order deciding it, and the tick is the median: the judge\'s own rulings when there are at least ' + FEW + ', otherwise all judges\' (gray). Past rulings are written opinions whose motion has a known filing date and motions seen in the feed with a later order on the same relief. The bars describe how long past rulings took; they do not predict this one. "Ruling found" means a later order in the case names the same relief.';

    // Docket entries
    const shown = C.entries.slice(0, state.caseAll ? 2000 : 40);
    const items = []; let day = '';
    shown.forEach((r) => {
      if (r.date !== day) { day = r.date; items.push(el('li', { className: 'day' }, d3.utcFormat('%A, %B %-d, %Y')(utc(day)))); }
      const li = actRowsEl([r], { noCase: true })[0];
      if (prev && stampOf(r) > prev) { li.classList.add('new'); li.querySelector('.ev').append(el('span', { className: 'badge', textContent: 'New' })); }
      items.push(li);
    });
    $('c-docket-list').replaceChildren(...(items.length ? items : actRowsEl([], { empty: 'No docket entries on file for this case yet.' })));
    $('c-dcount').textContent = C.entries.length ? plural(C.entries.length, 'entry', 'entries') + ' on file' : '';
    $('c-more').hidden = shown.length >= C.entries.length; $('c-more').textContent = 'Show all ' + fmt.int(C.entries.length);
    $('c-docket-note').textContent = 'Entries the site has seen: every civil entry in the court\'s feed for the last 14 days, and orders, written opinions, and motions from when the site began recording them. It is not the full docket; open the case on CourtListener or PACER for that.';

    // Comparable rulings
    const kinds = [...new Set((pending.length ? pending : C.motions).map((m) => m.kind))].filter((k) => mcatLabel[k] && k !== 'othermotion');
    const opts = (kinds.length ? kinds : ['r12', 'r56']);
    if (!opts.includes(state.caseKind)) state.caseKind = opts[0];
    $('c-cmp-h').textContent = name ? `Judge ${name}'s written rulings on similar motions` : 'Written rulings on similar motions';
    $('c-cmp-kinds').replaceChildren(...opts.map((k) => { const b = el('button', { type: 'button', className: 'quick', textContent: mcatLabel[k] }); b.setAttribute('aria-pressed', String(k === state.caseKind)); b.addEventListener('click', () => { state.caseKind = k; renderCase(); }); return b; }));
    const comp = C.judge ? S.recent.filter((o) => o.judge === C.judge && o.mcat === state.caseKind && o.case !== id) : [];
    $('c-cmp').replaceChildren(...(comp.length ? comp.slice(0, 8).map((o) => el('li', {},
      el('span', { className: 'd', textContent: fmtShort(o.date) }),
      el('span', { className: 'h' }, el('span', {}, ...caseLink(o)), outcomePill(o)),
      el('span', { className: 'e', textContent: o.event }),
      el('span', { className: 'c', textContent: o.title, title: o.title })))
      : [el('li', {}, el('span', { className: 'empty', textContent: C.judge ? `No written opinions by Judge ${name} on ${(KIND_LABEL[state.caseKind] || 'these motions')} in the period.` : 'Pick the judge to see that judge\'s rulings.' }))]));
    $('c-cmp-all').hidden = !C.judge; $('c-cmp-all').href = findHref({ judge: C.judge, type: state.caseKind });
    $('c-cmp-all').textContent = comp.length > 8 ? 'All ' + fmt.int(comp.length) + ' in the opinion search →' : 'Open in the opinion search →';

    // Calendar
    $('c-cal-list').replaceChildren(...(C.upcoming.length ? C.upcoming.map((e) => settingRow(e, { ics: true }))
      : [el('li', {}, el('span', { className: 'none', textContent: 'No upcoming settings found on the court\'s calendar or in the docket text read so far.' }))]),
      ...(C.held.length ? [el('li', { className: 'day' }, 'Earlier'), ...C.held.slice(0, 5).map((e) => settingRow(e))] : []));
    $('c-cal-list').append(...(C.judge ? subDatesItem(C.judge) : []));
    const ics = $('c-ics'); ics.hidden = !C.upcoming.length; ics.onclick = () => icsFile(C.upcoming, 'settings-' + id.replace(/:/g, '-'));
    $('c-cal-all').href = hashFor('calendar', { cal: { judge: C.judge } });

    // Requirements
    const P = C.judge ? state.pages[C.judge] : null;
    $('c-req-src').href = P ? P.url : JUDGE_LIST; $('c-req-src').hidden = !C.judge;
    const req = $('c-req');
    if (!C.judge) req.replaceChildren(el('p', { className: 'dim', textContent: 'Pick the judge to see the judge\'s chambers contact and posted requirements.' }));
    else if (!P) req.replaceChildren(el('p', { className: 'dim', textContent: 'The site has not read this judge\'s page on the court\'s website yet.' }));
    else {
      const c = P.contact || {};
      const contact = el('div', { className: 'contact' }, ...[c.section && el('span', {}, el('b', { textContent: 'Section' }), c.section),
        c.phone && el('span', {}, el('b', { textContent: 'Phone' }), el('a', { href: 'tel:' + c.phone.replace(/[^\d]/g, ''), textContent: c.phone })),
        c.email && el('span', {}, el('b', { textContent: 'Email' }), el('a', { href: 'mailto:' + c.email, textContent: c.email }))].filter(Boolean));
      const { hits, re } = (P.sections || []).length ? reqPassages(C.judge, kinds.concat(pending.map((m) => m.kind))) : { hits: [] };
      const tabs = (P.sections || []).map((x) => el('a', { className: 'quick', href: hashFor('judge', { judge: C.judge, tab: slug(x.title) }), textContent: x.title }));
      req.replaceChildren(contact,
        ...(P.sections || []).length ? [
          hits.length ? el('p', { className: 'cap', textContent: 'Passages that bear on this case\'s motions and on submitting papers:' }) : el('p', { className: 'cap', textContent: 'No passage on these motions; the judge\'s requirement tabs:' }),
          ...hits.slice(0, 5).map((h) => el('div', { className: 'rq-hit' }, el('small', {}, el('a', { href: hashFor('judge', { judge: C.judge, tab: slug(h.section) }), textContent: h.section })), blockEl(h.block, re))),
          el('div', { className: 'chips' }, ...tabs)]
          : [el('p', { className: 'cap' }, `Judge ${name}'s page lists no separate practice requirements. The court's `, el('a', { href: LOCAL_RULES, target: '_blank', rel: 'noopener noreferrer', textContent: 'Local Rules' }), ' apply.')]);
    }
  }
  function judgePicker(id) {
    const sel = el('select', {}, new Option('Judge not yet known: pick one', ''), ...judgesAlpha().map((j) => new Option('Judge ' + j.name, j.code)));
    sel.setAttribute('aria-label', 'Pick the judge');
    sel.addEventListener('change', () => { setJudgePick(id, sel.value); renderCase(); });
    return el('span', { className: 'pick' }, sel);
  }

  // ---- the My cases page: look up a case, and the watchlist
  function caseMatches(q) {
    const t = q.trim(); if (!t) return [];
    const cq = caseQuery(t); const lc = t.toLowerCase();
    let list = cq ? state.cases.filter((c) => c.num === cq.num && (!cq.yy || c.yy === cq.yy)) : [];
    if (!list.length && cq && cq.num.length >= 3) list = state.cases.filter((c) => c.num.startsWith(cq.num) && (!cq.yy || c.yy === cq.yy));
    if (!cq && lc.length >= 2) list = state.cases.filter((c) => lc.split(/\s+/).every((w) => c.lt.includes(w)));
    list = list.slice().sort((a, b) => b.last.localeCompare(a.last)).slice(0, 8);
    const id = normCase(t);
    if (id && !list.some((c) => c.case === id)) list.push({ case: id, title: '', judge: '', last: '', missing: true });
    return list;
  }
  function drawLookup() {
    const S = state.stats; const q = $('cl-q').value; const list = caseMatches(q);
    state.lookActive = Math.min(state.lookActive || 0, Math.max(0, list.length - 1));
    $('cl-results').hidden = !q.trim();
    $('cl-results').replaceChildren(...(list.length ? list.map((c, i) => {
      const a = el('a', { className: 'opt', href: caseHref(c.case) }, el('span', { className: 'k', textContent: 'Case' }),
        el('span', {}, el('span', { className: 'l' }, el('code', { textContent: c.case }), c.title ? ' ' + c.title : ''),
          el('span', { className: 's', textContent: c.missing ? 'Nothing on file yet: open it anyway, or watch it' : (S.names[c.judge] ? 'Judge ' + S.names[c.judge] : 'Judge not yet known') + ' · latest entry ' + fmtShort(c.last) })));
      a.setAttribute('aria-selected', String(i === state.lookActive));
      return a;
    }) : [el('div', { className: 'opt-empty', textContent: 'No case on file matches. Type a case number like 24-1933 or 2:24-cv-01933, or a party name.' })]));
    state.lookList = list;
  }
  function renderCases() {
    const S = state.stats; const W = watchList();
    document.title = 'My cases · EDLA Analyzer';
    if (state.importNote) { $('cl-note').textContent = state.importNote; $('cl-note').hidden = false; state.importNote = ''; } else $('cl-note').hidden = true;
    drawLookup();
    const rows = W.map((w) => ({ w, C: caseData(w.case) }));
    const fresh = rows.flatMap(({ w, C }) => C.entries.filter((e) => w.seen && stampOf(e) > w.seen).map((e) => ({ ...e, C })));
    $('cw-count').textContent = W.length ? plural(W.length, 'case') : '';
    $('cw-empty').hidden = W.length > 0;
    $('cw-table').hidden = !W.length; $('cw-tools').hidden = !W.length;
    if (!W.length) {
      const busy = state.cases.filter((c) => S.names[c.judge] && /-cv-/.test(c.case)).sort((a, b) => b.last.localeCompare(a.last) || (b.orders + b.opinions) - (a.orders + a.opinions)).slice(0, 4);
      $('cw-examples').replaceChildren(...busy.map((c) => el('a', { className: 'quick', href: caseHref(c.case), textContent: c.case + (c.title ? ' · ' + c.title.slice(0, 28) : '') })));
    }
    const head = el('thead', {}, el('tr', {}, ...['Case', 'Name', 'Judge', 'New', 'Pending motions', 'Next setting', 'Latest entry', ''].map((c, i) => el('th', { textContent: c, className: i === 3 || i === 4 ? 'r' : '' }))));
    const body = el('tbody', {}, ...rows.sort((a, b) => b.C.latest.localeCompare(a.C.latest)).map(({ w, C }) => {
      const n = w.seen ? C.entries.filter((e) => stampOf(e) > w.seen).length : 0;
      const pend = C.motions.filter((m) => !m.ruled).length; const nx = C.upcoming[0];
      const tr = el('tr', { className: 'go' + (n ? ' has-new' : '') }); tr.dataset.href = caseHref(C.id);
      tr.append(el('td', { className: 'txt' }, caseNumLink(C.id, '', 'case')),
        el('td', { className: 'wrap', textContent: C.title || '—' }),
        el('td', { className: 'txt' }, S.names[C.judge] ? el('a', { className: 'judge', href: judgeHref(C.judge), textContent: S.names[C.judge] }) : el('span', { className: 'dim', textContent: 'not yet known' })),
        el('td', { className: 'num' }, n ? el('span', { className: 'badge', textContent: fmt.int(n) + ' new' }) : el('span', { className: 'dim', textContent: '—' })),
        el('td', { className: 'num' + (pend ? '' : ' dim'), textContent: pend ? fmt.int(pend) : '—' }),
        el('td', { className: 'mono' + (nx ? '' : ' dim'), textContent: nx ? d3.utcFormat('%b %-d')(utc(nx.date)) + (nx.time ? ' ' + fmtTime(nx.time) : '') + ' · ' + nx.what : '—' }),
        el('td', { className: 'mono' + (C.entries.length ? '' : ' dim'), textContent: C.entries.length ? fmtShort(C.entries[0].date) + ' · ' + cleanEvent(C.entries[0].event) : 'nothing on file' }),
        el('td', { className: 'txt' }, el('button', { type: 'button', className: 'btn ghost', textContent: 'Remove', title: 'Stop watching ' + C.id, onclick: (e) => { e.stopPropagation(); toggleWatch(C.id); renderCases(); } })));
      return tr;
    }));
    $('cw-table').replaceChildren(head, body);
    $('cw-new-panel').hidden = !fresh.length;
    fresh.sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
    $('cw-new-count').textContent = fresh.length ? plural(fresh.length, 'new entry', 'new entries') : '';
    $('cw-new').replaceChildren(...actRowsEl(fresh.slice(0, 40), { dates: true }));
    const upcoming = rows.flatMap(({ C }) => C.upcoming).sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
    $('cw-ics').hidden = !upcoming.length; $('cw-ics').onclick = () => icsFile(upcoming, 'my-cases-settings');
    $('cw-ics').textContent = upcoming.length ? 'Add ' + plural(upcoming.length, 'setting') + ' to calendar' : '';
  }
  function importWatch(list) {
    const w = watchList(); let added = 0;
    list.map(normCase).filter(Boolean).forEach((id) => { if (!w.some((x) => x.case === id)) { w.push({ case: id, added: todayIso(), seen: '' }); added += 1; } });
    saveWatch(w);
    return added;
  }
  // On the home page, the watched cases with something new.
  function drawHomeCases() {
    const W = watchList(); const box = $('home-cases');
    box.hidden = !W.length; if (!W.length) return;
    const rows = W.map((w) => { const C = caseData(w.case); return { C, n: w.seen ? C.entries.filter((e) => stampOf(e) > w.seen).length : 0 }; })
      .sort((a, b) => b.n - a.n || b.C.latest.localeCompare(a.C.latest)).slice(0, 6);
    $('home-cases-list').replaceChildren(...rows.map(({ C, n }) => el('li', {}, caseNumLink(C.id, '', 'case'), el('span', { className: 'nm', textContent: C.title || '' }),
      n ? el('span', { className: 'badge', textContent: n + ' new' }) : el('span', { className: 'dim', textContent: C.entries.length ? fmtShort(C.entries[0].date) : '' }))));
  }

  // ------------------------------------------------------------ court information: submission days, notices, appeals
  // data/submission_dates.json (each section's civil submission calendar, read daily), data/notices.json (the court's
  // news feed and General Orders page), data/appeals.json (Fifth Circuit decisions in civil cases from this court), and
  // data/dockets.json (docket details from CourtListener: magistrate judge, nature of suit, counsel when listed).
  const to24 = (t) => { const m = String(t).match(/^(\d{1,2}):(\d\d)\s*([AP])M$/i); if (!m) return ''; const h = (+m[1] % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0); return String(h).padStart(2, '0') + ':' + m[2]; };
  const subDates = (code) => ((state.data.submission_dates || {}).judges || {})[code] || null;
  const nextSubDates = (code, n) => { const r = subDates(code); return r ? (r.dates || []).filter((d) => d >= ctToday()).slice(0, n) : []; };
  function subDatesItem(code) {
    const r = subDates(code); const next = nextSubDates(code, 4);
    if (!r || !next.length) return [];
    return [el('li', { className: 'subdays' }, el('span', { className: 'when', textContent: 'Submission' }),
      el('span', {}, el('span', { className: 'what', textContent: 'Next civil submission dates: ' + next.map((d) => d3.utcFormat('%b %-d')(utc(d))).join(' · ') }),
        el('p', { className: 'sub' }, (r.day ? r.day + (r.time ? ', ' + r.time : '') + ' · ' : '') + 'Section ' + r.section + ' · ', el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'court\'s list ↗' }))))];
  }
  function drawSubTable() {
    const S = state.stats; const J = (state.data.submission_dates || {}).judges || {};
    const box = $('cal-subtable'); box.closest('.panel').hidden = !Object.keys(J).length;
    if (!Object.keys(J).length) return;
    const head = el('thead', {}, el('tr', {}, ...['Judge', 'Section', 'Day', 'Next civil submission dates', 'Court\'s list'].map((c) => el('th', { textContent: c }))));
    const body = el('tbody', {}, ...judgesAlpha().filter((j) => J[j.code]).map((j) => { const r = J[j.code];
      return el('tr', {}, el('td', {}, el('a', { className: 'judge', href: judgeHref(j.code), textContent: j.name })), el('td', { className: 'mono', textContent: r.section }),
        el('td', { className: 'mono', textContent: ((r.day || '').replace(/s$/, '') || (r.dates && r.dates[0] ? d3.utcFormat('%A')(utc(r.dates[0])) : '')) + (r.time ? ' ' + r.time : '') }),
        el('td', { className: 'mono', textContent: nextSubDates(j.code, 5).map((d) => d3.utcFormat('%b %-d')(utc(d))).join(' · ') || '—' }),
        el('td', { className: 'txt' }, el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open ↗' }))); }));
    box.replaceChildren(head, body);
    const upd = Object.values(J).map((r) => r.updated).filter(Boolean)[0];
    $('cal-sub-note').textContent = 'Each section\'s civil motion submission dates, from the calendars the court posts for each judge' + (upd ? ' (court update ' + upd + ')' : '') + '. Under Local Rule 7.2 a civil motion is noticed for one of these dates. Read once a day; the court\'s list controls.';
  }

  // Docket details from CourtListener for one case.
  const docketOf = (id) => (state.data.dockets || []).find((r) => r.case === id) || null;
  const appealsOf = (id) => ((state.data.appeals || {}).appeals || []).filter((a) => a.case === id);

  // Court notices: news, general orders, and Fifth Circuit decisions, newest first.
  function noticeRows() {
    const N = state.data.notices || {};
    const rows = (N.news || []).map((n) => ({ date: n.date, kind: 'News', title: n.title, url: n.url, sub: n.summary, fresh: n.first_seen }))
      .concat((N.orders || []).map((o) => ({ date: o.date, kind: 'General order', title: o.title, url: o.url, sub: o.category, fresh: o.first_seen })))
      .concat(((state.data.appeals || {}).appeals || []).map((a) => ({ date: a.date, kind: 'Fifth Circuit', title: (a.disposition || 'Decided') + ' · ' + a.caption, url: a.pdf,
        sub: 'No. ' + a.ca5 + ' · ' + (a.kind || 'Opinion') + ' · from ', caseId: a.case })));
    return rows.filter((r) => r.date).sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
  }
  function noticeItem(r) {
    return el('li', {}, el('span', { className: 'd', textContent: fmtShort(r.date) }),
      el('span', { className: 'h' }, el('span', { className: 'kind k-notice', textContent: r.kind }),
        el('a', { className: 'nt', href: r.url, target: '_blank', rel: 'noopener noreferrer', textContent: r.title }), isFresh(r.fresh) ? el('span', { className: 'badge', textContent: 'New' }) : null),
      r.sub ? el('span', { className: 'c' }, (r.sub || '').slice(0, 220), r.caseId ? caseNumLink(r.caseId, '', 'case') : null) : null);
  }
  function drawHomeNotices() {
    const rows = noticeRows().filter((r) => r.date >= addDays(ctToday(), -90)).slice(0, 5);
    $('home-notices').closest('.panel').hidden = !rows.length;
    $('home-notices').replaceChildren(...rows.map(noticeItem));
  }
  function renderNotices() {
    document.title = 'Court notices · EDLA Analyzer';
    const N = state.data.notices || {}; const A = (state.data.appeals || {}).appeals || [];
    $('nt-news').replaceChildren(...((N.news || []).length ? N.news.slice(0, 30).map((n) => noticeItem({ date: n.date, kind: 'News', title: n.title, url: n.url, sub: n.summary, fresh: n.first_seen }))
      : [el('li', {}, el('span', { className: 'empty', textContent: 'The court\'s news feed has not been read yet.' }))]));
    const groups = d3.groups(N.orders || [], (o) => o.category);
    $('nt-orders').replaceChildren(...(groups.length ? groups.flatMap(([cat, list]) => [el('li', { className: 'grp' }, el('span', { textContent: cat || 'General orders' }), el('span', { className: 'n', textContent: plural(list.length, 'order') })),
      ...list.map((o) => noticeItem({ date: o.date, kind: 'Order', title: o.title, url: o.url, fresh: o.first_seen }))])
      : [el('li', {}, el('span', { className: 'empty', textContent: 'The General Orders page has not been read yet.' }))]));
    $('nt-appeals').replaceChildren(...(A.length ? A.map((a) => el('li', {}, el('span', { className: 'd', textContent: fmtShort(a.date) }),
      el('span', { className: 'h' }, el('b', { textContent: a.disposition || 'Decided' }), el('a', { className: 'nt', href: a.pdf, target: '_blank', rel: 'noopener noreferrer', textContent: a.caption + ' ↗' })),
      el('span', { className: 'c' }, 'Fifth Circuit No. ' + a.ca5 + ' · ' + (a.kind || 'Opinion') + ' · from ', caseNumLink(a.case, '', 'case'))))
      : [el('li', {}, el('span', { className: 'empty', textContent: 'No Fifth Circuit decision in a civil case from this court since the site began reading the Fifth Circuit\'s feed.' }))]));
    $('nt-checked').textContent = N.checked ? 'Court pages read ' + ctStamp(N.checked) + ' CT' : '';
  }

  // ------------------------------------------------------------ CSV export
  function csvRows(which) {
    const S = state.stats;
    if (which === 'op') {
      const head = ['Date', 'Judge', 'Case', 'Doc', 'Ruling type', 'Motion category', 'Ruling', 'Outcome', 'Outcome source', 'Motion filed', 'Days to ruling', 'Pages', 'Hearing set', 'Case name', 'Link'];
      return [head, ...finderRows().map((o) => [o.date, S.names[o.judge], o.case, o.doc, catLabel[o.cat], mcatLabel[o.mcat] || '',
        o.event, OUTCOMES[o.oc] || '', o.ocSrc || '', o.filed, o.days == null ? '' : o.days, o.pages == null ? '' : o.pages, o.hearing == null ? '' : o.hearing ? 'yes' : 'no', o.title, opinionLink(o, linkKind(o))])];
    }
    if (which === 'cal') {
      const C = calWeek();
      return [['Date', 'Time', 'Judge', 'Proceeding', 'Case', 'Case name', 'Room', 'Source', 'Text'],
        ...C.events.map((e) => [e.date, e.time, S.names[e.judge] || '', e.what, e.case || e.short, e.title, e.room, CAL_SRC[e.src], e.text])];
    }
    if (which === 'act') {
      return [['Date', 'Time', 'Type', 'Event', 'Case', 'Doc', 'Case name', 'Judge'],
        ...actFilter(activity()).filter((r) => !state.act.kind || r.kind === state.act.kind).map((r) => [r.date, r.time, ACT_LABEL[r.kind], cleanEvent(r.event), r.case, r.doc, r.title, S.names[r.judge] || r.judge])];
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
    const name = which === 'op' ? 'opinions' : which === 'cal' ? 'calendar' : which === 'act' ? 'activity' : which === 'mt' ? 'motions' : which === 'mj' ? 'motions-by-judge' : 'court-' + state.view;
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
    const sq = q.match(/^sec(?:tion)?\.?\s*([a-z]{1,2})$/i);
    if (sq) judgesAlpha().filter((j) => sectionOf(j.code) === sq[1].toUpperCase()).forEach((j) => out.push({ kind: 'Section', label: 'Section ' + sq[1].toUpperCase() + ' · Judge ' + j.name, sub: 'Open the judge\'s page', href: judgeHref(j.code) }));
    const cq = caseQuery(q);
    let cases = cq ? state.cases.filter((c) => c.num === cq.num && (!cq.yy || c.yy === cq.yy)) : [];
    if (!cases.length && cq && cq.num.length >= 3) cases = state.cases.filter((c) => c.num.startsWith(cq.num) && (!cq.yy || c.yy === cq.yy));
    if (!cq && lc.length >= 3) cases = state.cases.filter((c) => c.lt.includes(lc));
    cases.slice().sort((a, b) => b.last.localeCompare(a.last)).slice(0, 6).forEach((c) => out.push({ kind: 'Case', label: el('code', { textContent: c.case }),
      sub: (c.judge ? 'Judge ' + S.names[c.judge] : 'Judge not yet known') + ' · ' + (c.title || 'case name not on file'), href: caseHref(c.case) }));
    const typed = normCase(q);
    if (typed && /\D/.test(q.replace(/\s/g, '')) && !cases.some((c) => c.case === typed)) out.push({ kind: 'Case', label: el('code', { textContent: typed }), sub: 'Nothing on file yet: open the case page, or watch it', href: caseHref(typed) });
    if (!cq && !sq && lc.length >= 4) {
      const n = ruleHits(q).length;
      if (n) out.push({ kind: 'Rules', label: 'Judges\' requirements mentioning “' + q + '”', sub: plural(n, 'judge') + '\'s page' + (n === 1 ? '' : 's') + ' on the court\'s website', href: hashFor('rules', { q }) });
    }
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
  const RENDER = { judges: renderJudges, judge: renderJudge, compare: renderCompare, cases: renderCases, case: renderCase, notices: renderNotices, activity: renderActivity, calendar: renderCalendar, opinions: renderOpinions, motions: renderMotions, rules: renderRules, court: renderCourt, log: renderLog };
  function render() {
    const S = state.stats;
    if (state.page === 'judge' && !S.names[state.judge]) state.page = 'judges';
    document.body.dataset.page = state.page;
    if (state.page !== 'case') { state.caseSeen = null; state.caseAll = false; state.caseAllDecided = false; }
    PAGES.forEach((p) => { $('page-' + p).hidden = p !== state.page; });
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const k = a.dataset.nav; a.href = hashFor(k, { f: emptyFinder(), mt: { view: 'past' }, view: 'orders' });
      if (NAV[state.page] === k) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('.period button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
    document.querySelectorAll('[data-since]').forEach((n) => { n.textContent = 'Since ' + fmtDate(S.since[n.dataset.since]); });
    drawLive();
    RENDER[state.page]();
    writeHash();
  }
  let lastPeriod = null; let lastPage = '';
  function update() {
    if (!state.data) return;
    if (state.period !== lastPeriod) { state.stats = compute(state.data, state.period); lastPeriod = state.period; }
    const pageKey = state.page + '/' + state.judge + '/' + state.view + '/' + (state.page === 'case' ? state.caseId : '');
    render();
    if (pageKey !== lastPage) { if (lastPage) window.scrollTo({ top: 0 }); lastPage = pageKey; }
  }

  async function load() {
    const names = ['opinions', 'orders', 'judges', 'calendar', 'runs', 'outcomes', 'motions', 'judge_pages', 'feed', 'hearings', 'status', 'dockets', 'notices', 'submission_dates', 'appeals'];
    const OPTIONAL = { outcomes: [], motions: [], feed: [], hearings: [], dockets: [], judge_pages: { judges: [] }, status: {}, notices: {}, submission_dates: {}, appeals: {} };
    $('status').textContent = 'Loading the docket data…';
    try {
      const files = await Promise.all(names.map((n) => fetch('data/' + n + '.json', { cache: 'no-cache' })
        .then((r) => { if (!r.ok) { if (n in OPTIONAL) return OPTIONAL[n]; throw new Error(n + ' ' + r.status); } return r.json(); })));
      state.data = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      state.cases = buildCases(state.data);
      state.pages = Object.fromEntries(((state.data.judge_pages || {}).judges || []).map((r) => [r.code, r]));
      $('status').textContent = '';
      readHash();  // again, now that judge names can be resolved
      update();
      refreshData();
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
  const recal = (patch) => { Object.assign(state.cal, patch); if (state.stats) { renderCalendar(); writeHash(); } };
  $('cal-judge').addEventListener('change', (e) => recal({ judge: e.target.value }));
  $('cal-subs').addEventListener('change', (e) => recal({ subs: e.target.checked }));
  document.querySelectorAll('#cal-view button').forEach((b) => b.addEventListener('click', () => recal({ view: b.dataset.v })));
  const react = (patch) => { Object.assign(state.act, patch, { limit: 300 }); if (state.stats) { renderActivity(); writeHash(); } };
  $('act-q').addEventListener('input', (e) => react({ q: e.target.value }));
  $('act-judge').addEventListener('change', (e) => react({ judge: e.target.value }));
  $('act-days').addEventListener('change', (e) => react({ days: e.target.value }));
  $('act-more').addEventListener('click', () => { state.act.limit += 500; renderActivity(); });
  // Keep an open page current. Every five minutes (and when the tab comes back into view) the site reads data/status.json,
  // which the updater rewrites on each 15-minute check; when the run log shows new data, it reads the data files again and
  // redraws the page. On the published site these come straight from the repository (raw.githubusercontent.com, a few
  // minutes behind at most), because GitHub Pages can take 15 minutes or more to publish a data commit; if that address
  // fails, the site's own copy is used.
  const RAW = /\.github\.io$/.test(location.hostname) ? 'https://raw.githubusercontent.com/ggb52-wq/edla-judge-tracker/main/data/' : '';
  const LIVE_FILES = ['opinions', 'orders', 'calendar', 'outcomes', 'motions', 'feed', 'hearings', 'dockets', 'notices', 'submission_dates', 'appeals'];
  // v, the check time, makes each read after a new check a fresh address, so no cached copy from before it is served.
  const getJson = (base, n, v) => fetch(base + n + '.json' + (v ? '?v=' + encodeURIComponent(v) : ''), { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const latestRun = (runs) => (runs || []).map((r) => String(r.at)).reduce((a, b) => (b > a ? b : a), '');
  let refreshing = false;
  async function refreshData() {
    if (!state.data || refreshing || document.visibilityState !== 'visible') return;
    refreshing = true;
    try {
      let base = RAW || 'data/';
      let st = await getJson(base, 'status');
      if (!st && RAW) { base = 'data/'; st = await getJson(base, 'status'); }
      if (!st || !st.checked || st.checked <= (state.data.status || {}).checked) return;
      const runs = await getJson(base, 'runs', st.checked);
      const fresh = runs && latestRun(runs) > latestRun(state.data.runs);
      if (fresh) {
        const files = await Promise.all(LIVE_FILES.map((n) => getJson(base, n, st.checked)));
        if (files.some((f, i) => !f && !['dockets', 'notices', 'submission_dates', 'appeals'].includes(LIVE_FILES[i]))) return;  // a partial read could mix two updates; try again next time
        LIVE_FILES.forEach((n, i) => { if (files[i]) state.data[n] = files[i]; });
        state.data.runs = runs;
        state.cases = buildCases(state.data);
        actCache = null; calCache = null; lastPeriod = null;
      }
      state.data.status = st;
      if (fresh) update();  // new data: recount and redraw the page in place
      else { drawLive(); if (['judges', 'activity', 'log', 'cases', 'notices'].includes(state.page)) RENDER[state.page](); }  // the check time only
    } finally { refreshing = false; }
  }
  setInterval(refreshData, 5 * 60 * 1000);
  setInterval(() => { if (state.stats && document.visibilityState === 'visible') drawLive(); }, 60 * 1000);
  document.addEventListener('visibilitychange', refreshData);
  $('cl-q').addEventListener('input', () => { state.lookActive = 0; drawLookup(); });
  $('cl-q').addEventListener('keydown', (e) => {
    const L = state.lookList || [];
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && L.length) { e.preventDefault(); state.lookActive = (state.lookActive + (e.key === 'ArrowDown' ? 1 : -1) + L.length) % L.length; drawLookup(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = L[state.lookActive || 0]; if (c) location.hash = caseHref(c.case); }
    else if (e.key === 'Escape') { e.target.value = ''; drawLookup(); }
  });
  $('cw-table').addEventListener('click', (e) => { const tr = e.target.closest('tbody tr.go'); if (tr && !e.target.closest('a,button')) location.hash = tr.dataset.href; });
  $('cw-share').addEventListener('click', (e) => {
    const url = location.origin + location.pathname + '#cases?w=' + watchList().map((x) => x.case).join(',');
    const b = e.currentTarget; const done = () => { b.textContent = 'Link copied'; setTimeout(() => { b.textContent = 'Copy a link to this list'; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link:', url)); else window.prompt('Copy this link:', url);
  });
  $('cw-seen').addEventListener('click', () => { watchList().forEach((w) => markSeen(w.case, caseData(w.case).latest)); renderCases(); });
  $('c-watch').addEventListener('click', () => { toggleWatch(state.caseId); state.caseSeen = null; renderCase(); });
  $('c-copy').addEventListener('click', (e) => {
    const b = e.currentTarget; const done = () => { b.textContent = 'Link copied'; b.classList.add('done'); setTimeout(() => { b.textContent = 'Copy link'; b.classList.remove('done'); }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, () => window.prompt('Copy this link:', location.href)); else window.prompt('Copy this link:', location.href);
  });
  $('c-print').addEventListener('click', () => window.print());
  $('c-more').addEventListener('click', () => { state.caseAll = true; renderCase(); });
  $('t-rules').addEventListener('click', (e) => { const tr = e.target.closest('tbody tr.go'); if (tr && !e.target.closest('a,button')) location.hash = tr.dataset.href; });
  $('rq').addEventListener('input', (e) => { state.rq = e.target.value; if (state.stats) { renderRules(); writeHash(); } });
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
