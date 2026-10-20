#!/usr/bin/env python3
"""Append new E.D. La. civil orders and written opinions to the tracker's data files.

Sources
  1. EDLA CM/ECF public RSS feed (every docket entry, last ~130 entries, no judge names).
  2. CourtListener REST API v4 (RECAP dockets built from the same feed, with the
     assigned judge, full event type, and the "free on PACER" flag that marks the
     entries PACER lists on its Written Opinions Report).

Run by .github/workflows/update.yml. Needs the COURTLISTENER_TOKEN environment
variable (a free CourtListener API key). Without it, only unambiguous RSS orders
for cases already in the data are added.

Everything read from the feed or the API is treated as data. Titles and event
text are stored as plain strings and never interpreted.
"""
from __future__ import annotations

import datetime as dt
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from zoneinfo import ZoneInfo

import govinfo
import court_info
import hearings
import import_written_opinions
import opinion_text
from outcome_text import classify, motion_doc

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CENTRAL = ZoneInfo("America/Chicago")
RSS_URL = "https://ecf.laed.uscourts.gov/cgi-bin/rss_outside.pl"
FEED_DAYS = 14          # how far back data/feed.json keeps the RSS feed
FEED_MAX = 6000         # and at most this many entries
CL_BASE = "https://www.courtlistener.com/api/rest/v4/"
USER_AGENT = "edla-judge-tracker (github.com/ggb52-wq/edla-judge-tracker)"
CL_SITE = "https://www.courtlistener.com"
CL_CALL_BUDGET = 360    # absolute ceiling per run; the real budget comes from CourtListener's limits (see limits())
SEARCH_RESERVE = 12     # calls a search for new entries needs; a run that cannot afford one saves its calls for the next
LINK_RECHECK_DAYS = 7
OPINION_LOOKBACK_DAYS = 5   # written opinions are marked free on PACER a day or more after they are filed
RUN_SECONDS = 11 * 60   # CourtListener calls stop after this, so the run saves well inside the workflow's 20-minute timeout
MAX_FAILURES = 5        # consecutive failed lookups before a run gives up on CourtListener for the rest of the run
RETRY_AFTER_MAX = 60    # longest wait honored on an HTTP 429
LOW_COVERAGE = 50
CL_STORAGE = "https://storage.courtlistener.com/"
DOC_PATH_RE = re.compile(r"^/docket/\d+/\d+/[a-z0-9-]+/$")
PDF_PATH_RE = re.compile(r"^recap/gov\.uscourts\.laed\.\d+/gov\.uscourts\.laed\.\d+\.\d+\.\d+\.pdf$")

# ---------------------------------------------------------------- judges
SURNAME_CODES = {
    "milazzo": "JTM", "fallon": "EEF", "long": "BSL", "ashe": "BWA", "st. john": "ASJ",
    "st john": "ASJ", "vance": "SSV", "brown": "NJB", "barbier": "CJB", "guidry": "GGG",
    "morgan": "SM", "crain": "WJC", "vitter": "WBV", "lemelle": "ILRL", "africk": "LMA",
    "zainey": "JCZ", "papillion": "DJP", "van meerveld": "JVM", "north": "MBN",
    "currault": "DPC", "dossier": "EJD", "roby": "KWR", "lemmon": "MVL", "jackson": "BAJ",
}


def judge_code(name: str | None) -> str:
    if not name:
        return ""
    low = name.lower()
    for surname, code in SURNAME_CODES.items():
        if re.search(r"\b" + re.escape(surname) + r"\b", low):
            return code
    parts = [p for p in re.split(r"[\s.]+", name) if p and p[0].isalpha()]
    return "".join(p[0].upper() for p in parts)


# ---------------------------------------------------------------- classification
ORDER_PREFIXES = (
    "order", "text order", "scheduling order", "judgment", "set hearings", "set/reset",
    "~util", "terminate hearings", "terminate deadlines", "case transferred out",
    "report and recommendations", "pauper order", "contempt order", "certificate of appealability",
)
RSS_UNAMBIGUOUS = {
    "order", "text order", "scheduling order", "judgment", "order dismissing case", "set hearings",
    "terminate hearings", "case transferred out - district", "report and recommendations",
}
R12 = {
    "order on motion to dismiss/failure to state a claim", "order on motion to dismiss",
    "order on motion to dismiss/lack of jurisdiction", "order on motion for judgment on the pleadings",
    "order on motion to dismiss case", "order on motion to dismiss case as frivolous",
}
R56 = {"order on motion for summary judgment", "order on motion for partial summary judgment"}
TRIAL = {
    "findings of fact & conclusions of law", "order on motion for judgment as a matter of law",
    "order on motion for new trial", "order on motion to alter judgment",
}


def split_events(text: str) -> list[str]:
    return [e.strip() for e in re.split(r"\s+AND\s+|\s+/\s+", text or "") if e.strip()]


def is_order(text: str) -> bool:
    return any(e.lower().startswith(ORDER_PREFIXES) for e in split_events(text))


def opinion_flags(description: str) -> dict:
    ev = [e.lower() for e in split_events(description)]
    rr = int(any(e == "report and recommendations" for e in ev))
    r12 = any(e in R12 for e in ev)
    r56 = any(e in R56 for e in ev)
    merits = int(not rr and (r12 or r56 or any(e in TRIAL for e in ev)))
    return {"rr": rr, "merits": merits, "r12": int(bool(merits and r12)), "r56": int(bool(merits and r56))}


CASE_RE = re.compile(r"(\d:\d\d-([a-z]{2})-\d{5})")

# A motion's own docket entry: "Motion to Dismiss", "Ex Parte/Consent Motion for Extension", "Joint Motion to Continue".
# Responses, replies, orders, and notices that mention a motion are not motions.
MOTION_EVENT_RE = re.compile(r"^(?:[\w./-]+\s){0,2}motion\s+(?:to|for|in)\b", re.I)
# The court's RSS feed usually names a motion by its relief alone: "[Compel]", "[Continue]", "[Leave to File Document]",
# "[Extension of Deadlines AND Continue]". Same list as RELIEF_RE in assets/app.js.
RELIEF_RE = re.compile(
    r"^(?:continue|expedite|reconsideration|extension of (?:time|deadlines)|leave to (?:file|amend|appeal|proceed)|dismiss|"
    r"(?:partial )?summary judgment|judgment on the pleadings|compel|protective order|remand|stay|withdraw as attorney|"
    r"enroll as counsel|substitute attorney|appear pro hac vice|default judgment|entry of default|quash|strike|in limine|"
    r"exclude|intervene|amend|seal|attorney fees|sanctions|new trial|transfer|consolidate|miscellaneous relief|"
    r"preliminary injunction|temporary restraining order|reopen|set aside|recuse|sever|bifurcate|certify class|vacate|"
    r"substitute party|appoint counsel|proceed in forma pauperis)\b", re.I)
NOT_MOTION_RE = re.compile(r"response|reply|opposition|order|notice|memorand|judgment entered", re.I)
# EDLA docket text: "Motion(s) will be submitted on 11/4/2026" or "set for submission on 11/4/2026".
SUBMISSION_RE = re.compile(r"submi(?:tted|ssion)\s+(?:on\s+)?(\d{1,2})/(\d{1,2})/(\d{2,4})", re.I)


def is_motion_event(event: str) -> bool:
    e = event or ""
    if NOT_MOTION_RE.search(e):
        return False
    return bool(MOTION_EVENT_RE.match(e)) or any(RELIEF_RE.match(p.strip()) for p in re.split(r"\s+AND\s+|\s+/\s+", e))


def submission_date(text: str) -> str:
    """The submission date named in a motion's docket text, as YYYY-MM-DD, or ""."""
    m = SUBMISSION_RE.search(text or "")
    if not m:
        return ""
    mo, d, y = (int(x) for x in m.groups())
    y = y + 2000 if y < 100 else y
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return ""


def base_case(text: str) -> tuple[str, str]:
    m = CASE_RE.search(text or "")
    return (m.group(1), m.group(2)) if m else ("", "")


# ---------------------------------------------------------------- io helpers
def load(name: str):
    return json.loads((DATA / f"{name}.json").read_text())


def save(name: str, rows) -> None:
    # One row per line keeps git diffs small and readable.
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    (DATA / f"{name}.json").write_text("[\n" + body + "\n]\n")


def http_get(url: str, headers: dict | None = None, timeout: int = 45) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def log(msg: str) -> None:
    """Progress line for the workflow log, written at once so a stopped run still shows how far it got."""
    print(f"{dt.datetime.now(CENTRAL):%H:%M:%S} {msg}", flush=True)


def limits() -> dict:
    """CourtListener's rate limits for this key. The defaults are a free account's (5 a minute, 50 an hour,
    125 a day); a membership raises them, and the workflow passes the new numbers as repository variables."""
    env = lambda k, d: int(os.environ.get(k) or d)  # noqa: E731
    return {"minute": env("COURTLISTENER_PER_MINUTE", 5), "hour": env("COURTLISTENER_PER_HOUR", 50),
            "day": env("COURTLISTENER_PER_DAY", 125), "search_minutes": env("COURTLISTENER_SEARCH_MINUTES", 180)}


def run_time(r: dict) -> dt.datetime | None:
    try:
        at = dt.datetime.fromisoformat(r.get("at", ""))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=CENTRAL)


def calls_since(runs: list[dict], now: dt.datetime, minutes: int) -> int:
    """CourtListener calls made by runs that started within the last `minutes`, from the run log."""
    cutoff = now - dt.timedelta(minutes=minutes)
    total = 0
    for r in runs:
        at = run_time(r)
        if at is None or at <= cutoff:
            continue
        n = r.get("cl_calls")
        if n is None:  # runs logged before cl_calls existed
            m = re.search(r"CourtListener (\d+) calls", r.get("note", ""))
            n = int(m.group(1)) if m else 0
        total += int(n)
    return total


def last_search(runs: list[dict]) -> dt.datetime | None:
    return max((run_time(r) for r in runs if r.get("searched") and run_time(r)), default=None)


class CourtListener:
    def __init__(self, token: str | None, budget: int = CL_CALL_BUDGET, interval: float = 12.0):
        self.token = token
        self.budget = min(budget, CL_CALL_BUDGET)  # calls this run may make
        self.interval = interval                   # seconds between calls, from the per-minute limit
        self.calls = 0
        self.errors: list[str] = []
        self.deadline = time.monotonic() + RUN_SECONDS
        self.out_of_time = False
        self.throttled = False       # CourtListener asked for a wait longer than a run can afford; no more calls this run
        self.paused_until: dt.datetime | None = None

    def get(self, path_or_url: str, params: dict | None = None) -> dict | None:
        if not self.token or self.calls >= self.budget or self.throttled:
            return None
        if time.monotonic() >= self.deadline:
            self.out_of_time = True
            return None
        url = path_or_url if path_or_url.startswith("http") else CL_BASE + path_or_url
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        for attempt in range(3):
            self.calls += 1
            try:
                return json.loads(http_get(url, {"Authorization": f"Token {self.token}"}))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    try:
                        asked = int(e.headers.get("Retry-After", "60"))
                    except ValueError:
                        asked = RETRY_AFTER_MAX
                    if asked > RETRY_AFTER_MAX:
                        # Too long to wait inside any run: stop calling and say so, so the log shows the throttle.
                        self.throttled = True
                        self.paused_until = dt.datetime.now(CENTRAL) + dt.timedelta(seconds=asked)
                        self.errors.append(f"CourtListener throttled (retry after {asked}s)")
                        log(f"  CourtListener asked for a {asked}s wait; stopping its calls for this run")
                        return None
                    if time.monotonic() + asked >= self.deadline:
                        self.out_of_time = True
                        self.errors.append("CourtListener HTTP 429")
                        return None
                    if attempt < 2:
                        time.sleep(asked)
                        continue
                self.errors.append(f"CourtListener HTTP {e.code}")
                return None
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                self.errors.append(f"CourtListener {type(e).__name__}")
                return None
            finally:
                time.sleep(self.interval)
        return None

    def paged(self, path: str, params: dict, limit_pages: int = 10):
        data = self.get(path, params)
        pages = 0
        while data:
            yield from data.get("results", [])
            pages += 1
            nxt = data.get("next")
            if not nxt or pages >= limit_pages:
                break
            data = self.get(nxt)


# ---------------------------------------------------------------- sources
def fetch_rss(note: list[str]) -> list[dict]:
    try:
        root = ET.fromstring(http_get(RSS_URL))
    except Exception as e:  # network or XML error: continue without RSS
        note.append(f"RSS unavailable ({type(e).__name__})")
        return []
    items = []
    for it in root.iter("item"):
        title = html.unescape((it.findtext("title") or "").strip())  # the feed escapes some characters twice ("Henry&#039;s")
        desc = it.findtext("description") or ""
        case, kind = base_case(title)
        bracket = re.search(r"\[([^\]]+)\]", desc)
        doc = re.search(r">\s*(\d+)\s*<", desc) or re.search(r"\((\d+)\)", desc)
        pub = it.findtext("pubDate")
        try:
            when = email.utils.parsedate_to_datetime(pub).astimezone(CENTRAL) if pub else None
        except (TypeError, ValueError):
            when = None
        items.append({
            "case": case, "kind": kind, "title": title[len(case):].strip()[:70] if case else title[:70],
            "name": title[len(case):].strip()[:200] if case else title[:200],
            "event": bracket.group(1).strip() if bracket else "", "doc": doc.group(1) if doc else "",
            "when": when,
        })
    return items


def update_feed(feed: list[dict], items: list[dict], case_judge: dict, now: dt.datetime) -> list[dict]:
    """The feed itself, kept for the site's Activity page: every civil entry the RSS feed showed in the last FEED_DAYS
    days, newest first, with its time, case, document number, event, case name, and the judge once the case's judge is
    known. The feed shows only its latest entries, so this copy is what lets the site look back a couple of weeks."""
    seen = {(r["case"], r["doc"], r["event"], r["at"]) for r in feed}
    for i in items:
        if not i.get("when") or not i.get("case"):
            continue
        row = {"at": i["when"].isoformat(timespec="minutes"), "case": i["case"], "doc": i["doc"], "event": i["event"],
               "title": i.get("name") or i["title"], "judge": case_judge.get(i["case"], "")}
        key = (row["case"], row["doc"], row["event"], row["at"])
        if key not in seen:
            seen.add(key)
            feed.append(row)
    floor = (now - dt.timedelta(days=FEED_DAYS)).isoformat(timespec="minutes")
    feed = [r for r in feed if r["at"] >= floor]
    for r in feed:  # judges learned since the entry was seen
        if not r.get("judge") and case_judge.get(r["case"]):
            r["judge"] = case_judge[r["case"]]
    feed.sort(key=lambda r: (r["at"], r["case"], int(r["doc"]) if r["doc"].isdigit() else 0), reverse=True)
    return feed[:FEED_MAX]


def update_hearings(old: list[dict], cl_entries: dict, case_judge: dict, judges: list[dict], rows: list[dict],
                    now: dt.datetime, note: list[str]) -> list[dict]:
    """data/hearings.json for the Calendar page: the court's seven-day calendar (one small page, read every pass) and
    proceedings set in the docket text CourtListener returned this run (no extra calls)."""
    today = now.date()
    try:
        cal_rows, cal_dates = hearings.parse_court_calendar(http_get(hearings.CALENDAR_URL).decode("utf-8", "replace"), judges)
        note.append(f"court calendar {len(cal_rows)} proceedings over {len(cal_dates)} days")
    except Exception as e:  # noqa: BLE001 - keep the last copy when the court's site is down
        cal_rows, cal_dates = [], []
        note.append(f"court calendar unavailable ({type(e).__name__})")
    # The calendar names cases in short form ("24-1933"); match it to a civil case the data knows.
    short = {}
    for r in rows:
        m = re.match(r"\d:(\d\d)-cv-0*(\d+)$", r.get("case", ""))
        if m:
            short.setdefault(f"{m.group(1)}-{m.group(2)}", r["case"])
    for r in cal_rows:
        r["case"] = short.get(r["case_short"], "")
    docket_rows = []
    for (case, doc), e in cl_entries.items():
        if e.get("kind") != "cv" or not e.get("text"):
            continue
        for x in hearings.settings_from_text(e["text"], today):
            docket_rows.append({**x, "judge": e.get("judge") or case_judge.get(case, ""), "case": case, "doc": doc,
                                "title": e.get("title", ""), "text": e["text"][:300], "src": "docket_text", "seen": today.isoformat()})
    if docket_rows:
        note.append(f"{len(docket_rows)} proceedings set in docket text")
    merged = hearings.merge(old, cal_rows, cal_dates, docket_rows, today)
    for r in merged:  # judges learned since the row was written
        if not r.get("judge") and case_judge.get(r.get("case", "")):
            r["judge"] = case_judge[r["case"]]
    return merged


def doc_url(path: str | None) -> str:
    """CourtListener address for a main RECAP document, or "" when the path has another shape."""
    return CL_SITE + path if path and DOC_PATH_RE.match(path) else ""


def pdf_url(path: str | None) -> str:
    """CourtListener's stored copy of a main RECAP document PDF, or "" when the path has another shape."""
    return CL_STORAGE + path if path and PDF_PATH_RE.match(path) else ""


def doc_links(r: dict) -> dict:
    """The `url` (document page), `pdf` (file), and `pages` fields for one recap-documents result.
    `pages` is CourtListener's page count for the PDF, 0 when CourtListener has the PDF but no count yet."""
    out = {}
    if u := doc_url(r.get("absolute_url")):
        out["url"] = u
        if r.get("is_available") and (f := pdf_url(r.get("filepath_local"))):
            out["pdf"] = f
            pc = r.get("page_count")
            out["pages"] = pc if isinstance(pc, int) and pc > 0 else 0
    return out


MOTION_RULING_RE = re.compile(r"\bmotion\s+(?:to|for|in)\b", re.I)


def rules_on_motion(o: dict) -> bool:
    """Opinions whose event names a motion ("Order on Motion to Dismiss") get an outcome.

    Magistrate reports and recommendations do not, nor do clerk events such as "Terminate Motions".
    """
    return not int(o.get("rr") or 0) and bool(MOTION_RULING_RE.search(o.get("event") or ""))


def outcome_due(outcomes: dict, o: dict, cutoff: str) -> bool:
    """A motion ruling needs an outcome read when none is on file, or when an automatic read found none
    (outcome "unclear") at least LINK_RECHECK_DAYS ago. Hand entries are never re-read."""
    if not rules_on_motion(o):
        return False
    r = outcomes.get(f"{o['case']}|{o['doc']}")
    if r is None:
        return True
    if r.get("src") == "manual":
        return False
    if r.get("outcome") == "unclear":
        return r.get("at", "") <= cutoff
    return "motion_doc" not in r  # outcome known, but the motion's filing date has not been looked for yet


def set_outcome(outcomes: dict, o: dict, value: str, src: str, today: str) -> None:
    """Record an outcome read by the updater. It replaces only an earlier automatic "unclear"; other outcomes
    on file, including every hand entry, are kept."""
    key = f"{o['case']}|{o['doc']}"
    old = outcomes.get(key)
    if value and (old is None or (old.get("src") != "manual" and old.get("outcome") == "unclear")):
        outcomes[key] = {"case": o["case"], "doc": o["doc"], "outcome": value, "src": src, "at": today}


def fill_motion(cl: CourtListener, outcomes: dict, o: dict, text: str, source: str, docket_id: str) -> None:
    """Record which motion a known outcome decided (`motion_doc`) and the date it was filed (`motion_filed`).

    Both come from the text the outcome was read from plus one CourtListener call for the docket entry.
    `motion_doc` is written even when blank, so the ruling is not re-read for it. Hand entries are left alone.
    """
    r = outcomes.get(f"{o['case']}|{o['doc']}")
    if not r or r.get("src") == "manual" or r.get("outcome") in ("", "unclear") or "motion_doc" in r:
        return
    r["motion_doc"] = md = motion_doc(text, o.get("event", ""), o.get("r12", 0), o.get("r56", 0), source)
    if not md or not docket_id:
        return
    data = cl.get("docket-entries/", {"docket": docket_id, "entry_number": md, "fields": "date_filed"})
    filed = ((data or {}).get("results") or [{}])[0].get("date_filed") or ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", filed) and filed <= o["date"]:
        r["motion_filed"] = filed


def docket_id_of(url: str | None) -> str:
    m = re.search(r"/docket/(\d+)/", url or "")
    return m.group(1) if m else ""


def link_opinions(cl: CourtListener, opinions: list[dict], checks: dict, outcomes: dict, today: str,
                  texts: opinion_text.Store | None = None) -> tuple[int, int]:
    """Look up CourtListener addresses, and the order text for outcomes, a few opinions per run.

    An opinion is looked up while it lacks a PDF link or, if it rules on a motion, an outcome.
    Rows never checked go first, newest first; rows checked before are retried after
    LINK_RECHECK_DAYS, because CourtListener adds documents and PDFs after PACER lists them.
    Known outcomes are read once more for the motion's docket number and filing date (one extra call).
    Returns (rows given new links, outcomes read).
    """
    cutoff = (dt.date.fromisoformat(today) - dt.timedelta(days=LINK_RECHECK_DAYS)).isoformat()
    needs_outcome = lambda o: outcome_due(outcomes, o, cutoff)  # noqa: E731
    needs_pages = lambda o: bool(o.get("pdf")) and "pages" not in o  # noqa: E731
    todo = [o for o in opinions if (not o.get("pdf") or needs_outcome(o) or needs_pages(o)) and o.get("doc") and CASE_RE.fullmatch(o.get("case", ""))
            and checks.get(f"{o['case']}|{o['doc']}", "") <= cutoff]
    todo.sort(key=lambda o: o["date"], reverse=True)
    todo.sort(key=lambda o: checks.get(f"{o['case']}|{o['doc']}", ""))  # stable: oldest check first, then newest row
    found = read = 0
    failures = 0
    log(f"looking up {len(todo)} opinions for links and outcomes")
    for n, o in enumerate(todo):
        if cl.calls >= cl.budget or cl.out_of_time or cl.throttled:
            break
        if n and n % 25 == 0:
            log(f"  {n} looked up, {found} linked, {read} outcomes read, {cl.calls} calls")
        data = cl.get("recap-documents/", {
            "docket_entry__docket__court": "laed", "docket_entry__docket__docket_number": o["case"],
            "document_number": o["doc"], "fields": "absolute_url,filepath_local,is_available,page_count,plain_text"})
        if data is None:
            # One refused or timed-out call skips this row (it is retried next run, since no check is recorded);
            # a streak of them means the service is unavailable, so the run stops and saves what it has.
            failures += 1
            if failures >= MAX_FAILURES or cl.out_of_time or cl.throttled or cl.calls >= cl.budget:
                log(f"  stopping lookups after {failures} failed call(s) in a row")
                break
            continue
        failures = 0
        checks[f"{o['case']}|{o['doc']}"] = today
        results = [r for r in data.get("results", []) if doc_url(r.get("absolute_url"))]
        links = max((doc_links(r) for r in results), key=len, default={})
        # Fill only what is missing: a PDF link or page count already found (from GovInfo, say) is kept.
        fresh = {k: v for k, v in links.items() if not o.get(k)}
        if fresh:
            o.update(fresh)
            found += 1
        if o.get("pdf") and "pages" not in o:
            o["pages"] = 0  # looked up; CourtListener had no count
        text = next((r.get("plain_text") for r in results if (r.get("plain_text") or "").strip()), "")
        if text and texts is not None:
            texts.save(o["case"], o["doc"], text, int(o.get("pages") or 0), "courtlistener", today)
        if text and needs_outcome(o):
            # Order text that yields no outcome is marked "unclear" so it is not read again; a hand entry can replace it.
            set_outcome(outcomes, o, classify(text, o.get("event", ""), o.get("r12", 0), o.get("r56", 0), "order") or "unclear", "opinion_text", today)
            fill_motion(cl, outcomes, o, text, "order", docket_id_of(o.get("url")))
            read += 1
        if o.get("pdf") and not needs_outcome(o) and not needs_pages(o):
            checks.pop(f"{o['case']}|{o['doc']}", None)
    return found, read


def to_central(iso: str | None) -> dt.datetime | None:
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(CENTRAL)
    except ValueError:
        return None


# ---------------------------------------------------------------- main
def main() -> int:
    now = dt.datetime.now(CENTRAL)
    today = now.date().isoformat()
    note: list[str] = []

    orders, opinions = load("orders"), load("opinions")
    calendar, runs, judges = load("calendar"), load("runs"), load("judges")
    link_checks = load("link_checks") if (DATA / "link_checks.json").exists() else {}
    outcomes = {f"{r['case']}|{r['doc']}": r for r in (load("outcomes") if (DATA / "outcomes.json").exists() else [])}
    # Drop automatic outcomes for entries that are not motion rulings (hand entries always stay).
    motion_keys = {f"{o['case']}|{o['doc']}" for o in opinions if rules_on_motion(o)}
    outcomes = {k: r for k, r in outcomes.items() if r.get("src") == "manual" or k in motion_keys}
    bench = {j["code"]: j["bench_start"] for j in judges}
    holidays = {r["date"] for r in calendar if r["kind"] == "holiday"}
    through_row = next(r for r in calendar if r["kind"] == "through")
    window_from = through_row["date"]
    prev_run = max((r.get("at", "") for r in runs), default="")
    pending = [p for p in (runs[-1].get("pending_items", []) if runs else [])
               if p.get("date", today) >= (now.date() - dt.timedelta(days=7)).isoformat()]

    order_keys = {(o["case"], o["doc"]) for o in orders}
    opinion_keys = {(o["case"], o["doc"]) for o in opinions}
    case_judge: dict[str, str] = {}
    for row in orders + opinions:
        if row.get("judge"):
            case_judge[row["case"]] = row["judge"]

    def allowed(judge: str, date: str) -> bool:
        return date >= bench.get(judge, "0000-00-00")

    # --- RSS
    log("reading RSS feed")
    rss = fetch_rss(note)
    rss_civil = [i for i in rss if i["kind"] == "cv"]
    rss_time = {(i["case"], i["doc"]): i["when"] for i in rss_civil if i["when"]}
    if rss and prev_run:
        oldest = min((i["when"] for i in rss if i["when"]), default=None)
        prev_dt = dt.datetime.fromisoformat(prev_run)
        if oldest and oldest > prev_dt:
            note.append(f"RSS window gap since {prev_dt:%m/%d %H:%M}")

    # --- CourtListener budget for this run, from its rate limits and the run log
    lim = limits()
    hour_used, day_used = calls_since(runs, now, 60), calls_since(runs, now, 24 * 60)
    allowance = max(0, min(lim["hour"] - hour_used, lim["day"] - day_used))
    paused = next((run_time({"at": r["cl_paused_until"]}) for r in reversed(runs) if r.get("cl_paused_until")), None)
    if paused and paused > now:
        allowance = 0
        note.append(f"CourtListener paused until {paused:%m/%d %H:%M}")
    since = last_search(runs)
    search_due = since is None or now - since >= dt.timedelta(minutes=lim["search_minutes"])
    do_search = search_due and allowance >= SEARCH_RESERVE
    note.append(f"CourtListener calls left {allowance} (hour {hour_used}/{lim['hour']}, day {day_used}/{lim['day']})")
    if search_due and 0 < allowance < SEARCH_RESERVE:
        allowance = 0  # save what is left for a search
        note.append("Saving CourtListener calls for the next search")
    elif not search_due and since:
        note.append(f"Next CourtListener search after {since + dt.timedelta(minutes=lim['search_minutes']):%H:%M}")
    cl = CourtListener(os.environ.get("COURTLISTENER_TOKEN"), allowance, 60 / max(1, lim["minute"]))
    if not cl.token:
        note.append("No CourtListener token; RSS only")
    log(f"CourtListener budget {cl.budget}; search {'yes' if do_search else 'no'}")

    # --- CourtListener dockets with order-type entries
    log("searching CourtListener for new entries" if do_search else "skipping the CourtListener search this run")
    docket_info: dict[int, dict] = {}
    cl_entries: dict[tuple[str, str], dict] = {}
    dockets = {r["case"]: r for r in court_info.load_json(DATA / "dockets.json", [])}
    # Written Opinions Reports the owner saved from PACER (data/imports/wo_*.json): opinions, signers, outcomes.
    import_written_opinions.apply_imports(DATA, opinions, outcomes, dockets, calendar, judges, today, note,
                                          classify, opinion_flags, judge_code, rules_on_motion)
    opinion_keys = {(o["case"], o["doc"]) for o in opinions}
    q = ("short_description:order OR short_description:judgment OR short_description:hearing OR "
         "short_description:hearings OR short_description:transferred OR short_description:recommendations")
    for d in (cl.paged("search/", {"type": "r", "court": "laed", "q": q,
                                    "entry_date_filed_after": window_from, "entry_date_filed_before": today}) if do_search else []):
        case, kind = base_case(d.get("docketNumber", ""))
        info = {"case": case, "kind": kind, "judge": judge_code(d.get("assignedTo")),
                "title": (d.get("caseName") or "")[:70]}
        docket_info[d.get("docket_id")] = info
        court_info.note_docket(dockets, case, info["judge"], d, today)
        if info["judge"]:
            case_judge.setdefault(case, info["judge"])
        for rd in d.get("recap_documents", []) or []:
            doc = str(rd.get("document_number") or rd.get("entry_number") or "")
            if not doc:
                continue
            key = (case, doc)
            ent = cl_entries.setdefault(key, {**info, "doc": doc, "events": [],
                                              "date": rd.get("entry_date_filed") or "",
                                              "created": to_central((rd.get("meta") or {}).get("date_created"))})
            sd = (rd.get("short_description") or "").strip()
            if sd and sd not in ent["events"]:
                ent["events"].append(sd)
            if not ent.get("text") and not rd.get("attachment_number"):
                ent["text"] = (rd.get("description") or "").strip()  # full docket text, read for the outcome

    added_orders = []
    for key, e in cl_entries.items():
        if e["kind"] != "cv" or key in order_keys:
            continue
        event = " / ".join(e["events"])[:160]
        if not is_order(event):
            continue
        judge = e["judge"] or case_judge.get(e["case"], "")
        when = rss_time.get(key) or e["created"]
        date = e["date"] or (when.date().isoformat() if when else today)
        if judge and not allowed(judge, date):
            continue
        added_orders.append({"date": date, "time": when.strftime("%H:%M") if when else "", "judge": judge,
                             "case": e["case"], "doc": e["doc"], "title": e["title"], "event": event,
                             "src": "courtlistener"})
        order_keys.add(key)

    # --- Motions from the RSS feed (no API cost). The feed shows the event type, case, and document number;
    # the submission date comes later from CourtListener's docket text when a search runs.
    motions = load("motions") if (DATA / "motions.json").exists() else []
    motion_keys = {(m["case"], m["doc"]) for m in motions}
    added_motions = 0
    # The saved feed (data/feed.json, 14 days) as well as this read, so a motion missed by an earlier run is still added.
    saved_feed = [{"case": f["case"], "doc": f["doc"], "event": f["event"], "title": f.get("title", "")[:70],
                   "when": dt.datetime.fromisoformat(f["at"])} for f in (load("feed") if (DATA / "feed.json").exists() else [])
                  if f.get("case") and f.get("at") and "-cv-" in f["case"]]
    for i in rss_civil + saved_feed:
        key = (i["case"], i["doc"])
        if not i["doc"] or key in motion_keys or not is_motion_event(i["event"]):
            continue
        motions.append({"date": i["when"].date().isoformat() if i["when"] else today,
                        "time": i["when"].strftime("%H:%M") if i["when"] else "", "judge": case_judge.get(i["case"], ""),
                        "case": i["case"], "doc": i["doc"], "title": i["title"], "event": i["event"], "submit": "", "src": "rss"})
        motion_keys.add(key)
        added_motions += 1
    # Submission dates and motions the feed missed, from CourtListener's docket text (one or two calls per search).
    if do_search:
        for r in cl.paged("search/", {"type": "rd", "court": "laed", "q": 'short_description:motion OR description:"submitted on"',
                                       "entry_date_filed_after": window_from, "entry_date_filed_before": today}, limit_pages=3):
            case, kind = base_case(r.get("docketNumber", ""))
            doc = str(r.get("document_number") or r.get("entry_number") or "")
            event = (r.get("short_description") or "").strip()
            if kind != "cv" or not doc or not is_motion_event(event):
                continue
            judge = judge_code(r.get("assignedTo")) or case_judge.get(case, "")
            if judge:
                case_judge.setdefault(case, judge)
            key = (case, doc)
            if key not in motion_keys:
                motions.append({"date": r.get("entry_date_filed") or today, "time": "", "judge": judge, "case": case, "doc": doc,
                                "title": (r.get("caseName") or "")[:70], "event": event, "submit": "", "src": "courtlistener"})
                motion_keys.add(key)
                added_motions += 1
            m = next(x for x in motions if (x["case"], x["doc"]) == key)
            if not m.get("submit"):
                m["submit"] = submission_date(r.get("description") or "")
    for m in motions:  # judges learned since the motion was seen
        if not m.get("judge") and case_judge.get(m["case"]):
            m["judge"] = case_judge[m["case"]]
    if added_motions:
        note.append(f"{added_motions} motions added")

    # --- RSS-only items
    new_pending, seen = [], set()
    for i in rss_civil + [{"case": p["case"], "kind": "cv", "doc": p["doc"], "event": p["bracket"],
                           "title": p.get("title", ""), "when": dt.datetime.fromisoformat(p["when"]) if p.get("when") else None}
                          for p in pending]:
        key = (i["case"], i["doc"])
        if not i["doc"] or key in order_keys or key in cl_entries or key in seen:
            continue
        seen.add(key)
        date = i["when"].date().isoformat() if i["when"] else today
        if i["event"].lower() in RSS_UNAMBIGUOUS and case_judge.get(i["case"]):
            judge = case_judge[i["case"]]
            if allowed(judge, date):
                added_orders.append({"date": date, "time": i["when"].strftime("%H:%M") if i["when"] else "",
                                     "judge": judge, "case": i["case"], "doc": i["doc"], "title": i["title"],
                                     "event": i["event"], "src": "rss"})
            order_keys.add(key)
        elif len(new_pending) < 100:
            new_pending.append({"case": i["case"], "doc": i["doc"], "bracket": i["event"], "title": i["title"],
                                "when": i["when"].isoformat() if i["when"] else "", "date": date})

    # --- Written opinions (free on PACER)
    # CourtListener records an entry when the RSS feed shows it (date_created) but marks it free on PACER only when
    # it reads the court's Written Opinions Report, usually the next morning (date_modified). So the query goes by
    # date_modified and looks back OPINION_LOOKBACK_DAYS before the window; opinions already on file are skipped.
    added_opinions = []
    order_dates = {(o["case"], o["doc"]): o["date"] for o in orders + added_orders}
    op_since = (dt.date.fromisoformat(window_from) - dt.timedelta(days=OPINION_LOOKBACK_DAYS)).isoformat()
    docs = list(cl.paged("recap-documents/", {
        "is_free_on_pacer": "true", "docket_entry__docket__court": "laed",
        "date_modified__gte": f"{op_since}T00:00:00-05:00", "order_by": "date_modified",
        "fields": "id,description,document_number,absolute_url,filepath_local,is_available,page_count,date_created"})) if do_search else []
    missing = set()
    for r in docs:
        m = re.search(r"/docket/(\d+)/", r.get("absolute_url", ""))
        if m and int(m.group(1)) not in docket_info:
            missing.add(int(m.group(1)))
    if missing:
        ids = sorted(missing)
        for start in range(0, len(ids), 40):
            chunk = ids[start:start + 40]
            for d in cl.paged("search/", {"type": "r", "court": "laed",
                                           "q": "docket_id:(" + " OR ".join(map(str, chunk)) + ")"}, limit_pages=2):
                case, kind = base_case(d.get("docketNumber", ""))
                court_info.note_docket(dockets, case, judge_code(d.get("assignedTo")), d, today)
                docket_info[d.get("docket_id")] = {"case": case, "kind": kind,
                                                   "judge": judge_code(d.get("assignedTo")),
                                                   "title": (d.get("caseName") or "")[:70]}
    for r in docs:
        m = re.search(r"/docket/(\d+)/", r.get("absolute_url", ""))
        info = docket_info.get(int(m.group(1))) if m else None
        if not info or info["kind"] != "cv":
            continue
        doc = str(r.get("document_number") or "")
        key = (info["case"], doc)
        if not doc or key in opinion_keys:
            continue
        ent = cl_entries.get(key)
        created = to_central(r.get("date_created"))
        date = (ent or {}).get("date") or order_dates.get(key) or (created.date().isoformat() if created else today)
        judge = info["judge"] or case_judge.get(info["case"], "")
        if judge and not allowed(judge, date):
            continue
        desc = (r.get("description") or "").strip()
        row = {"date": date, "judge": judge, "case": info["case"], "doc": doc,
               "title": info["title"], "event": desc[:160], **opinion_flags(desc),
               "src": "courtlistener_wo", **doc_links(r)}
        added_opinions.append(row)
        opinion_keys.add(key)
        if rules_on_motion(row) and ent and ent.get("text"):
            set_outcome(outcomes, row, classify(ent["text"], row["event"], row["r12"], row["r56"], "docket"), "docket_text", today)
            fill_motion(cl, outcomes, row, ent["text"], "docket", docket_id_of(r.get("absolute_url")))

    # Rows for magistrate judges presiding by consent and visiting judges are kept;
    # the site charts only the judges listed in data/judges.json.
    no_judge = sum(1 for r in added_orders + added_opinions if not r["judge"])
    if no_judge:
        note.append(f"{no_judge} entries without a judge")

    log(f"new entries: orders +{len(added_orders)}, opinions +{len(added_opinions)}; {cl.calls} calls")
    # Only a run that searched CourtListener to the end moves the window forward; one cut short by the
    # time limit or a throttle may have missed entries, and an RSS-only run never looked.
    complete = do_search and not cl.out_of_time and not cl.throttled
    if do_search and not complete:
        note.append("Search cut short before all new entries were read; window kept")

    # --- GovInfo: opinion PDFs, page counts, and order text, ahead of CourtListener's tighter limits
    texts = opinion_text.Store(DATA.parent / "opinions_text")
    gi_key = os.environ.get("GOVINFO_API_KEY")
    gi_pdf = gi_read = 0
    if gi_key:
        try:
            import pypdf  # noqa: F401
        except ImportError:
            gi_key = None
            note.append("GovInfo skipped: pypdf not installed")
    if gi_key:
        gi_cache_path = DATA / "govinfo.json"
        gi_cache = govinfo.load_cache(gi_cache_path)

        def gi_needs(o: dict) -> bool:
            """An opinion GovInfo can still help with: no PDF link, no page count, or a motion ruling with no outcome."""
            return bool(CASE_RE.fullmatch(o.get("case", ""))) and (
                not o.get("pdf") or not o.get("pages") or (rules_on_motion(o) and f"{o['case']}|{o['doc']}" not in outcomes))

        def gi_apply(o: dict, link: str, pages: int, text: str) -> None:
            nonlocal gi_pdf, gi_read
            if link and not o.get("pdf"):
                o["pdf"] = link
                gi_pdf += 1
            if pages and not o.get("pages"):
                o["pages"] = pages
            if text:
                texts.save(o["case"], o["doc"], text, pages, "govinfo", today)
            key = f"{o['case']}|{o['doc']}"
            if text and rules_on_motion(o) and key not in outcomes:
                # The filing date of the decided motion still comes from CourtListener's docket, so motion_doc is left
                # unset here and the CourtListener pass completes time to ruling as its budget allows.
                set_outcome(outcomes, o, classify(text, o.get("event", ""), o.get("r12", 0), o.get("r56", 0), "order") or "unclear",
                            "govinfo_text", today)
                gi_read += 1

        gi = govinfo.GovInfo(gi_key, http_get, min(cl.deadline, time.monotonic() + 6 * 60), log)
        log("reading opinions from GovInfo")
        stats = govinfo.backfill(gi, opinions, gi_needs, gi_cache, gi_apply, today)
        govinfo.save_cache(gi_cache_path, gi_cache)
        log(f"GovInfo: {stats['cases']} cases, {stats['read']} PDFs read, {stats['matched']} matched; {gi.api_calls} API calls")
        if gi_pdf:
            note.append(f"{gi_pdf} PDF links from GovInfo")
        if gi_read:
            note.append(f"{gi_read} orders read from GovInfo")
        note.append(f"GovInfo {gi.api_calls} calls, {gi.pdfs} PDFs" + (f" (stopped: {gi.stopped})" if gi.stopped else ""))
        note.extend(sorted(set(gi.errors)))
    else:
        note.append("No GovInfo key; GovInfo skipped")

    # --- The full text of opinions with a stored PDF, for search (opinions_text/; public downloads, no API calls)
    try:
        import pypdf  # noqa: F401
        tx = texts.backfill(opinions, http_get, today, time.monotonic() + 4 * 60)
        if tx["tried"]:
            note.append(f"{tx['saved']} opinion texts saved ({tx['left']} to go)" + (f", {tx['errors']} downloads failed" if tx["errors"] else ""))
    except ImportError:
        note.append("Opinion text skipped: pypdf not installed")

    # --- CourtListener addresses for opinions already in the data
    linked, read = link_opinions(cl, opinions, link_checks, outcomes, today, texts) if cl.token else (0, 0)
    if linked:
        note.append(f"{linked} opinion links added")
    if read:
        note.append(f"{read} orders read for outcomes")
    if complete and cl.out_of_time:
        note.append("Time limit reached; remaining lookups continue next run")

    # --- coverage check for completed weekdays in the window
    orders.extend(added_orders)
    opinions.extend(added_opinions)
    d = dt.date.fromisoformat(window_from)
    while d < now.date():
        iso = d.isoformat()
        if d.weekday() < 5 and iso not in holidays:
            n = sum(1 for o in orders if o["date"] == iso)
            if n < LOW_COVERAGE:
                note.append(f"Low coverage on {iso}: {n} orders")
        d += dt.timedelta(days=1)

    # --- save
    orders.sort(key=lambda o: (o["date"], o.get("time", ""), o["case"], o["doc"]))
    opinions.sort(key=lambda o: (o["date"], o["case"], o["doc"]))
    if complete and now.weekday() < 5 and today not in holidays:
        through_row["date"] = today
    # Court pages beyond the docket: each section's submission dates (daily), court notices (every six hours), and
    # Fifth Circuit decisions in cases from this court (every pass). Read before the run log is written, so their notes are in it.
    jp = court_info.load_json(DATA / "judge_pages.json", {})
    sections = {j["code"]: (j.get("contact") or {}).get("section", "") for j in jp.get("judges", []) if j.get("code") in bench}
    for name, fn in (("submission_dates", lambda old: court_info.update_submission_dates(old, http_get, sections, now, note)),
                     ("notices", lambda old: court_info.update_notices(old, http_get, now, note)),
                     ("appeals", lambda old: court_info.update_appeals(old, http_get, now, note))):
        old = court_info.load_json(DATA / f"{name}.json", {})
        new = fn(old)
        if new is not old:
            court_info.save_json(DATA / f"{name}.json", new)
    note.append(f"RSS {len(rss)} items ({len(rss_civil)} civil); CourtListener {cl.calls} calls")
    note.extend(sorted(set(cl.errors)))
    runs.append({"at": now.isoformat(timespec="minutes"), "from": window_from, "to": today,
                 "orders_added": len(added_orders), "opinions_added": len(added_opinions),
                 "pending": len(new_pending), "ok": not cl.errors and bool(rss or cl.calls),
                 "cl_calls": cl.calls, "searched": complete,
                 **({"cl_paused_until": cl.paused_until.isoformat(timespec="minutes")} if cl.paused_until else {}),
                 "note": "; ".join(note), "pending_items": new_pending})
    runs = runs[-500:]
    for r in runs[:-1]:
        r.pop("pending_items", None)

    save("orders", orders)
    save("opinions", opinions)
    save("calendar", calendar)
    save("runs", runs)
    save("outcomes", sorted(outcomes.values(), key=lambda r: (r["case"], int(r["doc"]) if r["doc"].isdigit() else 0)))
    motions.sort(key=lambda m: (m["date"], m["case"], int(m["doc"]) if m["doc"].isdigit() else 0))
    save("motions", motions)
    save("feed", update_feed(load("feed") if (DATA / "feed.json").exists() else [], rss_civil, case_judge, now))
    save("hearings", update_hearings(load("hearings") if (DATA / "hearings.json").exists() else [], cl_entries, case_judge,
                                     judges, orders + opinions + motions, now, note))
    texts.write_index()
    court_info.save_json(DATA / "dockets.json", sorted(dockets.values(), key=lambda r: r["case"]))
    (DATA / "link_checks.json").write_text(json.dumps(dict(sorted(link_checks.items())), indent=0) + "\n")
    # Rewritten on every pass, so the site can show when the feed was last checked even when nothing new came in.
    paused_until = cl.paused_until or (paused if paused and paused > now else None)
    searched = now if complete else since
    (DATA / "status.json").write_text(json.dumps({
        "checked": now.isoformat(timespec="minutes"), "rss_items": len(rss), "rss_civil": len(rss_civil),
        "searched": searched.isoformat(timespec="minutes") if searched else "",
        "cl_paused_until": paused_until.isoformat(timespec="minutes") if paused_until else "",
        "through": through_row["date"], "pending": len(new_pending)}, indent=1) + "\n")
    print(f"orders +{len(added_orders)}, opinions +{len(added_opinions)}, pending {len(new_pending)}; " + "; ".join(note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
