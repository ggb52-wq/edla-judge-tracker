"""Magistrate judges: data/magistrates.json for the Magistrates page.

Free sources only, all of them already read by the updater (no CourtListener calls are made here):
  - the roster below, checked against the court's magistrate judge listing (data/magistrate_pages.json, written daily by
    scripts/judge_pages.py --magistrates);
  - the referred magistrate judge of each civil case (data/dockets.json `referred`), with the name variants on file
    ("Janis Van Meerveld", "Michael North", "Dana Marie Douglas") mapped to one judge;
  - written opinions a magistrate judge signed: the signer named in the owner's PACER Written Opinions Reports
    (data/imports/wo_*.json) and, where no report names one, the signature block of the opinion's text in opinions_text/
    (the judge's name directly above "UNITED STATES MAGISTRATE JUDGE");
  - docket entries the court's RSS feed and the orders on file name "Settlement Conference", kept here after the feed
    drops them, each with what the same case's docket showed afterward (a settlement filing, a dismissal, a trial entry,
    a judgment).

The owner's decision (Nov. 2026): no settlement percentage or rate for any one magistrate judge, and no rate of district
judges adopting, modifying, or rejecting reports and recommendations. This file holds counts and case-by-case rows only.
District judge figures are not touched: an opinion a magistrate judge signed stays credited where the site had it, and
the signer is recorded here.

Case names, docket events, and opinion text come from whoever files: they are matched by pattern and stored as plain
text, never followed as instructions.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import import_written_opinions
import trials

# The court's magistrate judges, by CM/ECF initials. `former`: no longer a magistrate judge of this court (opinions and
# referrals on file stay listed). `pending`: selected but not yet on the court's listing; shown once the listing has a page.
ROSTER = [
    {"code": "DPC", "name": "Donna Phillips Currault", "short": "Currault"},
    {"code": "EJD", "name": "Eva J. Dossier", "short": "Dossier"},
    {"code": "MBN", "name": "Michael B. North", "short": "North"},
    {"code": "KWR", "name": "Karen Wells Roby", "short": "Roby"},
    {"code": "JVM", "name": "Janis van Meerveld", "short": "van Meerveld"},
    # Selected per the court's news of Oct. 15, 2026. The initials are a guess until CM/ECF shows them on a case number.
    {"code": "KDA", "name": "Kristen D. Amond", "short": "Amond", "pending": True},
    # Magistrate judge until December 2022, then a judge of the Fifth Circuit.
    {"code": "DMD", "name": "Dana M. Douglas", "short": "Douglas", "former": True},
]
CODES = {j["code"] for j in ROSTER}


def _letters(s: str) -> str:
    return re.sub(r"[^a-z ]+", " ", (s or "").lower())


_KEYS = [(j["code"], _letters(j["name"]).split()[0], _letters(j["short"]).split()) for j in ROSTER]


def code_of(name: str) -> str:
    """The roster judge a name refers to, by first name and surname, whatever sits between them or in front:
    "Janis Van Meerveld", "Magistrate Judge Michael North", "Dana Marie Douglas". "" for anyone else."""
    toks = _letters(name).split()
    for lead in ("the", "honorable", "hon", "chief", "us", "u", "s", "united", "states", "magistrate", "judge"):
        while toks and toks[0] == lead:
            toks = toks[1:]
    if not 2 <= len(toks) <= 5:
        return ""
    for code, first, last in _KEYS:
        if toks[0] == first and toks[-len(last):] == last and len(toks) - len(last) <= 3:
            return code
    return ""


# ---------------------------------------------------------------- who signed a written opinion
# The signature block, with everything but letters removed: "MICHAEL B. NORTH\n UNITED STATES MAGISTRATE JUDGE" and
# "KAREN WELLS ROBY\n UNITE\nD STATES MAGISTRATE JUDGE" both end up as NAME + UNITEDSTATESMAGISTRATEJUDGE. The CM/ECF
# stamp ("Case 2:23-cv-05992-JCZ-DPC") names the referred magistrate judge, not the signer, and is not used.
def _sig_names(j: dict) -> list[str]:
    toks = re.sub(r"[^A-Z ]+", "", j["name"].upper()).split()
    full = "".join(toks)
    bare = toks[0] + "".join(re.sub(r"[^A-Z ]+", "", j["short"].upper()).split())
    return [full] if full == bare else [full, bare]


_SIG = {n: j["code"] for j in ROSTER for n in _sig_names(j)}
SIGNATURE_RE = re.compile("(" + "|".join(sorted(_SIG, key=len, reverse=True)) + r")(?:CHIEF)?(?:UNITEDSTATES|US)MAGISTRATEJUDGE")


def signer_of(text: str) -> str:
    """The roster magistrate judge whose signature block ends an opinion's text; "" when there is none. When a text
    carries more than one (an order quoting another), the last one counts."""
    hits = SIGNATURE_RE.findall(re.sub(r"[^A-Z]+", "", (text or "").upper()))
    return _SIG[hits[-1]] if hits else ""


# A report and recommendation by its heading in the docket text: "REPORT AND RECOMMENDATIONS re ...", "PARTIAL REPORT AND
# RECOMMENDATION", "FINDINGS AND RECOMMENDATION", "ORDER AND REPORT AND RECOMMENDATION", "RECOMMENDATION AND ORDER ...".
RR_RE = re.compile(r"^(?:[A-Za-z]+,?\s+){0,3}?(?:(?:report|findings?)(?:\s+and|,)\s+(?:[a-z]+\s+and\s+)?recommendations?|"
                   r"(?:order\s+and\s+)?recommendations?(?:\s+and\s+order)?)\b", re.I)
ADOPTING_RE = re.compile(r"\b(?:adopt|approv)\w*\b", re.I)


def is_rr(text: str, event: str = "") -> bool:
    """A report and recommendation, by the heading of the clerk's docket text, by "IT IS RECOMMENDED" in its opening
    lines, or by the event name; an order adopting one is not."""
    head = (text or "").strip()[:300]
    if ADOPTING_RE.search(head[:60]) or ADOPTING_RE.search((event or "")[:40]):
        return False
    return bool(RR_RE.match(head)) or "IT IS RECOMMENDED" in head.upper() or bool(re.search(r"report and recommendation", event or "", re.I))


# What a report and recommendation addresses, from the clerk's docket text ("re 1 Petition for Writ of Habeas Corpus",
# "re 3 Complaint", "IT IS RECOMMENDED that the 68 Motion for Summary Judgment be ..."), the motions the text links, and the
# case's nature of suit. Checked in this order; "" when the text names none of them.
def about(row: dict) -> str:
    text = (row.get("text") or "")[:600]
    names = " ".join(m.get("name", "") for m in row.get("motions") or [] if isinstance(m, dict))
    nos = row.get("nos") or ""
    if re.search(r"habeas|28:\s?22(?:54|55|41)|pursuant to 28", text, re.I) or nos.startswith("Habeas"):
        return "habeas"
    if nos.startswith("Social Security"):
        return "social"
    both = names + " " + text
    if re.search(r"summary judgment", both, re.I):
        return "r56"
    if re.search(r"motion to dismiss|judgment on the pleadings", both, re.I):
        return "r12"
    if re.search(r"\bre\s+\d+\s+(?:\w+\s+){0,2}complaint\b|\bcomplaint\b[^.]{0,80}\bbe\s+dismissed", text, re.I):
        return "complaint"
    return "motion" if re.search(r"\bmotion\b", both, re.I) else ""


def load_reports(data_dir: Path) -> list[dict]:
    """Rows of the Written Opinions Report extracts (data/imports/wo_*.json)."""
    rows: list[dict] = []
    folder = Path(data_dir) / "imports"
    for f in sorted(folder.glob("wo_*.json")) if folder.exists() else []:
        try:
            rows += json.loads(f.read_text()).get("rows", [])
        except ValueError:
            continue
    return rows


def signed_opinions(old: dict, *, reports: list[dict], opinions: list[dict], text_index: dict, text_dir: Path, today: str) -> tuple[list[dict], str]:
    """Written opinions signed by a roster magistrate judge: [{date, mj, case, doc, title, event, rr, about, judge, consent, src}].
    `about` (reports and recommendations from a report row only): habeas, social, r56, r12, complaint, motion, or "".
    src `pacer_wo`: the report names the signer. src `opinion_text`: read from the signature block; texts are read once,
    when the updater first has them (those read since the last scan), and the rows found are carried forward."""
    on_file = {(o["case"], o["doc"]): o for o in opinions}
    rows: dict[tuple[str, str], dict] = {}
    for r in reports:
        if "magistrate" not in (r.get("signer_title") or "").lower() or "-cv-" not in r.get("case", ""):
            continue
        code = code_of(r.get("signer", ""))
        if not code:
            continue        # a magistrate judge of another district (a transferred case)
        o = on_file.get((r["case"], r["doc"]), {})
        initials = [x for x in r.get("initials", []) if isinstance(x, str)]
        presiding = initials[0] if initials else ""
        event = o.get("event") or import_written_opinions.event_for(r)
        rows[(r["case"], r["doc"])] = {
            "date": r.get("date", ""), "mj": code, "case": r["case"], "doc": str(r["doc"]), "title": (o.get("title") or r.get("title", ""))[:70],
            "event": event[:160], "rr": int(is_rr(r.get("text", ""), event)),
            "judge": o.get("judge", "") if o.get("judge", "") not in CODES else ("" if presiding in CODES else presiding),
            "consent": int(presiding in CODES or "CONMAG" in (r.get("flags") or [])), "src": "pacer_wo"}
        if rows[(r["case"], r["doc"])]["rr"]:
            rows[(r["case"], r["doc"])]["about"] = about(r)
    since = (old or {}).get("text_scanned", "")
    for r in (old or {}).get("opinions", []):
        if r.get("src") == "opinion_text" and (r["case"], r["doc"]) not in rows and (r["case"], r["doc"]) in on_file:
            rows[(r["case"], r["doc"])] = r
    for key, meta in (text_index or {}).items():
        case, _, doc = key.partition("|")
        o = on_file.get((case, doc))
        if o is None or (case, doc) in rows or "-cv-" not in case or (since and (meta.get("read") or "") < since):
            continue
        path = Path(text_dir) / f"{case.replace(':', '_')}_{doc}.txt"
        if not path.exists():
            continue
        code = signer_of(path.read_text(errors="replace"))
        if code:
            rows[(case, doc)] = {"date": o.get("date", ""), "mj": code, "case": case, "doc": str(doc), "title": o.get("title", "")[:70],
                                 "event": o.get("event", "")[:160], "rr": int(is_rr("", o.get("event", "")) or bool(o.get("rr"))),
                                 "judge": o.get("judge", "") if o.get("judge", "") not in CODES else "",
                                 "consent": int(o.get("judge", "") in CODES), "src": "opinion_text"}
    out = sorted(rows.values(), key=lambda r: (r["date"], r["case"], int(r["doc"]) if r["doc"].isdigit() else 0))
    return out, today


# ---------------------------------------------------------------- referrals
def referrals(dockets: dict, case_judge: dict, reports: list[dict], district: set[str]) -> tuple[dict, dict]:
    """Counts of civil cases by referred magistrate judge, and the map from each name on file to a roster code.
    `judges`: the district judge of each referred case, for the 16 current judges; other cases fall under "".
    `consent`: cases a Written Opinions Report shows the magistrate judge presiding over by consent (the CONMAG flag
    on a row that judge signed, or a case number that carries the magistrate judge's initials alone)."""
    names: dict[str, str] = {}
    by = {j["code"]: {"cases": 0, "consent": 0, "judges": {}} for j in ROSTER}
    civil = named = 0
    for case, d in dockets.items():
        if "-cv-" not in case:
            continue
        civil += 1
        ref = d.get("referred") or ""
        if not isinstance(ref, str) or not ref:
            continue
        code = names.get(ref)
        if code is None:
            code = names[ref] = code_of(ref)
        if not code:
            continue
        named += 1
        row = by[code]
        row["cases"] += 1
        dj = case_judge.get(case, "")
        dj = dj if dj in district else ""
        row["judges"][dj] = row["judges"].get(dj, 0) + 1
    consent: dict[str, set] = {}
    for r in reports:
        if "magistrate" not in (r.get("signer_title") or "").lower():
            continue
        code = code_of(r.get("signer", ""))
        initials = r.get("initials") or []
        if code and ("CONMAG" in (r.get("flags") or []) or (initials and initials[0] == code)):
            consent.setdefault(code, set()).add(r["case"])
    for code, cases in consent.items():
        by[code]["consent"] = len(cases)
    for row in by.values():
        row["judges"] = dict(sorted(row["judges"].items()))
    return {"civil": civil, "named": named, "by": by}, {k: v for k, v in sorted(names.items()) if v}


# ---------------------------------------------------------------- settlement conferences and what followed
CONFERENCE_RE = re.compile(r"^settlement conference\b", re.I)
RESET_RE = re.compile(r"set/reset|\breset\b", re.I)
# A settlement named by the event itself, the whole event and nothing more: "Settlement", "Settlement Agreement", "Notice of
# Settlement", "Order on Motion for Settlement", "Order on Motion to Approve Settlement", "Enforce Settlement Agreement".
# "Settlement Conference" and the Streamlined Settlement Program's opt-out orders are not settlements.
SETTLEMENT_RE = re.compile(r"^(?:(?:joint )?notice of |(?:order on )?(?:[\w/-]+ ){0,2}?(?:motion (?:for|to approve|to enforce) )|(?:approve|enforce) )?"
                           r"(?:[\w-]+ )?settlement(?: agreement)?$", re.I)
NOT_SETTLEMENT_RE = re.compile(r"conference|streamlined|program|opt[- ]?out", re.I)
DISMISSAL_RE = re.compile(r"^(?:order dismissing case|order of dismissal|judgment of dismissal|stipulation(?: and order)? of dismissal|"
                          r"notice of (?:voluntary )?dismissal|order on (?:[\w/-]+ ){0,2}motion to dismiss case)\b", re.I)
PARTY_RE = re.compile(r"^order on (?:[\w/-]+ ){0,2}motion to dismiss party\b", re.I)
JUDGMENT_RE = re.compile(r"^judgment\b(?! on the pleadings)", re.I)
SIGNS = ("settlement", "dismissal", "party", "trial", "judgment")


def _parts(event: str) -> list[str]:
    return [p.strip() for p in re.split(r"\s+AND\s+", event or "") if p.strip()]


def is_conference(event: str) -> bool:
    return any(CONFERENCE_RE.match(p) for p in _parts(event))


def sign_of(event: str) -> str:
    """What a later docket entry shows, by its event name alone (the feed gives no text):
    settlement: a filing or order that names a settlement ("Settlement", "Settlement Agreement", "Order on Motion for Settlement");
    dismissal: an order dismissing the case, a stipulation or notice of dismissal, or an order on a motion to dismiss the case;
    party: an order dismissing a party; trial: a trial day or jury verdict; judgment: a judgment. "" for anything else.
    A sign, never proof: the entry's text, which would say why, is on PACER."""
    for p in _parts(event):
        if SETTLEMENT_RE.match(p) and not NOT_SETTLEMENT_RE.search(p):
            return "settlement"
    for p in _parts(event):
        if DISMISSAL_RE.match(p):
            return "dismissal"
    for p in _parts(event):
        if trials.HELD_RE.search(p) or trials.VERDICT_RE.search(p):
            return "trial"
        if JUDGMENT_RE.match(p):
            return "judgment"
    for p in _parts(event):
        if PARTY_RE.match(p):
            return "party"
    return ""


def _num(doc) -> int:
    return int(doc) if str(doc).isdigit() else 0


def conference_log(old: dict, *, entries: list[dict], referred: dict, titles: dict, case_judge: dict, district: set[str]) -> tuple[list[dict], list[dict]]:
    """entries: docket entries from the feed and the orders on file ({case, doc, date, event}).
    Returns (conferences, signs). A conference row: {case, doc, date, title, judge, mj, reset}; `mj` is the case's referred
    magistrate judge when one is on file (the feed does not say who held the conference), `reset` marks an entry that
    also set or reset a hearing. A sign row: {case, doc, date, event, sign}, for entries dated on or after the case's
    first conference. Both are kept after the feed drops the entries."""
    confs = {(r["case"], str(r["doc"])): dict(r) for r in (old or {}).get("conferences", [])}
    for e in entries:
        case, doc, event = e.get("case", ""), str(e.get("doc", "")), str(e.get("event", ""))
        if "-cv-" not in case or not doc or not e.get("date") or not is_conference(event):
            continue
        row = confs.setdefault((case, doc), {"case": case, "doc": doc, "date": e["date"], "title": "", "judge": "", "mj": "", "reset": False})
        row["reset"] = bool(row.get("reset")) or bool(RESET_RE.search(event))
    for (case, _), row in confs.items():
        row["title"] = (titles.get(case) or row.get("title") or "")[:90]
        if not row.get("mj"):
            row["mj"] = referred.get(case, "")
        dj = case_judge.get(case, "")
        if dj in district:
            row["judge"] = dj
    first: dict[str, str] = {}
    for row in confs.values():
        first[row["case"]] = min(first.get(row["case"], "9999"), row["date"])
    signs = {(r["case"], str(r["doc"]), r["event"]): dict(r) for r in (old or {}).get("signs", []) if r.get("case") in first}
    for e in entries:
        case, doc, event = e.get("case", ""), str(e.get("doc", "")), str(e.get("event", ""))
        if case not in first or not e.get("date") or e["date"] < first[case] or (case, doc) in confs:
            continue
        kind = sign_of(event)
        if kind:
            signs.setdefault((case, doc, event[:160]), {"case": case, "doc": doc, "date": e["date"], "event": event[:160], "sign": kind})
    signs = {k: r for k, r in signs.items() if r["date"] >= first[r["case"]]}
    order = lambda r: (r["date"], r["case"], _num(r["doc"]))  # noqa: E731
    return sorted(confs.values(), key=order), sorted(signs.values(), key=order)


# ---------------------------------------------------------------- magistrates.json
def build(old: dict, *, data_dir: Path, dockets: dict, opinions: list[dict], entries: list[dict], titles: dict, case_judge: dict,
          judges: list[dict], text_index: dict, text_dir: Path, pages: dict, feed_since: str, today: str) -> dict:
    """pages: data/magistrate_pages.json (the court's listing, read daily); a `pending` roster judge is shown once it has a page."""
    district = {j["code"] for j in judges}
    listed = {r.get("code") for r in (pages or {}).get("judges", [])}
    division = {r.get("code"): (r.get("contact") or {}).get("division", "") for r in (pages or {}).get("judges", [])}
    reports = load_reports(data_dir)
    ops, scanned = signed_opinions(old, reports=reports, opinions=opinions, text_index=text_index, text_dir=text_dir, today=today)
    ref, names = referrals(dockets, case_judge, reports, district)
    referred = {case: names.get(d.get("referred") or "", "") for case, d in dockets.items() if isinstance(d.get("referred"), str)}
    confs, signs = conference_log(old, entries=entries, referred=referred, titles=titles, case_judge=case_judge, district=district)
    roster = []
    for j in ROSTER:
        if j.get("pending") and j["code"] not in listed:
            continue
        row = {"code": j["code"], "name": j["name"], "short": j["short"]}
        if j.get("former"):
            row["former"] = True
        if division.get(j["code"]):
            row["division"] = division[j["code"]]
        roster.append(row)
    return {"judges": roster, "names": names, "referred": ref, "feed_since": (old or {}).get("feed_since") or feed_since,
            "conferences": confs, "signs": signs, "text_scanned": scanned, "opinions": ops}


def same(a: dict, b: dict) -> bool:
    """Equal apart from the day the opinion texts were last scanned, which moves on every pass."""
    strip = lambda d: {k: v for k, v in (d or {}).items() if k != "text_scanned"}  # noqa: E731
    return strip(a) == strip(b)


def save(path: Path, data: dict) -> None:
    """One row per line for the lists, so a day's diff shows the rows that changed."""
    def rows(key: str) -> str:
        return ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in data[key])
    head = json.dumps({k: v for k, v in data.items() if k not in ("conferences", "signs", "opinions")}, ensure_ascii=False, separators=(",", ":"))[:-1]
    Path(path).write_text(head + ',\n"conferences":[\n' + rows("conferences") + '\n],\n"signs":[\n' + rows("signs")
                          + '\n],\n"opinions":[\n' + rows("opinions") + "\n]}\n", encoding="utf-8")
