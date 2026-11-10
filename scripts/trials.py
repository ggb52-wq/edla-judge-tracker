"""Trials: data/trials.json for the Trials page.

Free sources only, all of them already read by the updater:
  - the court's seven-day calendar (data/hearings.json, src court_calendar): each civil trial day, judge, courtroom;
  - trial settings read from docket text (hearings.json, src docket_text);
  - the RSS feed (this pass's read and the saved feed) and the orders on file: "Jury Trial - Begun", "- Held",
    "- Completed", "Jury Verdict", and the pretrial and post-trial entries in those cases (witness and exhibit lists,
    pretrial orders, proposed findings, judgments);
  - written opinions that are findings of fact and conclusions of law after a bench trial, with the witnesses each
    names, read from the opinion's text (opinions_text/).
Counsel comes to the site from data/dockets.json, when CourtListener lists it. Witness lists, minute entries, and
verdict forms are PACER documents and are not read.

Trial days and entries are kept after the calendar and the feed drop them. Everything here is data from filings and
court pages: it is matched and stored as plain text, never followed as instructions.
"""
from __future__ import annotations

import datetime as dt
import re
from pathlib import Path

KEEP_CALENDAR_DAYS = 55   # hearings.json keeps 60 days past; within that window it is authoritative (a removed day was cancelled)
MAX_EVENTS = 80           # docket entries kept per trial
MAX_WITNESSES = 60        # names kept per decision

TRIAL_WHAT_RE = re.compile(r"\b(?:jury|bench|non-?jury)\s+trial\b|^\s*trial\b", re.I)
PRETRIAL_RE = re.compile(r"pre-?trial", re.I)
# Minute entries for a trial day ("Jury Trial - Held") and the verdict; "Proposed Jury Verdict Form" is a pretrial filing.
HELD_RE = re.compile(r"(?:^|\bAND\s+)(?:(?:jury|bench|non-?jury)\s+)?trial\s*-\s*(?:begun|held|completed)\b", re.I)
VERDICT_RE = re.compile(r"(?:^|\bAND\s+)jury\s+verdict\b", re.I)
# Entries kept for a trial case: anything about the trial, its witnesses, exhibits, jury, pretrial steps, and judgment.
MILESTONE_RE = re.compile(r"trial|witness|exhibit|verdict|jury\s+(?:instructions|charge|note)|pretrial|findings of fact|"
                          r"^judgment\b|\bAND\s+judgment\b", re.I)
NOT_MILESTONE_RE = re.compile(r"^(?:jury demand|motion to continue trial)", re.I)
FFCL_RE = re.compile(r"findings\s+of\s+fact\s*(?:&|and)\s*conclusions\s+of\s+law", re.I)
PROPOSED_RE = re.compile(r"^\s*proposed\b", re.I)

# ---------------------------------------------------------------- witnesses named in a bench-trial decision
TITLE = (r"(?:Dr\.|Mr\.|Mrs\.|Ms\.|Captain|Capt\.|Officer|Deputy|Sergeant|Sgt\.|Trooper|Detective|Agent|Professor|Lieutenant|Lt\.|"
         r"Colonel|Col\.|Major|Maj\.|Commander|Cmdr\.|Chief|Admiral)")
WORD = r"(?:[A-Z]['’])?[A-Z][a-z]+(?:[A-Z][a-z]+)?(?:-[A-Z][a-z]+)?"
INIT = r"[A-Z]\."
SUFFIX = r"(?:,?\s+(?:Jr\.|Sr\.|III|II|IV))"
NOEND = r"(?![a-z])(?!\s+[A-Z]\.(?=\s|$))"     # "Sean P." cut off by a footnote is not a whole name
FULL = rf"(?:{TITLE}\s+){{0,2}}{WORD}(?:\s+(?:{INIT}|{WORD}))?\s+{WORD}{SUFFIX}?{NOEND}"
TITLED = rf"(?:{TITLE}\s+){{1,2}}{WORD}{NOEND}"
ANY = rf"(?:{FULL}|{TITLED}|{WORD}{NOEND})"
ADVERB = r"(?:(?:also|further|credibly|later|then|similarly|likewise|specifically|consistently|repeatedly|candidly)\s+)?"
APPOS = r"(?:\s+(?:of|from)\s+[^,.;]{1,60})?(?:,\s*(?:(?:[a-z]|[A-Z][\w-]*['’]s?\s)[^,.;]{0,89},\s*)?)?"
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"

PATTERNS = [
    re.compile(rf"(?<![\w’'])({ANY}){APPOS}\s+{ADVERB}testified\b"),                      # "Michael Lang, an employee, testified"
    re.compile(rf"\btestimony\s+(?:of|from|by)\s+({FULL}|{TITLED})"),                       # "heard testimony from David Villarrubia"
    re.compile(rf"(?<![\w’'])({ANY})['’]s\s+(?:[\w,]+\s+){{0,4}}?testimony\b"),             # "Holden’s deposition testimony"
    re.compile(rf"\bcalled\s+({FULL}|{TITLED})\s+as\s+(?:a|an|its|their|his|her)\s+(?:\w+\s+)?witness"),
    re.compile(rf"(?<![\w’'])({FULL}|{TITLED}){APPOS}\s+was\s+called\s+(?:as\s+(?:a|an)\s+(?:\w+\s+)?witness|to\s+testify)"),
]
LIST_TAIL = re.compile(rf"\s*(?:,\s*(?:and\s+)?|\s+and\s+)({FULL}|{TITLED})")
STOP = set("""The This That These Those Court Plaintiff Plaintiffs Defendant Defendants Government United States Although
Specifically First Second Third Fourth Also Thus Whereas Moreover However Further Furthermore Accordingly Here Both Each
Neither Defense Expert Judge Magistrate Honorable Petitioner Petitioners Respondent Respondents Claimant Claimants
Limitation Louisiana Parish Company Inc Corporation Corp Insurance Marine Services Bank Trust Section Rule Article Federal
Fifth Circuit District Eastern Coast Guard Jones Act Exhibit Exhibits Deposition Trial Testimony Witness Witnesses Doc
Document Page Case Id See In On At As After Before When While Because Since Under Following During Finally Additionally
Similarly Notably Indeed Likewise Next Then He She They His Her Their It Its Other Another No None Several Many All Some
Two Three Four Five Lay Defendants’ Plaintiffs’ Mister Doctor Seaman Captain Vessel Barge Port Harbor Department Office
Sheriff Police State City Parish School Board Hospital Center Medical Health Center University Group Holdings Partners
Oil Gas Energy Offshore Shipyard Towing Transportation Logistics America American National International General Southern
Gulf Northern Western Their Its Our Your Whether Despite Nor Yet Only Even Mrs Ms Mr Dr Agency Administration Service
Union Association Church Broker Master Engineer Electrician Superintendent President Owner Operator Manager Crew
Deckhand Mate Pilot Surveyor Adjuster Representative Employee Witness Juror Jury Trial Hearing Transcript""".split())
HEADER_RE = re.compile(r"Case\s+\d:\d\d-[a-z]{2}-\d{3,5}(?:-[A-Z]{2,4}){0,3}\s+Document\s+\d+(?:-\d+)?\s+Filed\s+\d\d/\d\d/\d\d\s+"
                       r"Page\s+\d+\s+of\s+\d+(?:\s+PageID\s*#?\s*\d+)?(?:\s+\d{1,3}(?=\s))?")
SENT_END = re.compile(r"[.!?][”\"’]?\s+(?=[A-Z“\"(])")
ABBREV = {"Dr", "Mr", "Ms", "Mrs", "St", "Capt", "Sgt", "Lt", "Col", "Maj", "Gen", "Cmdr", "Prof", "No", "Co", "Jr", "Sr", "Inc", "Corp", "Ltd", "v", "al", "U.S", "Nos", "Id", "Cir", "La", "Fed", "App", "Supp", "Ct", "R", "Civ", "P", "Rec", "Doc", "Stat", "Ann", "Art", "seq", "cf", "e.g", "i.e"}
TRIED_RE = re.compile(rf"(?:trial|tried)([^.]{{0,90}}?)\b({MONTH}\s+\d{{1,2}}(?:(?:\s*[-–,]\s*|\s+(?:and|through|to)\s+)"
                      rf"(?:{MONTH}\s+)?\d{{1,2}}(?!\d))*\s*,?\s+\d{{4}})")


def clean_text(text: str) -> str:
    """One line of text, with the CM/ECF page stamps removed (they split sentences and names)."""
    return HEADER_RE.sub(" ", re.sub(r"\s+", " ", text or "")).strip()


def _tokens(name: str) -> list[str]:
    return re.sub(rf"^(?:{TITLE}\s+)+", "", name).replace(",", " ").split()


def _ok(name: str) -> bool:
    toks = _tokens(name)
    return (bool(toks) and not (len(toks) > 1 and toks[0].endswith("ing"))   # "Bolstering Schutzman" opens a sentence
            and not any(t.rstrip(".") in STOP or re.fullmatch(TITLE, t) for t in toks if not re.fullmatch(INIT, t)))


def _surname(name: str) -> str:
    toks = [t for t in _tokens(name) if t not in ("Jr.", "Sr.", "II", "III", "IV")]
    return toks[-1] if toks else ""


def _ends(text: str, lo: int, hi: int):
    """Sentence ends between lo and hi, skipping abbreviations ("Dr.", "U.S.") and initials ("J.")."""
    for m in SENT_END.finditer(text, lo, hi):
        word = re.search(r"([\w.]+)$", text[max(0, m.start() - 12):m.start()])
        w = word.group(1) if word else ""
        if w in ABBREV or re.fullmatch(r"[A-Z]", w) or re.fullmatch(r"(?:[A-Za-z]\.)+[A-Za-z]", w):
            continue
        yield m


def _sentence(text: str, pos: int) -> str:
    starts = [m.end() for m in _ends(text, max(0, pos - 400), pos)]
    start = starts[-1] if starts else max(0, pos - 200)
    end_m = next(_ends(text, pos, len(text)), None)
    end = end_m.start() + 1 if end_m else min(len(text), pos + 260)
    s = text[start:end].strip()
    if len(s) > 280:
        rel = pos - start
        a = max(0, rel - 120)
        s = ("…" if a else "") + s[a:a + 260].strip() + "…"
    return s


# A witness is marked expert only where the opinion says so next to the name: "Michael Klein, an expert in ...",
# "LaShip’s expert engineer" after the name, "expert Robert Galbraith", "expert testimony of Robert Bartlett",
# "... was tendered and accepted as an expert".
EXPERT_FORMS = [
    r"\b{sur}\b,?\s+(?:(?:a|an|the|their|its|his|her|[A-Z][\w’']*['’]s?)\s+)?(?:[a-z-]+\s+){{0,2}}expert\b",
    r"\bexpert(?:\s+witness)?,?\s+(?:{title}\s+){{0,2}}(?:[A-Z][\w.]*\s+){{0,2}}{sur}\b",
    r"\b{sur}\b[^.]{{0,80}}\b(?:tendered|accepted|qualified|admitted|recognized)\s+(?:by\s+the\s+Court\s+)?as\s+an?\s+expert",
]


def witnesses(text: str) -> list[dict]:
    """People an opinion says testified: [{name, expert, quote}], in the order the opinion first names them.
    A name given by surname alone ("Holden testified") is matched to the full name the opinion uses elsewhere
    ("Sherry Holden"); one the opinion never gives in full is left out unless it carries a title ("Dr. Katz",
    "Captain Dewey"). Read by pattern, so a name can be missed or misread; each row keeps the sentence it came from."""
    t = clean_text(text)
    hits: list[tuple[int, str]] = []
    for pat in PATTERNS:
        for m in pat.finditer(t):
            hits.append((m.start(1), m.group(1)))
            if pat is PATTERNS[1]:  # "testimony from A, B, and C"
                end = m.end(1)
                while (n := LIST_TAIL.match(t, end)):
                    hits.append((n.start(1), n.group(1)))
                    end = n.end(1)
    hits.sort()
    full: dict[str, dict] = {}       # key: surname + first given name, lower case
    by_surname: dict[str, str] = {}
    out: list[dict] = []

    def key_of(name: str) -> str:
        toks = [x for x in _tokens(name) if not re.fullmatch(INIT, x) and x not in ("Jr.", "Sr.", "II", "III", "IV")]
        return (toks[0] + " " + toks[-1]).lower() if len(toks) > 1 else toks[-1].lower()

    def add(name: str, pos: int):
        name = re.sub(r"\s+", " ", name).strip().rstrip(",")
        k = key_of(name)
        if k in full:
            row = full[k]
            if name.startswith(("Dr.", "Professor")) and not row["name"].startswith(("Dr.", "Professor")):
                row["name"] = name
            return
        row = {"name": name, "expert": False, "quote": _sentence(t, pos)}
        full[k] = row
        by_surname.setdefault(_surname(name).lower(), k)
        out.append(row)

    single = []
    for pos, name in hits:
        if not _ok(name):
            continue
        if len(_tokens(name)) >= 2:
            add(name, pos)
        else:
            single.append((pos, name))
    for pos, name in single:
        sur = _surname(name)
        if sur.lower() in by_surname:
            continue
        found = None
        for m in re.finditer(rf"\b((?:{TITLE}\s+){{0,2}}({WORD})(?:\s+{INIT})?\s+{re.escape(sur)}){SUFFIX}?\b", t):
            given = m.group(2)
            alone = len(re.findall(rf"\b{re.escape(given)}\b(?!['’]s)(?!(?:\s+{INIT})?\s+{re.escape(sur)})", t))
            if _ok(m.group(1)) and alone <= 1:    # "Fandal" and "the Meg" stand alone elsewhere; "Sherry" does not
                found = m.group(1)
                break
        if found:
            add(found, pos)
        elif re.match(TITLE, name):
            add(name, pos)
    for row in out:
        sur = re.escape(_surname(row["name"]))
        row["expert"] = any(re.search(p.format(sur=sur, title=TITLE), t) for p in EXPERT_FORMS)
    return out[:MAX_WITNESSES]


def tried(text: str) -> str:
    """When the opinion says the trial took place ("tried to the Court on March 3–4, 2025"), from its opening pages."""
    t = clean_text(text)[:8000]
    for m in TRIED_RE.finditer(t):
        before = t[max(0, m.start() - 40):m.start()]
        # "The State suit proceeded to trial in October 2022 and on December 19, 2022 ...": another court, another date
        if re.search(r"\bstate\b|appeal|deposition|hearing", before + m.group(1), re.I) or re.search(r"\d{4}", m.group(1)):
            continue
        return re.sub(r"\s*([-–])\s*", r"\1", re.sub(r"\s+,", ",", m.group(2)))
    return ""


# ---------------------------------------------------------------- award amounts stated in opinions
# The clerk's closing entry in the FJC file usually carries no amount, and verdict forms and judgments are PACER documents.
# A written opinion after trial often states the amount: "The jury found Avondale negligent and awarded Plaintiffs
# $6,625,000 in general damages", "judgment in favor of Plaintiff in the amount of $1,396,664.93", "The general damage award
# is remitted to $3,900,000.00". These readers find such sentences. A sentence can state one part of an award (one
# plaintiff, one element of damages), and a later ruling can change it, so every amount is kept with its sentence.
MONEY = r"\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d+)?\s*(?:million|billion)|\d{4,}(?:\.\d{2})?)"
AWARD_PATTERNS = [
    ("verdict", re.compile(r"\bjury\b[^.;$]{0,140}?\b(?:awarded|awarding|returned a verdict|verdict (?:of|for|in the amount of)|award of)\b[^.;$]{0,120}?" + MONEY, re.I)),
    ("judgment", re.compile(r"(?<![-\w])judgment\b[^.;$]{0,160}?\b(?:in the (?:total |principal )?(?:amount|sum) of|for)\s+" + MONEY, re.I)),
    # "the Court" with a capital is this court; "the court awarded $200,000" describes another court's case.
    ("court", re.compile(r"\b(?:[Tt]he|[Tt]his) Court\s+(?:hereby\s+)?(?:awards|awarded|finds that [^.;$]{0,60}? is entitled to(?: recover)?)\b[^.;$]{0,140}?" + MONEY)),
    ("remitted", re.compile(r"\bremit(?:ted|s)?\b[^.;$]{0,80}?\bto\s+" + MONEY, re.I)),
]
# A sentence about another case ("Id. at 148. The jury awarded $7,500,000 ...", "947 So. 2d 171") is not this case's award.
CITATION_RE = re.compile(r"\b(?:Id\.|So\. ?[23]d|F\. ?(?:2d|3d|4th)|F\. ?Supp|F\. ?App|La\. App|Cir\. \d{4}|WL \d)")
FEES_RE = re.compile(r"attorney|\bfees?\b|\bcosts\b|interest|sanction", re.I)
# Not an award: what a jury could or should have awarded, what a party asked for, and hypotheticals.
NOT_AWARD_RE = re.compile(r"\b(?:could|would|should|might|may|can|must|cannot)\b[^$]{0,40}\b(?:award|remit)|\b(?:asked|asks|request\w*|sought|seeks?|urged?|argu\w*|contend\w*|"
                          r"if the jury|whether the jury|unless|bond|settle\w*)\b", re.I)
VERDICT_ZONE = (0.30, 8000)   # a jury's award is stated in an opinion's background; later "the jury awarded" sentences mostly describe other cases
MAX_AWARDS = 8      # amounts kept per case


def money(text: str) -> float:
    """"6,625,000" -> 6625000.0; "6.625 million" -> 6625000.0; 0 when the text is not an amount."""
    m = re.fullmatch(r"([\d,]*\d(?:\.\d+)?)\s*(million|billion)?", (text or "").strip(), re.I)
    if not m:
        return 0.0
    try:
        n = float(m.group(1).replace(",", ""))
    except ValueError:
        return 0.0
    return round(n * {"million": 1e6, "billion": 1e9}.get((m.group(2) or "").lower(), 1), 2)


def awards(text: str) -> list[dict]:
    """Amounts an opinion states as awarded: [{kind, amount, quote}], kind verdict (a jury's), judgment, court (the
    court's own award), remitted, or fees (the sentence concerns fees, costs, interest, or sanctions). The first sentence
    of each kind and amount is kept."""
    t = clean_text(text)
    out: list[dict] = []
    seen = set()
    zone = max(len(t) * VERDICT_ZONE[0], VERDICT_ZONE[1])
    for kind, pat in AWARD_PATTERNS:
        for m in pat.finditer(t):
            if kind == "verdict" and m.start() > zone:
                break
            if (CITATION_RE.search(t[max(0, m.start() - 150):m.start()]) or CITATION_RE.search(t[m.start():m.end() + 60])
                    or NOT_AWARD_RE.search(t[max(0, m.start() - 100):m.end()])):
                continue
            amount = money(m.group(1))
            k = "fees" if FEES_RE.search(m.group(0)) else kind
            if amount < 100 or (k, amount) in seen:
                continue
            seen.add((k, amount))
            out.append({"kind": k, "amount": amount, "quote": _sentence(t, m.start(1))})
    return out


def find_awards(opinions: list[dict], starts: dict, text_dir: Path) -> list[dict]:
    """starts: case -> the day its trial began (or its decision was filed). Reads each written opinion in those cases
    filed on or after that day and returns [{case, doc, date, kind, amount, quote}], the earliest opinion for each
    kind and amount, at most MAX_AWARDS a case."""
    out: list[dict] = []
    per: dict[str, set] = {}
    for o in sorted(opinions, key=lambda r: (r.get("date", ""), r.get("case", ""), str(r.get("doc", "")))):
        case = o.get("case", "")
        if case not in starts or o.get("date", "") < starts[case]:
            continue
        path = Path(text_dir) / f"{case.replace(':', '_')}_{o['doc']}.txt"
        if not path.exists():
            continue
        have = per.setdefault(case, set())
        for a in awards(path.read_text(errors="replace")):
            if (a["kind"], a["amount"]) in have or len(have) >= MAX_AWARDS:
                continue
            have.add((a["kind"], a["amount"]))
            out.append({"case": case, "doc": str(o["doc"]), "date": o.get("date", ""), **a})
    return out


def trial_starts(trial_rows: list[dict], decisions: list[dict], closed: list[dict]) -> dict:
    """The first day on file for each case's trial: from the FJC's closed-case rows, the calendar and feed, and decisions."""
    starts: dict[str, str] = {}

    def note(case: str, day: str) -> None:
        if case and day and day < starts.get(case, "9999"):
            starts[case] = day
    for r in closed or []:
        if r.get("trial"):
            note(r.get("case", ""), r.get("began") or r.get("ended") or r.get("term", ""))
    for t in trial_rows:
        held = [e["date"] for e in t.get("events", []) if HELD_RE.search(e["event"]) or VERDICT_RE.search(e["event"])]
        note(t["case"], min((t.get("days") or []) + held, default=""))
    for d in decisions:
        note(d["case"], d.get("date", ""))
    return starts


# ---------------------------------------------------------------- trials.json
def _civil(case: str) -> bool:
    return "-cv-" in (case or "")


def is_trial_proceeding(what: str) -> bool:
    return bool(TRIAL_WHAT_RE.search(what or "")) and not PRETRIAL_RE.search(what or "")


def kind_of(texts: list[str], decided: bool) -> str:
    joined = " ".join(texts)
    if re.search(r"\bbench\b|non-?jury", joined, re.I) or decided:
        return "bench"
    if re.search(r"\bjury\s+(?:trial|verdict)", joined, re.I):
        return "jury"
    return ""


def build(old: dict, *, hearings: list[dict], entries: list[dict], opinions: list[dict], titles: dict, case_judge: dict,
          text_dir: Path, today: str, closed: list[dict] | None = None) -> dict:
    """entries: docket entries from the feed and the orders on file ({case, doc, date, event})."""
    cutoff = (dt.date.fromisoformat(today) - dt.timedelta(days=KEEP_CALENDAR_DAYS)).isoformat()
    prev = {r["case"]: r for r in (old or {}).get("trials", [])}

    cal: dict[str, list[dict]] = {}
    sets: dict[str, list[dict]] = {}
    for h in hearings:
        case = h.get("case", "")
        if not _civil(case) or not is_trial_proceeding(h.get("what", "")):
            continue
        if h.get("src") == "court_calendar":
            cal.setdefault(case, []).append(h)
        elif h.get("date", "") >= today:
            sets.setdefault(case, []).append(h)

    held_cases = {e["case"] for e in entries if _civil(e.get("case", "")) and (HELD_RE.search(e.get("event", "")) or VERDICT_RE.search(e.get("event", "")))}
    cases = set(cal) | set(sets) | held_cases | {c for c, r in prev.items() if any(d < cutoff for d in r.get("days", [])) or r.get("held")}

    by_case_entries: dict[str, list[dict]] = {}
    for e in entries:
        if e.get("case") in cases and MILESTONE_RE.search(e.get("event", "")) and not NOT_MILESTONE_RE.search(e.get("event", "")):
            by_case_entries.setdefault(e["case"], []).append(e)

    decisions = []
    for o in sorted(opinions, key=lambda r: (r.get("date", ""), r.get("case", ""))):
        ev = o.get("event", "")
        if not FFCL_RE.search(ev) or PROPOSED_RE.search(ev) or not _civil(o.get("case", "")):
            continue
        path = Path(text_dir) / f"{o['case'].replace(':', '_')}_{o['doc']}.txt"
        text = path.read_text(errors="replace") if path.exists() else ""
        row = {"case": o["case"], "doc": o["doc"], "date": o.get("date", ""), "judge": o.get("judge", ""),
               "title": o.get("title", "") or titles.get(o["case"], ""), "pages": o.get("pages"),
               "pdf": o.get("pdf", ""), "url": o.get("url", ""), "text": bool(text)}
        if text:
            row["tried"] = tried(text)
            row["witnesses"] = witnesses(text)
        decisions.append({k: v for k, v in row.items() if v not in (None, "")})
    decided = {}
    for d in decisions:
        decided.setdefault(d["case"], []).append(d)

    trials = []
    for case in sorted(cases):
        p = prev.get(case, {})
        rows = cal.get(case, [])
        days = sorted({d for d in p.get("days", []) if d < cutoff} | {h["date"] for h in rows})
        events = {(e["date"], e["doc"], e["event"]): e for e in p.get("events", [])}
        for e in by_case_entries.get(case, []):
            events.setdefault((e.get("date", ""), e.get("doc", ""), e["event"]), {"date": e.get("date", ""), "doc": e.get("doc", ""), "event": e["event"]})
        ev_list = sorted(events.values(), key=lambda e: (e["date"], int(e["doc"]) if str(e["doc"]).isdigit() else 0))[-MAX_EVENTS:]
        held = bool(p.get("held")) or any(HELD_RE.search(e["event"]) or VERDICT_RE.search(e["event"]) for e in ev_list)
        set_for = sorted(({"date": h["date"], "time": h.get("time", ""), "what": h.get("what", "")} for h in sets.get(case, [])),
                         key=lambda r: (r["date"], r["time"]))
        if not days and not set_for and not held:
            continue  # a setting that was removed, and no sign of a trial
        first = min(days + [e["date"] for e in ev_list if HELD_RE.search(e["event"])] or [d["date"] for d in set_for] or [today])
        decision = [d for d in decided.get(case, []) if d["date"] >= first]
        latest = max(rows, key=lambda h: (h["date"], h.get("time", "")), default=None)
        row = {
            "case": case,
            "title": titles.get(case) or p.get("title", "") or (latest or {}).get("title", ""),
            "judge": (latest or {}).get("judge") or case_judge.get(case) or p.get("judge", ""),
            "kind": kind_of([h.get("what", "") for h in rows + sets.get(case, [])] + [e["event"] for e in ev_list] + [p.get("kind", "")], bool(decision)),
            "days": days,
            "set_for": set_for,
            "room": (latest or {}).get("room") or p.get("room", ""),
            "events": ev_list,
            "held": held,
            "first_seen": p.get("first_seen", today),
        }
        if decision:
            row["decision"] = {"doc": decision[-1]["doc"], "date": decision[-1]["date"]}
        trials.append({k: v for k, v in row.items() if v not in ("", [], None) or k in ("days", "events")})
    return {"trials": trials, "decisions": decisions,
            "awards": find_awards(opinions, trial_starts(trials, decisions, closed or []), Path(text_dir))}
