"""Hearings, conferences, and trials on each judge's calendar, for the site's Calendar page. Two sources:

1. The court's public calendar (https://www.laed.uscourts.gov/court-calendar), whose right-hand frame,
   /sites/default/files/today/cal2.html, lists the coming seven days: a heading per date, then one block per judge
   ("Judge Wendy B. Vitter / 24-1933 Tran v Gulf Coast Bank - Jury Trial at 9:00 a.m. / Courtroom C-352"). The court
   notes that some proceedings are left off. Each read replaces the rows for the dates the page shows, so a proceeding
   taken off the calendar drops off here too.
2. Docket text that sets a proceeding ("Status Conference set for 11/4/2026 10:00 AM before Judge ..."), read from the
   entries the updater already fetches from CourtListener. A later entry setting the same kind of proceeding in the
   same case replaces the earlier one.

The RSS feed carries event names but not docket text, so it shows that something was set or held without saying when;
the site reads those straight from data/feed.json. All text here is data: it is matched with regular expressions and
copied, never followed.
"""
from __future__ import annotations

import datetime as dt
import re
from html import unescape

CALENDAR_URL = "https://www.laed.uscourts.gov/sites/default/files/today/cal2.html"
KEEP_PAST_DAYS = 60          # how long past proceedings stay in data/hearings.json
MAX_AHEAD_DAYS = 550         # settings further out than this are ignored as misreads

MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"], 1)}
DATE_HEAD_RE = re.compile(r"<p class='date'>\s*<strong>\s*(?:[A-Za-z]+day\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s*</strong>", re.I)
ROW_RE = re.compile(r"<div class='Rightrow'>\s*<p>(.*?)</p>\s*</div>", re.I | re.S)
TIME_RE = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?![a-z])", re.I)
SHORT_CASE_RE = re.compile(r"\b(\d{2})-(\d{1,5})\b")
ROOM_RE = re.compile(r"\b(?:Courtroom|Room)\s+([A-Z]?-?\d{2,4}[A-Z]?)\b", re.I)
KIND_RE = re.compile(r"jury trial|bench trial|trial|oral argument|evidentiary hearing|preliminary injunction|motion hearing|"
                     r"hearing|pretrial conference|status conference|scheduling conference|settlement conference|conference|"
                     r"rearraignment|arraignment|sentencing|revocation|plea|criminal matters|naturalization", re.I)

# "Status Conference set for 11/4/2026 10:00 AM", "Jury Trial reset for 3/1/2027 at 8:30 a.m.", "Oral Argument set for 11/12/2026".
SET_RE = re.compile(r"((?:[A-Za-z][\w/&'-]*\s+){0,4}?(?:Conference|Hearing|Trial|Argument))\s+(?:is\s+|was\s+|has been\s+)?(?:re-?)?set\s+"
                    r"(?:for|on)\s+(\d{1,2})/(\d{1,2})/(\d{2,4})(?:\s+(?:at\s+)?(\d{1,2}:\d{2}\s*[AaPp]\.?\s*[Mm]\.?))?", re.I)
# A criminal matter on the court's calendar ("24-37 Rearraignment", "26-211 Criminal Hearing", "21-138 USA v. Reed- Revocation")
# carries a short number like a civil case's, so it is never matched to the civil case with the same year and number.
CRIMINAL_RE = re.compile(r"\bcriminal\b|\b(?:re)?arraignment\b|\bsentencings?\b|\brevocation\b|\bplea\b", re.I)


def is_criminal(text: str) -> bool:
    return bool(CRIMINAL_RE.search(text or "")) and not re.search(r"\bcivil\b", text or "", re.I)


LEAD_WORDS = {"a", "an", "the", "order", "orders", "scheduling", "minute", "entry", "and", "by", "setting", "that", "court", "hearings",
              "notice", "of", "is", "are", "accordingly", "it", "ordered", "further", "regarding", "re", "on", "to", "in"}


def to_time(text: str) -> str:
    """"9:00 a.m." or "10:00AM" or "1:30 pm" -> "09:00"/"13:30"; "" when there is none."""
    m = TIME_RE.search(text or "")
    if not m:
        return ""
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3).lower()
    if not (1 <= h <= 12 and mi < 60):
        return ""
    h = h % 12 + (12 if ap == "p" else 0)
    return f"{h:02d}:{mi:02d}"


def norm(s: str) -> str:
    return re.sub(r"[^a-z]+", " ", (s or "").lower()).strip()


def judge_for(line: str, judges: list[dict]) -> str:
    """The district judge a calendar block names, by last name ("Judge Anna St John" -> ASJ); "" for magistrate judges,
    duty court, and anyone else."""
    n = norm(unescape(line))
    if "magistrate" in n or "duty court" in n:
        return ""
    for j in judges:
        if re.search(r"\b" + re.escape(norm(j["name"])) + r"\b", n):
            return j["code"]
    return ""


def kind_of(text: str) -> str:
    m = KIND_RE.search(text or "")
    return m.group(0).title() if m else ""


def parse_court_calendar(html: str, judges: list[dict]) -> tuple[list[dict], list[str]]:
    """Rows for the district judges on the court's seven-day calendar, and the dates the page covers."""
    rows, dates = [], []
    heads = list(DATE_HEAD_RE.finditer(html))
    for i, h in enumerate(heads):
        month = MONTHS.get(h.group(1).lower())
        if not month:
            continue
        try:
            date = dt.date(int(h.group(3)), month, int(h.group(2))).isoformat()
        except ValueError:
            continue
        dates.append(date)
        chunk = html[h.end(): heads[i + 1].start() if i + 1 < len(heads) else len(html)]
        for block in ROW_RE.findall(chunk):
            lines = [re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", x))).strip()
                     for x in re.split(r"<br\s*/?>", block, flags=re.I)]
            lines = [x for x in lines if x]
            if not lines:
                continue
            code = judge_for(lines[0], judges)
            if not code:
                continue
            body = lines[1:]
            text = " · ".join(body)[:300]
            rows.append({"date": date, "time": to_time(text), "judge": code,
                         "case_short": "-".join(SHORT_CASE_RE.search(text).groups()) if SHORT_CASE_RE.search(text) else "",
                         "what": kind_of(text) or "Proceeding", "room": (ROOM_RE.search(text).group(1) if ROOM_RE.search(text) else ""),
                         "text": text, "src": "court_calendar"})
    return rows, dates


# "The Status Conference set for 11/4/2026 is CANCELLED": the entry takes a setting off, it does not make one.
UNSET_RE = re.compile(r"(?:\s+before\s+(?:Magistrate\s+|District\s+)?Judge(?:\s+[A-Z][\w.'-]*){1,4})?\s*,?\s*"
                      r"(?:is|are|was|has\s+been|shall\s+be)\s+(?:hereby\s+)?"
                      r"(?:cancell?ed|continued|vacated|terminated|reset|rescheduled|upset|withdrawn)\b", re.I)


def settings_from_text(text: str, today: dt.date) -> list[dict]:
    """Proceedings a docket entry's text sets, with their dates and times."""
    out = []
    for m in SET_RE.finditer(text or ""):
        if UNSET_RE.match(text, m.end()):
            continue
        words = m.group(1).split()
        while words and words[0].lower().strip(":.,;") in LEAD_WORDS:
            words.pop(0)
        what = " ".join(w.strip(":.,;") for w in words).title()
        mo, d, y = int(m.group(2)), int(m.group(3)), int(m.group(4))
        y = y + 2000 if y < 100 else y
        try:
            date = dt.date(y, mo, d)
        except ValueError:
            continue
        if not what or abs((date - today).days) > MAX_AHEAD_DAYS:
            continue
        out.append({"date": date.isoformat(), "time": to_time(m.group(5) or ""), "what": what})
    return out


def merge(old: list[dict], cal_rows: list[dict], cal_dates: list[str], docket_rows: list[dict], today: dt.date) -> list[dict]:
    """data/hearings.json after one update: the court calendar's dates replaced by what it shows now; docket-text settings
    added, a later entry for the same kind of proceeding in the same case replacing an earlier one; old rows trimmed."""
    shown = set(cal_dates)
    rows = [r for r in old if not (r.get("src") == "court_calendar" and r["date"] in shown)]
    seen_cal = today.isoformat()
    rows += [{**r, "seen": seen_cal} for r in cal_rows]
    for r in docket_rows:
        key = (r["case"], r["what"].lower())
        doc = int(r["doc"]) if str(r.get("doc", "")).isdigit() else 0
        later_exists = any(x.get("src") == "docket_text" and (x["case"], x["what"].lower()) == key
                           and (int(x["doc"]) if str(x.get("doc", "")).isdigit() else 0) > doc for x in rows)
        if later_exists:
            continue
        # An earlier setting of the same proceeding that has not happened yet was reset by this entry.
        rows = [x for x in rows if not (x.get("src") == "docket_text" and (x["case"], x["what"].lower()) == key
                                        and (int(x["doc"]) if str(x.get("doc", "")).isdigit() else 0) <= doc
                                        and (x["date"] >= today.isoformat() or x["date"] == r["date"]))]
        rows.append(r)
    floor = (today - dt.timedelta(days=KEEP_PAST_DAYS)).isoformat()
    rows = [r for r in rows if r["date"] >= floor]
    rows.sort(key=lambda r: (r["date"], r.get("time") or "99:99", r.get("judge", ""), r.get("case", "") or r.get("case_short", "")))
    return rows
