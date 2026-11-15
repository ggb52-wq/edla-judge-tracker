"""Hearings, conferences, and trials on each judge's calendar, for the site's Calendar page. Three sources:

1. The court's public calendar (https://www.laed.uscourts.gov/court-calendar), whose right-hand frame,
   /sites/default/files/today/cal2.html, lists the coming seven days: a heading per date, then one block per judge
   ("Judge Wendy B. Vitter / 24-1933 Tran v Gulf Coast Bank - Jury Trial at 9:00 a.m. / Courtroom C-352"). A block
   can list several matters; each becomes its own row (parse_block). District judges and magistrate judges are read;
   criminal duty court is left out. The court notes that some proceedings are left off. Each read replaces the rows
   for the dates the page shows, so a proceeding taken off the calendar drops off here too.
2. Docket text that sets a proceeding ("Status Conference set for 11/4/2026 10:00 AM before Judge ..."), read from the
   entries the updater already fetches from CourtListener. A later entry setting the same kind of proceeding in the
   same case replaces the earlier one.

3. Minute entries in the court's RSS feed whose event names a proceeding held ("Status Conference", "Motion Hearing",
   "Jury Trial - Held"), kept by the day the entry was made.

The RSS feed carries event names but not docket text, so an entry that sets a proceeding ("Set Hearings") shows that
something was set without saying when; the site lists those straight from data/feed.json. All text here is data: it is matched with regular expressions and
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


# A minute entry's event name for a proceeding that took place ("Status Conference", "Motion Hearing", "Jury Trial - Held").
# Settlement conferences are left off the calendar (the owner's decision, Nov. 15, 2026).
HELD_RE = re.compile(r"^(?:(?:telephone|video|in-person|zoom)\s+)?(?:(?:status|scheduling|pretrial|final pretrial|preliminary|rule 16|discovery)\s+)?"
                     r"conference$|^motion hearing|^(?:jury|bench|non-jury) trial|^oral argument|^evidentiary hearing|"
                     r"^preliminary injunction hearing", re.I)


def held_event(event: str) -> str:
    """The proceeding a feed entry's event names as held, "" when it names none. "Order, Status Conference" is the
    conference; "~Util" additions are dropped."""
    for part in re.split(r"\s*,\s*(?=[A-Z~])|\s*;\s*", event or ""):
        name = re.sub(r"\s*~Util.*$", "", part, flags=re.I).strip()
        if HELD_RE.search(name):
            return name
    return ""


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


# ---------------------------------------------------------------- the court's calendar, one matter at a time
# A judge's block on the court's page is free text typed by chambers: a heading, then lines that name a courtroom, a
# time, a kind of docket ("Criminal Matters"), or one or more matters ("10:00AM: 23-59 Revocation, 26-40 Rearraignment").
# parse_block() turns the lines into one row per matter, so a civil oral argument listed under a judge's criminal
# docket is kept with its own time and case name.
CASE_RE = re.compile(r"(?<![\w-])(\d{2})(?:\s?-\s?(cr|cv|mj|mc|md)\s?-\s?|(cr|cv|mj|mc|md)|-)0*(\d{1,5})(?!\d)", re.I)
ROOM2_RE = re.compile(r"\b(?:Court\s?room|Room|Ctrm\.?)\s+([A-Z]?\s?-?\s?\d{2,4}[A-Z]?)\b", re.I)
HEAD_ROOM_RE = re.compile(r"\b([BC]\s?-?\s?\d{3})\b")
QUAL = (r"class certification|remand|competency|comp|show cause|daubert|markman|contempt|detention|fairness|final approval|"
        r"preliminary approval|evidentiary|preliminary injunction|injunction|motion|status|scheduling|final pretrial|pretrial|"
        r"pre-trial|telephone|video|settlement|discovery|rule 16|suppression|revocation|sentencing|restitution|tro|bond|change of plea")
WHAT_RE = re.compile(r"(?:jury|bench|non-jury)\s+trial|trial|oral\s+arguments?|(?:(?:" + QUAL + r")\s+){0,2}(?:hearings?|conference)|"
                     r"civil\s+motion\s+docket|motion\s+docket|re-?\s?arraignments?|arraignments?|sentencings?|"
                     r"revocations?(?:\s+of\s+supervised\s+release)?|"
                     r"change\s+of\s+plea|plea|naturalization(?:\s+ceremony)?|attorney\s+admissions?|investiture", re.I)
GENERIC_RE = re.compile(r"\b(?:matters?|matteres|docket|admissions?|naturalization|ceremony|investiture|grand jury)\b", re.I)
CRIM_WORD_RE = re.compile(r"\bcriminal\b|\b(?:re-?\s?)?arraignments?\b|\bsentencings?\b|\brevocations?\b|\bplea\b|\bsupervised release\b|"
                          r"\bcomp(?:etency)? hearing\b|\bdetention\b|\bsuppress", re.I)
USA_RE = re.compile(r"\b(?:USA|U\.\s?S\.\s?A\.?|United States(?: of America)?)\s+vs?\b", re.I)
VERSUS_RE = re.compile(r"\s(?:v|vs)\.?\s", re.I)
SEP_RE = re.compile(r"\s[-–—]+\s*|[-–—]+\s|[-–—]{2,}")
OFF_RE = re.compile(r"\bcancell?ed\b|\bcontinued\b|\bpostponed\b|\bvacated\b|\boff calendar\b|\breset\b", re.I)
PLACE_RE = re.compile(r"\bchambers\b|\btelephone\b|\bvideo\b|\bzoom\b|\bteams\b", re.I)
REF_RE = re.compile(r"\b(?:rec\.?|r\.?)\s?docs?\.?\s?(?:nos?\.?\s?)?(\d+)", re.I)
CIVIL_FROM = 1000   # criminal case numbers in this court stay in the low hundreds each year; a number this high is civil


def _room(text: str) -> str:
    m = ROOM2_RE.search(text or "")
    return re.sub(r"\s+", "", m.group(1)).upper() if m else ""


def _label(text: str) -> str:
    """A kind of proceeding as the site shows it: title case, singular ("Sentencings" is one sentencing per row)."""
    t = re.sub(r"\s+", " ", text or "").strip().title()
    t = re.sub(r"\b(Revocation|Sentencing|Arraignment|Rearraignment|Hearing|Argument)s\b", r"\1", t)
    return re.sub(r"\bRe-? ?Arraignment\b", "Rearraignment", t).replace(" Of ", " of ")


def _what(text: str) -> str:
    """The kind of proceeding a piece of text names: the last one, since the kind follows the case name."""
    found = [m.group(0) for m in WHAT_RE.finditer(text or "")]
    return _label(found[-1]) if found else ""


def _strip(text: str) -> str:
    """Text with times, courtrooms, floors, and section letters taken out, to see what words are left."""
    t = TIME_RE.sub(" ", text or "")
    t = ROOM2_RE.sub(" ", t)
    t = re.sub(r"\b\d+(?:st|nd|rd|th)\s+floor\b|\bsection\s+[A-Z]\b|\bat\b|\*+", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", re.sub(r"^[\s\W]+|[\s\W]+$", "", t)).strip()


def _title(text: str) -> str:
    t = REF_RE.sub(" ", TIME_RE.sub(" ", text or ""))
    t = re.sub(r"\*+|\bcancell?ed\b", " ", t, flags=re.I)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"^[\s,;:.\-–—(]+|[\s,;:\-–—(]+$", "", t)
    if re.fullmatch(r"(?:criminal|civil)(?:\s+matters?)?", t, re.I):
        return ""
    return t[:160] if re.search(r"[A-Za-z]{2}", t) else ""


def parse_block(lines: list[str], hint: str = "") -> list[dict]:
    """One row per matter in a judge's block. `lines` are the lines under the heading; `hint` is what the heading says
    after the judge's name ("Civil Motion Docket"). Rows carry time, case_short, what, title, room, text, and the marks
    crim (a criminal matter), civil (the line itself shows a civil case), cancelled, place, ref."""
    out: list[dict] = []
    st = {"time": "", "ctx": "", "ctx_time": None, "kind": "", "pending": None}
    room = ""
    place = ""

    def flush():
        p = st["pending"]
        if p and not p["used"]:
            out.append(p["row"])
        st["pending"] = None

    def set_time(t: str):
        if st["ctx"] or st["kind"]:
            if st["ctx_time"] is None:
                st["ctx_time"] = t
            elif st["ctx_time"] != t:      # a new time starts a new part of the docket
                flush()
                st["ctx"], st["kind"], st["ctx_time"] = "", "", None
        st["time"] = t

    def header(text: str, t: str):
        words = _strip(text)
        crim = bool(re.search(r"\bcriminal\b", words, re.I))
        civil = bool(re.search(r"\bcivil\b", words, re.I))
        kind = "Criminal Matters" if crim and not _what(re.sub(r"criminal", "", words, flags=re.I)) else _what(words)
        generic = bool(GENERIC_RE.search(words))
        if not (crim or civil or kind or (generic and t)):
            return False
        flush()
        st["ctx"] = "criminal" if crim else "civil" if civil else ""
        st["ctx_time"] = st["time"] or None
        st["kind"] = "" if kind == "Criminal Matters" else kind
        label = kind or _label(words)[:60]
        row = {"time": st["time"], "case_short": "", "what": label, "title": "", "text": text.strip()[:240]}
        if crim:
            row["crim"] = True
        if civil:
            row["civil"] = True
        if OFF_RE.search(text):
            row["cancelled"] = True
        st["pending"] = {"row": row, "used": False}
        return True

    if hint:
        header(hint, "")
    for raw in lines:
        if not room:
            room = _room(raw)
        line_kind = ""          # "Sentencings: 19-204 ...; 25-221": the kind named once for the whole line
        line_rows: list[dict] = []
        for chunk in [c for c in re.split(r"\s*;\s*", raw) if c.strip()]:
            tokens = list(CASE_RE.finditer(chunk))
            lead = TIME_RE.search(chunk)
            if not tokens:
                t = to_time(chunk)
                words = _strip(chunk)
                if not words or not re.search(r"[A-Za-z]{3}", words):      # a time, a courtroom, or both
                    if t:
                        late = [r for r in out if not r["time"]]
                        if not st["time"] and late:                         # "24-1693 Bench Trial" / "9:00AM, Room C551"
                            for r in late:
                                r["time"] = t
                        set_time(t)
                    continue
                if line_rows and not line_rows[-1]["title"] and VERSUS_RE.search(chunk):   # "22-cv-1903; Baldone v. Starr - Motion Hearing"
                    seps = list(SEP_RE.finditer(chunk))
                    cut = seps[-1].start() if seps and WHAT_RE.search(chunk[seps[-1].end():]) else len(chunk)
                    line_rows[-1]["title"] = _title(chunk[:cut])
                    if line_rows[-1]["what"] == "Proceeding" and _what(chunk[cut:]):
                        line_rows[-1]["what"] = _what(chunk[cut:])
                    if not USA_RE.search(chunk) and not line_rows[-1].get("crim"):
                        line_rows[-1]["civil"] = True
                    continue
                if t:
                    set_time(t)
                if header(chunk, t):
                    continue
                if PLACE_RE.search(words) and not place:
                    place = words[:60]
                elif WHAT_RE.search(words) or re.search(r"[A-Za-z]{3,}-{2,}", chunk):   # "HERNANDEZ---rearraignment"
                    row = {"time": to_time(chunk) or st["time"], "case_short": "", "what": _what(words) or st["kind"] or "Proceeding",
                           "title": "", "text": chunk.strip()[:240]}
                    if CRIM_WORD_RE.search(chunk) or st["ctx"] == "criminal":
                        row["crim"] = True
                    out.append(row)
                continue
            prefix = chunk[:tokens[0].start()]
            if lead and lead.start() <= 2 and lead.end() <= tokens[0].start():
                set_time(to_time(prefix))
            if re.search(r"\bcriminal\b", prefix, re.I):
                st["ctx"], st["ctx_time"] = "criminal", st["time"] or None
            elif re.search(r"\bcivil\b", prefix, re.I):
                st["ctx"], st["ctx_time"] = "civil", st["time"] or None
            # Several matters on one line: cut at the comma before each further case number.
            cuts = [0]
            keep = [tokens[0]]
            for a, b in zip(tokens, tokens[1:]):
                between = chunk[a.end():b.start()]
                if "," in between:
                    cuts.append(a.end() + between.rindex(",") + 1)
                    keep.append(b)
                elif re.fullmatch(r"\s*(?:and|&|/)?\s*", between):
                    cuts.append(b.start())
                    keep.append(b)
            cuts.append(len(chunk))
            prefix_kind = _what(TIME_RE.sub(" ", prefix))
            line_kind = prefix_kind or line_kind
            for i, tok in enumerate(keep):
                seg = chunk[cuts[i]:cuts[i + 1]]
                body = chunk[tok.end():cuts[i + 1]]
                kind = (tok.group(2) or tok.group(3) or "").lower()
                num = int(tok.group(4))
                seps = list(SEP_RE.finditer(body))
                tail = body[seps[-1].end():] if seps else ""
                what, title = "", ""
                if tail and (WHAT_RE.search(tail) or (to_time(tail) and 0 < len(_strip(tail).split()) <= 3)):
                    words = _strip(tail)
                    what = _label(words) if len(words.split()) <= 5 and not VERSUS_RE.search(" " + words + " ") else _what(tail)
                    title = _title(body[:seps[-1].start()])
                elif prefix_kind and i == 0 or prefix_kind and not WHAT_RE.search(body):
                    what, title = prefix_kind, _title(body)
                else:
                    found = list(WHAT_RE.finditer(body))
                    if found:
                        what = _label(found[-1].group(0))
                        title = _title(body[:found[-1].start()] + " " + body[found[-1].end():])
                    else:
                        what, title = line_kind or st["kind"] or "Proceeding", _title(body)
                if not title and i == 0 and VERSUS_RE.search(prefix):
                    title = _title(WHAT_RE.sub(" ", prefix))
                usa = bool(USA_RE.search(seg))
                civil = kind in ("cv", "md", "mc") or num >= CIVIL_FROM or bool(re.search(r"\bcivil\b|\bMDL\b", seg)) or \
                    (bool(VERSUS_RE.search(" " + title + " ")) and not usa)
                crim = kind in ("cr", "mj") or usa or bool(CRIM_WORD_RE.search(seg)) or \
                    (st["ctx"] == "criminal" and not civil)
                if crim and num < CIVIL_FROM or kind in ("cr", "mj"):
                    civil = False
                elif civil:
                    crim = False
                if st["ctx"] == "civil" and not crim:
                    civil = True
                row = {"time": to_time(body) or to_time(prefix) or st["time"],
                       "case_short": f"{tok.group(1)}-{kind}-{num}" if kind in ("cr", "mj") else f"{tok.group(1)}-{num}",
                       "what": what, "title": title, "text": re.sub(r"\s+", " ", (prefix if i else "") + seg).strip()[:240]}
                if crim:
                    row["crim"] = True
                if civil:
                    row["civil"] = True
                if OFF_RE.search(seg) or (i and OFF_RE.search(prefix)):
                    row["cancelled"] = True
                ref = REF_RE.search(body)
                if ref:
                    row["ref"] = "Rec. Doc. " + ref.group(1)
                if st["pending"]:
                    st["pending"]["used"] = True
                out.append(row)
                line_rows.append(row)
    flush()
    for r in out:
        r["room"] = room
        if place:
            r["place"] = place
    return out


def heading_of(line: str, judges: list[dict], magistrates: list[dict] | None = None) -> tuple[str, str, str, str]:
    """Who a block's heading names: (district judge code, magistrate judge code, what follows the name, courtroom).
    Duty court and anyone not on either list give ("", "", "", "")."""
    text = unescape(line)
    n = norm(text)
    if "duty court" in n:
        return "", "", "", ""
    code, mj, name = "", "", ""
    if "magistrate" in n:
        for j in magistrates or []:
            key = norm(j.get("short") or j["name"])
            if re.search(r"\b" + re.escape(key) + r"\b", n):
                mj, name = j["code"], key
                break
    else:
        code = judge_for(line, judges)
        name = next((norm(j["name"]) for j in judges if j["code"] == code), "")
    if not (code or mj):
        return "", "", "", ""
    last = name.split()[-1]
    m = re.search(re.escape(last), text, re.I)
    rest = text[m.end():] if m else ""
    room = HEAD_ROOM_RE.search(rest)
    hint = re.sub(r"^[\s,\-–—:]+", "", HEAD_ROOM_RE.sub(" ", rest)).strip()
    return code, mj, hint if re.search(r"[A-Za-z]{3}", hint) else "", re.sub(r"\s+", "", room.group(1)).upper() if room else ""


def parse_court_calendar(html: str, judges: list[dict], magistrates: list[dict] | None = None) -> tuple[list[dict], list[str]]:
    """Rows for the proceedings on the court's seven-day calendar, one per matter, and the dates the page covers. A
    district judge's rows carry `judge`; a magistrate judge's carry `mj` (duty court is left out)."""
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
            code, mj, hint, head_room = heading_of(lines[0], judges, magistrates)
            if not (code or mj):
                continue
            for m in parse_block(lines[1:], hint):
                row = {"date": date, "time": m.pop("time"), "judge": code, **({"mj": mj} if mj else {}), **m, "src": "court_calendar", "v": 2}
                row["room"] = row["room"] or head_room
                rows.append(row)
    return rows, dates


def resplit(row: dict) -> list[dict]:
    """A court-calendar row written before matters were split (one row per judge and day, its text the block's lines
    joined by " · "), read again as one row per matter. Rows already split come back unchanged."""
    if row.get("src") != "court_calendar" or row.get("v") == 2:
        return [row]
    out = []
    for m in parse_block([x for x in (row.get("text") or "").split(" · ") if x.strip()]):
        out.append({"date": row["date"], "time": m.pop("time"), "judge": row.get("judge", ""), **m, "src": "court_calendar", "v": 2,
                    **({"seen": row["seen"]} if row.get("seen") else {})})
    return out


def civil_case(row: dict, known: dict, case_judge: dict) -> str:
    """The civil case a calendar row names, "" when the row is criminal or the number cannot be tied to a civil case.
    `known` maps a short number ("24-1933") to the civil case on file. A number the line itself shows to be civil is
    spelled out even when the case is new to the site; any other number counts only when the civil case on file with
    that number is assigned to the judge whose calendar lists it."""
    short = row.get("case_short") or ""
    m = re.fullmatch(r"(\d{2})-(\d{1,5})", short)
    if row.get("crim") or not m:
        return ""
    case = known.get(short, "")
    if row.get("civil"):
        return case or f"2:{m.group(1)}-cv-{int(m.group(2)):05d}"
    if case and row.get("judge") and case_judge.get(case) == row["judge"]:
        return case
    return ""


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


def merge(old: list[dict], cal_rows: list[dict], cal_dates: list[str], docket_rows: list[dict], today: dt.date,
          held_rows: list[dict] | None = None) -> list[dict]:
    """data/hearings.json after one update: the court calendar's dates replaced by what it shows now; docket-text settings
    added, a later entry for the same kind of proceeding in the same case replacing an earlier one; minute entries
    from the feed added once each (the feed keeps 14 days, this file 60); old rows trimmed."""
    shown = set(cal_dates)
    rows = [r for r in old if not (r.get("src") == "court_calendar" and r["date"] in shown)]
    seen_cal = today.isoformat()
    rows += [{**r, "seen": seen_cal} for r in cal_rows]
    have = {(r.get("case"), str(r.get("doc"))) for r in rows if r.get("src") == "minute_entry"}
    for r in held_rows or []:
        if (r["case"], str(r["doc"])) not in have:
            have.add((r["case"], str(r["doc"])))
            rows.append(r)
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
