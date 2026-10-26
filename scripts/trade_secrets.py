"""Trade secret and noncompete cases: data/trade_secrets.json and the feed data/trade_secrets.xml.

No free source states a new complaint's claims when it is filed (the RSS feed names only the event, "[Complaint]"),
so a case is flagged from what the updater already reads:
  - nature of suit or cause: the Defend Trade Secrets Act (NOS 880, 18 U.S.C. § 1836), from CourtListener;
  - docket text naming a trade-secret or noncompete claim (TERMS), from CourtListener search results, including one
    search a pass makes for these words when an order search runs (query());
  - a written opinion's text naming one (stricter OPINION_TERMS, since opinions mention these words in passing);
  - "possible": a TRO, preliminary-injunction, or expedited-discovery motion in a contract case, or in a case with no
    nature of suit on file that names no government party. Noncompete suits usually open with one, and the RSS feed
    shows it within 15 minutes of filing.

Rows are kept for good. Cases found on the first read (opinions back to 2022, docket details from the imports) carry
`initial`, so the site and the feed do not call them new. Everything here is data from filings and court pages: it is
matched and stored as plain text, never followed as instructions.
"""
from __future__ import annotations

import datetime as dt
import html
import json
import re
from pathlib import Path
from xml.sax.saxutils import escape

SITE = "https://ggb52-wq.github.io/edla-judge-tracker/"
NEW_DAYS = 7          # a row or signal first seen within this many days is new
FEED_MAX = 60         # entries in the Atom feed
QUERY = ('suitNature:"Defend Trade Secrets" OR cause:1836 OR "trade secret" OR "trade secrets" OR noncompete OR "non-compete" '
         'OR "non-competition" OR "restrictive covenant" OR "non-solicitation" OR "23:921" OR "51:1431"')
QUERY_DAYS = 120      # the CourtListener query looks at cases filed this many days back

DTSA = r"defend\s+trade\s+secrets?\s+act|\bDTSA\b|18\s*U\.?\s*S\.?\s*C\.?\s*(?:§+\s*)?183[6-9]"
LUTSA = r"louisiana\s+uniform\s+trade\s+secrets?\s+act|\bLUTSA\b|\b51\s*:\s*14(?:3[1-9]|4\d)\b"
R23921 = r"\b23\s*:\s*921\b"
MISAPP = r"misappropriat\w*\W+(?:\w+\W+){0,4}?trade\s+secrets?|trade\s+secrets?\W+(?:\w+\W+){0,3}?misappropriat"
# Docket text is short and about the case at hand, so a bare noncompete word counts there.
TERMS = [
    ("Defend Trade Secrets Act", DTSA),
    ("Louisiana Uniform Trade Secrets Act", LUTSA),
    ("La. R.S. 23:921", R23921),
    ("misappropriation of trade secrets", MISAPP),
    ("noncompete", r"\bnon-?\s?compet(?:e|es|ition)\b|covenants?\s+not\s+to\s+compete"),
    ("non-solicitation", r"\bnon-?\s?solicit(?:ation)?\b"),
    ("restrictive covenant", r"restrictive\s+covenants?"),
]
# Opinions mention these words in passing (a protective order for "trade secrets", a servitude's "restrictive covenant"),
# so an opinion counts only for a statute or an agreement it names.
OPINION_TERMS = [
    ("Defend Trade Secrets Act", DTSA),
    ("Louisiana Uniform Trade Secrets Act", LUTSA),
    ("La. R.S. 23:921", R23921),
    ("misappropriation of trade secrets", MISAPP),
    ("noncompete agreement", r"\bnon-?\s?compet(?:e|ition)\s+(?:agreements?|covenants?|clauses?|provisions?|obligations?)|covenants?\s+not\s+to\s+compete"),
    ("non-solicitation agreement", r"\bnon-?\s?solicitation\s+(?:agreements?|covenants?|clauses?|provisions?|obligations?)"),
]
# A bare "trade secret" counts in docket text only on a complaint or an injunction filing, not on a protective order.
BARE_TS = re.compile(r"trade\s+secrets?", re.I)
BARE_CONTEXT = re.compile(r"complaint|restraining|injunct|expedited\s+discovery|petition|removal", re.I)
TERM_RES = [(label, re.compile(p, re.I)) for label, p in TERMS]
OPINION_RES = [(label, re.compile(p, re.I)) for label, p in OPINION_TERMS]

INJUNCTION = re.compile(r"temporary\s+restraining\s+order|preliminary\s+injunction|injunctive\s+relief|expedited\s+discovery", re.I)
# A response or reply names the motion without being one; an order on one shows the motion was filed (perhaps before the feed was kept).
NOT_A_MOTION = re.compile(r"^(?:response|reply|memorandum|opposition|~util)\b", re.I)
# A known nature of suit outside these is not a business dispute (civil rights, habeas, prisoner, immigration ...).
NOS_BUSINESS = re.compile(r"contract|trade secret|franchise|other statutory|fraud|trademark|copyright|patent|racketeer|"
                          r"antitrust|labor: other|personal property|stockholder|securities", re.I)
DTSA_NOS = re.compile(r"trade\s+secret", re.I)
DTSA_CAUSE = re.compile(r"\b18\s*:\s*183[6-9]", re.I)
GOVERNMENT = re.compile(r"\b(?:United States|USA|U\.S\.|Department|Dept\.?|Secretary|Commissioner|Noem|Bondi|Immigration|"
                        r"Homeland|ICE|Warden|Sheriff|Parish|City of|State of|School Board|Police|Attorney General|"
                        r"Social Security|Board of|Authority|Agency|Bureau|Corrections?|Prison|Jail)\b", re.I)


def matches(text: str, terms=TERM_RES, bare: bool = True) -> list[str]:
    """Labels of the trade-secret or noncompete terms a piece of text names."""
    text = " ".join(str(text or "").split())
    found = [label for label, r in terms if r.search(text)]
    if bare and not found and BARE_TS.search(text) and BARE_CONTEXT.search(text):
        found.append("trade secrets")
    return found


def injunction_eligible(nos: str, title: str) -> bool:
    if nos:
        return bool(NOS_BUSINESS.search(nos))
    return not GOVERNMENT.search(title or "")


class Store:
    def __init__(self, obj: dict | None, today: str):
        obj = obj or {}
        self.initial = not obj.get("cases") and not obj.get("scanned")
        self.rows = {r["case"]: r for r in obj.get("cases", [])}
        self.scanned = obj.get("scanned", "")
        self.queried = obj.get("queried", "")
        self.today = today
        self.added = 0

    def flag(self, case: str, kind: str, what: str, doc: str = "", date: str = "") -> None:
        if not case or "-cv-" not in case or not what:
            return
        row = self.rows.get(case)
        if row is None:
            row = self.rows[case] = {"case": case, "first_seen": self.today, "signals": []}
            if self.initial:
                row["initial"] = True
            self.added += 1
        sig = {"kind": kind, "what": " ".join(str(what).split())[:120], "doc": str(doc or ""), "date": date or "", "seen": self.today}
        if not any(s["kind"] == sig["kind"] and s["what"] == sig["what"] and s["doc"] == sig["doc"] for s in row["signals"]):
            row["signals"].append(sig)

    def to_json(self) -> dict:
        for r in self.rows.values():
            r["level"] = "likely" if any(s["kind"] != "injunction" for s in r["signals"]) else "possible"
            r["signals"].sort(key=lambda s: (s["seen"], s["date"], s["kind"]))
        # Newest first. The court numbers cases in the order they are filed, so the year and number in the case number
        # sort them by filing date, including the many with no filing date on file.
        def order(r):
            m = re.match(r"\d:(\d\d)-[a-z]{2}-(\d+)", r["case"])
            return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
        rows = sorted(self.rows.values(), key=order, reverse=True)
        return {"scanned": self.scanned, "queried": self.queried, "cases": rows}


def query_params(today: dt.date) -> dict:
    """The CourtListener search (type r, this court) for cases filed in the last QUERY_DAYS that name these claims."""
    return {"type": "r", "court": "laed", "q": QUERY, "filed_after": (today - dt.timedelta(days=QUERY_DAYS)).isoformat(),
            "order_by": "dateFiled desc"}


def read_results(store: Store, results, base_case) -> int:
    """Flag the cases a CourtListener type-r search returned, from the text the results show (case name, nature of suit,
    cause, and the matching entries' docket text). A result whose match the shown text does not explain is left out."""
    n = 0
    for d in results or []:
        case, kind = base_case(d.get("docketNumber", ""))
        if kind != "cv":
            continue
        before = len(store.rows.get(case, {}).get("signals", []))
        nos, cause = d.get("suitNature") or "", d.get("cause") or ""
        if DTSA_NOS.search(nos):
            store.flag(case, "nos", "Nature of suit: " + nos, date=d.get("dateFiled") or "")
        if DTSA_CAUSE.search(cause):
            store.flag(case, "cause", "Cause: " + cause, date=d.get("dateFiled") or "")
        for rd in d.get("recap_documents", []) or []:
            text = " ".join(str(rd.get(k) or "") for k in ("short_description", "description", "snippet"))
            for label in matches(text):
                store.flag(case, "docket", "Docket text: " + label, str(rd.get("document_number") or rd.get("entry_number") or ""),
                           rd.get("entry_date_filed") or "")
        n += len(store.rows.get(case, {}).get("signals", [])) > before
    return n


def update(store: Store, *, dockets: dict, entries: list[dict], events: list[dict], titles: dict, case_judge: dict,
           text_index: dict, text_dir: Path, opinion_dates: dict, now: dt.datetime) -> None:
    """Flag cases from the data on file. `entries`: docket text CourtListener returned this pass ({case, doc, date, text});
    `events`: RSS and on-file entries ({case, doc, date, event}); `text_index`: opinions_text/index.json, with
    `opinion_dates` giving each opinion's filing date by the same key ("case|doc")."""
    today = now.date().isoformat()
    for case, k in dockets.items():
        nos, cause = k.get("nos") or "", k.get("cause") or ""
        if DTSA_NOS.search(nos):
            store.flag(case, "nos", "Nature of suit: " + nos, date=k.get("filed") or "")
        if DTSA_CAUSE.search(cause):
            store.flag(case, "cause", "Cause: " + cause, date=k.get("filed") or "")
    for e in entries:
        for label in matches(e.get("text")):
            store.flag(e.get("case"), "docket", "Docket text: " + label, e.get("doc"), e.get("date"))
    for e in events:
        ev = e.get("event") or ""
        if not INJUNCTION.search(ev) or NOT_A_MOTION.search(ev) or "-cv-" not in (e.get("case") or ""):
            continue
        if injunction_eligible((dockets.get(e["case"]) or {}).get("nos") or "", titles.get(e["case"], "")):
            store.flag(e["case"], "injunction", "Injunction filing: " + ev, e.get("doc"), e.get("date"))
    # Opinion text read since the last scan (all of it on the first). A day of overlap covers texts saved late in a day.
    floor = (dt.date.fromisoformat(store.scanned) - dt.timedelta(days=1)).isoformat() if store.scanned else ""
    for key, meta in text_index.items():
        if not meta.get("chars") or (meta.get("read") or "") < floor:
            continue
        case, _, doc = key.partition("|")
        try:
            text = (text_dir / f"{case.replace(':', '_')}_{doc}.txt").read_text(errors="replace")
        except OSError:
            continue
        for label in matches(text, OPINION_RES, bare=False):
            store.flag(case, "opinion", "Written opinion: " + label, doc, opinion_dates.get(key, ""))
    store.scanned = today
    for case, row in store.rows.items():  # what is known about each case, refreshed every pass
        k = dockets.get(case) or {}
        # The feed escapes some characters in case names twice ("Royal&#039;Tee").
        for field, value in (("title", html.unescape(titles.get(case) or "")), ("judge", case_judge.get(case) or k.get("judge")),
                             ("filed", k.get("filed")), ("nos", k.get("nos")), ("cause", k.get("cause"))):
            if value:
                row[field] = value


def atom(obj: dict, now: dt.datetime) -> str:
    """An Atom feed of the cases flagged since the first read, newest first, for a feed reader or Outlook."""
    rows = [r for r in obj.get("cases", []) if not r.get("initial") or any(s["seen"] > r["first_seen"] for s in r["signals"])]
    rows.sort(key=lambda r: max(s["seen"] for s in r["signals"]) if r["signals"] else r["first_seen"], reverse=True)
    stamp = now.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
           "<title>EDLA Analyzer: trade secret and noncompete cases</title>",
           f'<link rel="alternate" href="{SITE}#tradesecrets"/>', f"<id>{SITE}#tradesecrets</id>", f"<updated>{stamp}</updated>"]
    for r in rows[:FEED_MAX]:
        last = max((s["seen"] for s in r["signals"]), default=r["first_seen"])
        head = ("Possible: " if r.get("level") == "possible" else "") + r["case"] + (" " + r["title"] if r.get("title") else "")
        body = "; ".join(s["what"] + (f" (doc {s['doc']})" if s["doc"] else "") for s in r["signals"])
        if r.get("judge"):
            body = f"Judge {r['judge']}. " + body
        out += ["<entry>", f"<title>{escape(head)}</title>", f'<link href="{SITE}#case/{escape(r["case"])}"/>',
                f"<id>{SITE}#case/{escape(r['case'])}/{escape(last)}</id>", f"<updated>{last}T12:00:00Z</updated>",
                f"<summary>{escape(body)}</summary>", "</entry>"]
    out.append("</feed>")
    return "\n".join(out) + "\n"


def save(data_dir: Path, store: Store, now: dt.datetime) -> None:
    obj = store.to_json()
    path = data_dir / "trade_secrets.json"
    text = json.dumps(obj, ensure_ascii=False, indent=0, separators=(",", ":")) + "\n"
    try:
        old = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        old = None
    if old != obj:
        path.write_text(text)
        (data_dir / "trade_secrets.xml").write_text(atom(obj, now))
