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

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CENTRAL = ZoneInfo("America/Chicago")
RSS_URL = "https://ecf.laed.uscourts.gov/cgi-bin/rss_outside.pl"
CL_BASE = "https://www.courtlistener.com/api/rest/v4/"
USER_AGENT = "edla-judge-tracker (github.com/ggb52-wq/edla-judge-tracker)"
CL_CALL_BUDGET = 40
LOW_COVERAGE = 50

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


class CourtListener:
    def __init__(self, token: str | None):
        self.token = token
        self.calls = 0
        self.errors: list[str] = []

    def get(self, path_or_url: str, params: dict | None = None) -> dict | None:
        if not self.token or self.calls >= CL_CALL_BUDGET:
            return None
        url = path_or_url if path_or_url.startswith("http") else CL_BASE + path_or_url
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        for attempt in range(3):
            self.calls += 1
            try:
                return json.loads(http_get(url, {"Authorization": f"Token {self.token}"}))
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 2:
                    time.sleep(int(e.headers.get("Retry-After", "60")))
                    continue
                self.errors.append(f"CourtListener HTTP {e.code}")
                return None
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                self.errors.append(f"CourtListener {type(e).__name__}")
                return None
            finally:
                time.sleep(1.2)
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
        title = (it.findtext("title") or "").strip()
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
            "event": bracket.group(1).strip() if bracket else "", "doc": doc.group(1) if doc else "",
            "when": when,
        })
    return items


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
    rss = fetch_rss(note)
    rss_civil = [i for i in rss if i["kind"] == "cv"]
    rss_time = {(i["case"], i["doc"]): i["when"] for i in rss_civil if i["when"]}
    if rss and prev_run:
        oldest = min((i["when"] for i in rss if i["when"]), default=None)
        prev_dt = dt.datetime.fromisoformat(prev_run)
        if oldest and oldest > prev_dt:
            note.append(f"RSS window gap since {prev_dt:%m/%d %H:%M}")

    # --- CourtListener dockets with order-type entries
    cl = CourtListener(os.environ.get("COURTLISTENER_TOKEN"))
    if not cl.token:
        note.append("No CourtListener token; RSS only")
    docket_info: dict[int, dict] = {}
    cl_entries: dict[tuple[str, str], dict] = {}
    q = ("short_description:order OR short_description:judgment OR short_description:hearing OR "
         "short_description:hearings OR short_description:transferred OR short_description:recommendations")
    for d in cl.paged("search/", {"type": "r", "court": "laed", "q": q,
                                   "entry_date_filed_after": window_from, "entry_date_filed_before": today}):
        case, kind = base_case(d.get("docketNumber", ""))
        info = {"case": case, "kind": kind, "judge": judge_code(d.get("assignedTo")),
                "title": (d.get("caseName") or "")[:70]}
        docket_info[d.get("docket_id")] = info
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

    # --- RSS-only items
    new_pending = []
    for i in rss_civil + [{"case": p["case"], "kind": "cv", "doc": p["doc"], "event": p["bracket"],
                           "title": p.get("title", ""), "when": dt.datetime.fromisoformat(p["when"]) if p.get("when") else None}
                          for p in pending]:
        key = (i["case"], i["doc"])
        if not i["doc"] or key in order_keys or key in cl_entries:
            continue
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
    added_opinions = []
    docs = list(cl.paged("recap-documents/", {
        "is_free_on_pacer": "true", "docket_entry__docket__court": "laed",
        "date_created__gte": f"{window_from}T00:00:00-05:00", "order_by": "date_created",
        "fields": "id,description,document_number,absolute_url,date_created"}))
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
        date = (ent or {}).get("date") or (created.date().isoformat() if created else today)
        judge = info["judge"] or case_judge.get(info["case"], "")
        if judge and not allowed(judge, date):
            continue
        desc = (r.get("description") or "").strip()
        added_opinions.append({"date": date, "judge": judge, "case": info["case"], "doc": doc,
                               "title": info["title"], "event": desc[:160], **opinion_flags(desc),
                               "src": "courtlistener_wo"})
        opinion_keys.add(key)

    # Rows for magistrate judges presiding by consent and visiting judges are kept;
    # the site charts only the judges listed in data/judges.json.
    no_judge = sum(1 for r in added_orders + added_opinions if not r["judge"])
    if no_judge:
        note.append(f"{no_judge} entries without a judge")

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
    if now.weekday() < 5 and today not in holidays:
        through_row["date"] = today
    note.append(f"RSS {len(rss)} items ({len(rss_civil)} civil); CourtListener {cl.calls} calls")
    note.extend(sorted(set(cl.errors)))
    runs.append({"at": now.isoformat(timespec="minutes"), "from": window_from, "to": today,
                 "orders_added": len(added_orders), "opinions_added": len(added_opinions),
                 "pending": len(new_pending), "ok": not cl.errors and bool(rss or cl.calls),
                 "note": "; ".join(note), "pending_items": new_pending})
    runs = runs[-500:]
    for r in runs[:-1]:
        r.pop("pending_items", None)

    save("orders", orders)
    save("opinions", opinions)
    save("calendar", calendar)
    save("runs", runs)
    print(f"orders +{len(added_orders)}, opinions +{len(added_opinions)}, pending {len(new_pending)}; " + "; ".join(note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
