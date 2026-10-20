"""Court information beyond the docket feed, read from public pages with no key and no fee:

- Motion submission dates: each section's civil submission calendar, which the court regenerates nightly
  (/sites/default/files/motion-dates/MoHear_A.htm for Section A; the sections come from data/judge_pages.json).
  Written to data/submission_dates.json, read once a day.
- Court notices: the court's news feed (/rss.xml) and its General Orders page, written to data/notices.json,
  read every six hours.
- Fifth Circuit decisions in cases from this court: the Fifth Circuit's opinions feed, read on every pass. Each
  Louisiana appeal (docket numbers 26-30xxx) has its PDF read for the district ("Appeal from the United States
  District Court for the Eastern District of Louisiana"), the district case number ("USDC No. 2:24-CV-1933"), and
  the disposition in capitals at the end ("AFFIRMED."). Written to data/appeals.json.

Everything read here is data, matched with regular expressions, never interpreted as instructions.
"""
from __future__ import annotations

import datetime as dt
import email.utils
import html
import io
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

COURT = "https://www.laed.uscourts.gov"
MOHEAR = COURT + "/sites/default/files/motion-dates/MoHear_{}.htm"
NEWS = COURT + "/rss.xml"
ORDERS = COURT + "/attorney-information/rules-and-orders/general-orders"
CA5_FEED = "https://www.ca5.uscourts.gov/feeds/opinions"
CA5_PDF = "https://www.ca5.uscourts.gov/opinions/"
NOTICES_HOURS = 6
SUBMISSION_HOURS = 20
CA5_PDF_BUDGET = 12        # PDFs read per pass
SEEN_DAYS = 120            # how long a Fifth Circuit item read once is remembered
NEWS_KEEP = 60
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"], 1)}


def text_of(fragment: str) -> str:
    """Plain text from an HTML fragment: tags dropped, entities decoded, spaces collapsed."""
    t = re.sub(r"<(script|style)\b.*?</\1>", " ", fragment or "", flags=re.S | re.I)
    t = re.sub(r"<br\s*/?>|</p>|</div>|</li>", "\n", t, flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    return "\n".join(" ".join(line.split()) for line in t.splitlines() if line.strip())


def long_date(s: str) -> str:
    """'November 11, 2026' as 2026-11-11, or ''."""
    m = re.match(r"\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})", s or "")
    if not m or m.group(1).lower() not in MONTHS:
        return ""
    try:
        return dt.date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2))).isoformat()
    except ValueError:
        return ""


# ---------------------------------------------------------------- motion submission dates
def parse_submission_dates(page: str) -> dict:
    """Civil submission dates from a section's MoHear page: the first column of its table, plus the
    'Last update: 15-Oct-26, 12:01 AM' stamp and the column heading ('Civil Wednesdays - 10:30 AM')."""
    head = re.search(r"Civil\s*(?:<br\s*/?>)?\s*([A-Za-z]+days?)\s*-\s*(\d{1,2}:\d\d\s*[AP]M)", page or "", re.I)
    dates = []
    for row in re.findall(r"<tr\b.*?</tr>", page or "", re.S | re.I):
        cell = re.search(r"<td\b[^>]*>(.*?)</td>", row, re.S | re.I)
        d = long_date(text_of(cell.group(1))) if cell else ""
        if d and d not in dates:
            dates.append(d)
    stamp = re.search(r"Last update:\s*([^<]+)", page or "", re.I)
    return {"dates": sorted(dates), "day": head.group(1).title() if head else "", "time": " ".join(head.group(2).upper().split()) if head else "",
            "updated": stamp.group(1).strip() if stamp else ""}


def update_submission_dates(old: dict, http_get, sections: dict, now: dt.datetime, note: list) -> dict:
    """sections maps judge code to section letter. Read once a day; a section that fails keeps its last copy."""
    last = old.get("checked", "")
    if last and now - dt.datetime.fromisoformat(last) < dt.timedelta(hours=SUBMISSION_HOURS):
        return old
    out = {"checked": now.isoformat(timespec="minutes"), "judges": dict(old.get("judges", {}))}
    read = 0
    for code, letter in sorted(sections.items()):
        if not re.fullmatch(r"[A-Z]", letter or ""):
            continue
        url = MOHEAR.format(letter)
        try:
            got = parse_submission_dates(http_get(url).decode("utf-8", "replace"))
        except Exception as e:  # keep the last copy for this section
            note.append(f"submission dates {letter} unavailable ({type(e).__name__})")
            continue
        if got["dates"]:
            out["judges"][code] = {"section": letter, "url": url, **got}
            read += 1
    note.append(f"submission dates read for {read} sections")
    return out


# ---------------------------------------------------------------- court notices
def parse_news(xml: bytes) -> list[dict]:
    root = ET.fromstring(xml)
    items = []
    for it in root.iter("item"):
        when = it.findtext("pubDate") or ""
        try:
            date = email.utils.parsedate_to_datetime(when).date().isoformat() if when else ""
        except (TypeError, ValueError):
            date = ""
        link = (it.findtext("link") or "").strip()
        if not link.startswith(COURT):
            continue
        summary = text_of(it.findtext("description") or "")
        items.append({"date": date, "title": " ".join((it.findtext("title") or "").split()), "url": link, "summary": summary[:400]})
    return items


def parse_general_orders(page: str) -> list[dict]:
    """Rows of the General Orders tables: category (the table caption), date, title, and the order's PDF."""
    rows = []
    for table in re.findall(r"<table\b.*?</table>", page or "", re.S | re.I):
        cap = re.search(r"<caption>(.*?)</caption>", table, re.S | re.I)
        category = text_of(cap.group(1)) if cap else ""
        for tr in re.findall(r"<tr\b.*?</tr>", table, re.S | re.I):
            d = re.search(r'content="(\d{4}-\d\d-\d\d)', tr)
            a = re.search(r'<a\s+href="([^"]+)"[^>]*>(.*?)</a>', tr, re.S | re.I)
            if not a:
                continue
            url = html.unescape(a.group(1))
            url = url if url.startswith("http") else COURT + url
            if not url.startswith(COURT):
                continue
            rows.append({"category": category, "date": d.group(1) if d else "", "title": text_of(a.group(2)), "url": url})
    return rows


def update_notices(old: dict, http_get, now: dt.datetime, note: list) -> dict:
    last = old.get("checked", "")
    if last and now - dt.datetime.fromisoformat(last) < dt.timedelta(hours=NOTICES_HOURS):
        return old
    today = now.date().isoformat()
    out = {"checked": now.isoformat(timespec="minutes"), "news": old.get("news", []), "orders": old.get("orders", [])}
    try:
        fresh = parse_news(http_get(NEWS))
        known = {n["url"]: n for n in out["news"]}
        for n in fresh:  # the first read marks nothing new
            n["first_seen"] = known[n["url"]].get("first_seen", "") if n["url"] in known else (today if known else "")
            known[n["url"]] = n
        out["news"] = sorted(known.values(), key=lambda n: (n["date"], n["url"]), reverse=True)[:NEWS_KEEP]
    except Exception as e:
        note.append(f"court news unavailable ({type(e).__name__})")
    try:
        rows = parse_general_orders(http_get(ORDERS).decode("utf-8", "replace"))
        if rows:
            seen = {r["url"]: r.get("first_seen", "") for r in out["orders"]}
            for r in rows:
                r["first_seen"] = seen.get(r["url"]) or (today if out["orders"] else "")  # the first read marks nothing new
            out["orders"] = sorted(rows, key=lambda r: (r["date"], r["title"]), reverse=True)
    except Exception as e:
        note.append(f"general orders unavailable ({type(e).__name__})")
    return out


# ---------------------------------------------------------------- Fifth Circuit
CA5_ITEM_RE = re.compile(r"^(\d\d-\d{5})\s+(.*)$")
ORIGIN_RE = re.compile(r"Appeal\s+from\s+the\s+United\s+States\s+District\s+Court\s+for\s+the\s+(\w+)\s+District\s+of\s+(\w+)", re.I)
USDC_RE = re.compile(r"USDC\s+No\.?\s*(\d):(\d\d)-(CV|CR|MC)-0*(\d{1,5})", re.I)
# The judgment in capitals, as a past participle ("AFFIRMED.") or a verb ("We AFFIRM", "we DISMISS the appeal").
DISPOSITION_RE = re.compile(r"\b(AFFIRM(?:ED)?|REVERSE[D]?|VACATE[D]?|REMAND(?:ED)?|RENDER(?:ED)?|MODIF(?:Y|IED)|DISMISS(?:ED)?)\b(\s+IN\s+PART)?")
LOWER_RE = re.compile(r"\b(?:we|court)\s+(?:therefore\s+|accordingly\s+|thus\s+)?(affirm|reverse|vacate|dismiss|remand)\b", re.I)
PAST = {"AFFIRM": "AFFIRMED", "REVERSE": "REVERSED", "VACATE": "VACATED", "REMAND": "REMANDED", "RENDER": "RENDERED", "MODIFY": "MODIFIED",
        "DISMISS": "DISMISSED"}


def parse_ca5_feed(xml: bytes) -> list[dict]:
    root = ET.fromstring(xml)
    out = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        m = CA5_ITEM_RE.match(" ".join((it.findtext("title") or "").split()))
        if not m or not link.startswith(CA5_PDF):
            continue
        desc = text_of(it.findtext("description") or "")
        kind = next((k for k in ("Published Opinion", "Unpublished Opinion", "Published Order", "Unpublished Order") if k in desc), "")
        released = re.search(r"Released\s+([A-Za-z]+ \d{1,2}, \d{4})", desc)
        out.append({"ca5": m.group(1), "caption": m.group(2), "pdf": link, "kind": kind,
                    "date": long_date(released.group(1)) if released else ""})
    return out


def disposition(text: str) -> str:
    """The judgment line in capitals ('AFFIRMED.', 'VACATED and REMANDED.', 'we DISMISS the appeal'), from the
    majority opinion: text after a 'dissenting:' or 'concurring:' heading is left out."""
    body = re.split(r"Circuit\s+Judge,\s+(?:dissenting|concurring)", text or "", maxsplit=1)[0]
    words = [(m.group(1), bool(m.group(2))) for m in DISPOSITION_RE.finditer(body)]
    if not words:  # some opinions state it in lower case at the end: "we affirm the district court's judgment"
        words = [(m.group(1).upper(), False) for m in LOWER_RE.finditer(body[-3000:])][-2:]
    if not words:
        return ""
    names = []
    for w, part in words[-4:]:  # the judgment comes last
        label = PAST.get(w, w).lower() + (" in part" if part else "")
        if label not in names:
            names.append(label)
    names = names[-3:]
    out = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    return out[0].upper() + out[1:]


def read_ca5_pdf(data: bytes) -> dict:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data), strict=False)
    first = reader.pages[0].extract_text() or ""
    full = "\n".join((p.extract_text() or "") for p in reader.pages[:40])
    origin = ORIGIN_RE.search(first)
    usdc = USDC_RE.search(first)
    return {"district": f"{origin.group(1).title()} District of {origin.group(2).title()}" if origin else "",
            "usdc": f"{usdc.group(1)}:{usdc.group(2)}-{usdc.group(3).lower()}-{int(usdc.group(4)):05d}" if usdc else "",
            "disposition": disposition(full), "pages": len(reader.pages)}


def update_appeals(old: dict, http_get, now: dt.datetime, note: list) -> dict:
    today = now.date().isoformat()
    cutoff = (now.date() - dt.timedelta(days=SEEN_DAYS)).isoformat()
    seen = {k: v for k, v in old.get("seen", {}).items() if v >= cutoff}
    appeals = list(old.get("appeals", []))
    try:
        items = parse_ca5_feed(http_get(CA5_FEED))
    except Exception as e:
        note.append(f"Fifth Circuit feed unavailable ({type(e).__name__})")
        return old
    try:
        import pypdf  # noqa: F401
    except ImportError:
        return old
    read = added = 0
    for it in items:
        if it["pdf"] in seen:
            continue
        if not it["ca5"][3:5] == "30":   # Louisiana appeals only (Fifth Circuit numbers 26-30xxx)
            seen[it["pdf"]] = today
            continue
        if read >= CA5_PDF_BUDGET:
            break
        read += 1
        try:
            info = read_ca5_pdf(http_get(it["pdf"], {"Accept": "application/pdf"}, 60))
        except Exception as e:  # tried again next pass
            note.append(f"Fifth Circuit PDF unavailable ({type(e).__name__})")
            continue
        seen[it["pdf"]] = today
        if info["district"] == "Eastern District of Louisiana" and "-cv-" in info["usdc"]:
            appeals = [a for a in appeals if a["pdf"] != it["pdf"]] + [{**it, **info, "case": info["usdc"], "seen": today}]
            added += 1
    if added:
        note.append(f"{added} Fifth Circuit decisions in civil cases from this court")
    appeals.sort(key=lambda a: (a["date"], a["ca5"]), reverse=True)
    out = {"seen": dict(sorted(seen.items())), "appeals": appeals}
    return old if out == old else out  # rewritten only when something changed, so a quiet pass commits nothing


# ---------------------------------------------------------------- docket details from CourtListener search results
DOCKET_FIELDS = {"referred": ("referredTo", "referred_to_str"), "nos": ("suitNature", "nature_of_suit"), "cause": ("cause",),
                 "jury": ("juryDemand", "jury_demand"), "jurisdiction": ("jurisdictionType", "jurisdiction_type"),
                 "filed": ("dateFiled", "date_filed"), "terminated": ("dateTerminated", "date_terminated")}
LIST_FIELDS = {"parties": ("party",), "attorneys": ("attorney",), "firms": ("firm",)}


def note_docket(dockets: dict, case: str, judge: str, d: dict, today: str) -> None:
    """Keep a docket's details from a CourtListener search result (type r) the updater already fetched: the
    magistrate judge, nature of suit, cause, jury demand, dates, and the parties, attorneys, and firms
    CourtListener lists (only for dockets someone has bought with parties). A change of district judge is logged."""
    if not case or "-cv-" not in case:
        return
    row = dockets.setdefault(case, {"case": case})
    for k, names in DOCKET_FIELDS.items():
        v = next((d.get(n) for n in names if d.get(n)), "")
        if isinstance(v, str) and v.strip():
            row[k] = v.strip()[:10] if k in ("filed", "terminated") else " ".join(v.split())[:120]
    for k, names in LIST_FIELDS.items():
        v = next((d.get(n) for n in names if d.get(n)), None)
        if isinstance(v, list) and v:
            row[k] = sorted({" ".join(str(x).split())[:100] for x in v if str(x).strip()})[:60]
    if d.get("docket_id"):
        row["docket_id"] = d["docket_id"]
    if judge:
        if row.get("judge") and row["judge"] != judge:
            row.setdefault("reassigned", []).append({"date": today, "from": row["judge"], "to": judge})
        row["judge"] = judge
    row["seen"] = today


def load_json(path: Path, empty):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return empty


def save_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=0, separators=(",", ":")) + "\n")
