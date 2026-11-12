"""Authorities cited in each written opinion: data/citations.json.

Reads the opinion texts in opinions_text/ and finds full case citations (volume, reporter, page, or a Westlaw number),
with the case name before the citation and the court and year in the parenthetical after it. Each opinion counts an
authority once, however often the opinion cites it. The site counts, for any set of rulings, how many of them cite each
authority: the Motions page's "Authorities" panel and the Ask panel's answers to "what should I cite" questions.

Output, data/citations.json:
  version, built, opinions (number read)
  auth: [[key, name, court, year], ...]   one row per authority; the row's position is its number
  ops:  {"2:24-cv-01933|377": [numbers...]}   every opinion read, with the authorities it cites (an empty list when none)

Runs incrementally: an opinion already in `ops` is not read again, so a pass reads only new texts. --rebuild reads all.
The text is data from court PDFs; nothing in it is acted on. Test: tests/test_citations.py.
"""
import argparse
import collections
import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXTS = ROOT / "opinions_text"
OUT = ROOT / "data" / "citations.json"

# Reporters, each as (pattern, canonical form). Order matters: longer forms first.
REPORTERS = [
    (r"U\.\s?S\.", "U.S."),
    (r"S\.\s?Ct\.", "S. Ct."),
    (r"L\.\s?Ed\.\s?2d", "L. Ed. 2d"),
    (r"F\.\s?4th", "F.4th"),
    (r"F\.\s?3d", "F.3d"),
    (r"F\.\s?2d", "F.2d"),
    (r"F\.\s?Supp\.\s?3d", "F. Supp. 3d"),
    (r"F\.\s?Supp\.\s?2d", "F. Supp. 2d"),
    (r"F\.\s?Supp\.", "F. Supp."),
    (r"F\.\s?App['’]?x", "F. App'x"),
    (r"F\.\s?R\.\s?D\.", "F.R.D."),
    (r"B\.\s?R\.", "B.R."),
    (r"So\.\s?3d", "So. 3d"),
    (r"So\.\s?2d", "So. 2d"),
    (r"F\.(?=\s+\d)", "F."),
    (r"So\.(?=\s+\d)", "So."),
]
REPORTER_RE = "|".join("(?:%s)" % p for p, _ in REPORTERS)
CITE_RE = re.compile(r"(?<![\w.§])(\d{1,4})\s+(" + REPORTER_RE + r")\s+(\d{1,5})(?![\d])")
WL_RE = re.compile(r"(?<![\w])((?:19|20)\d\d)\s+WL\s+(\d{3,9})(?![\d])")
# The parenthetical right after the citation (and any pin cites): "(5th Cir. 2019)", "(E.D. La. Mar. 3, 2020)", "(2019)".
PAREN_RE = re.compile(r"^(?:\s*,\s*(?:at\s+)?\*?\d[\d\-–, *n.]*)?\s*\(([^()]{0,80}?)\)")
YEAR_RE = re.compile(r"((?:18|19|20)\d\d)\s*$")
# The case name just before the citation: "Wiwa v. Royal Dutch Petroleum Co., " or "In re Katrina Canal Breaches, ".
NAME_RE = re.compile(r"((?:In re|Ex parte|Matter of)\s+[^;:()]{2,90}?|[A-Z0-9][^;:()]{0,90}?\s+v\.\s+[^;:()]{1,90}?),\s*$")
SIGNALS = re.compile(r"^(?:\W+|see(?:,?\s+e\.g\.,?)?|see also|see generally|cf\.|but see|but cf\.|accord|compare|quoting|citing|also|and|e\.g\.,?|in(?!\s+re\b)|the|of|under|as in|also in|explained in|held in|stated in|noted in|court in|fifth circuit in)\s+", re.I)
ABBREV = {"corp", "univ", "bros", "dist", "auth", "mgmt", "natl", "comm", "cnty", "intl", "prods", "servs", "assocs", "indus", "envtl",
          "hosp", "educ", "assn", "ass'n", "dep't", "gov't", "int'l", "nat'l", "sys", "tech", "transp", "props", "invs", "mktg", "pharms",
          "labs", "elecs", "elec", "chem", "fire", "auto", "mfrs", "ctys", "parish", "serv", "indem", "prot", "prop", "assur", "hldgs", "enters", "sols", "grp", "invest", "ctr", "agric", "inst", "med", "metro", "cmty", "fed'n", "comm'n", "comm'r", "sec'y", "admin", "civ", "corr", "dev", "engr", "found", "ltd", "mut", "ret"}
CANON = [(re.compile(p), c) for p, c in REPORTERS]


def canon_reporter(raw):
    for pat, c in CANON:
        if pat.fullmatch(raw):
            return c
    return re.sub(r"\s+", " ", raw)


def clean_name(raw):
    s = re.sub(r"\s+", " ", raw).strip(" ,\"'“”‘’")
    s = re.sub(r",\s*(?:No|Nos|Civ|Civil|Case|Docket)\.?\s.*$", "", s)   # a docket number between the name and a Westlaw cite
    # A name can run back across a sentence; keep the part after the last sentence end. A period ends a sentence after
    # a lowercase word of four or more letters that is not an abbreviation common in case names ("Corp.", "Univ.").
    cut = 0; vpos = s.find(" v. ")
    for m in re.finditer(r"([A-Za-z'’]+|[\]\)\d])\.[\"”’]?\s+(?=[A-Z])", s):
        w = m.group(1)
        if (len(w) >= 4 and w[-1].islower() and w.lower().strip("'’") not in ABBREV) or w in ")]" or w.isdigit():
            if vpos < 0 or m.end() <= vpos:
                cut = m.end()
    # A footnote number left in the text ("... opinions 11 Waltman v. Int'l Paper Co.") also starts the name.
    for m in re.finditer(r"(?:^|\s)\d{1,3}\s+(?=[A-Z])", s):
        if vpos < 0 or m.end() <= vpos:
            cut = max(cut, m.end())
    s = s[cut:]
    for _ in range(4):
        t = SIGNALS.sub("", s)
        if t == s:
            break
        s = t
    s = s.strip(" ,\"'“”‘’")
    if not re.search(r"\bv\.\s|^(?:In re|Ex parte|Matter of)\b", s):
        return ""
    return s[:120]


def court_of(paren):
    """'5th Cir. 2019' -> ('5th Cir.', '2019'); 'E.D. La. Mar. 3, 2020' -> ('E.D. La.', '2020'); '2019' -> ('', '2019')."""
    p = re.sub(r"\s+", " ", paren or "").strip()
    m = YEAR_RE.search(p)
    if not m:
        return "", ""
    year = m.group(1)
    rest = p[: m.start()].strip(" ,")
    rest = re.sub(r"\s*\d{1,2}/\d{1,2}/?$", "", rest)   # "S.D. Tex. 4/11/2011"
    rest = re.sub(r"\s*(?:Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec)\.?\s*\d{0,2},?$", "", rest).strip(" ,")
    if len(rest) > 40 or re.search(r"\b(?:quoting|citing|internal|alteration|emphasis|cleaned|per curiam)\b", rest, re.I):
        rest = ""
    return rest, year


def extract(text):
    """Full case citations in one text: {key: (name, court, year)}; each authority once."""
    found = {}
    text = re.sub(r"\s+", " ", text.replace("\u00ad", ""))   # a name or parenthetical can break across lines
    for m in list(CITE_RE.finditer(text)) + list(WL_RE.finditer(text)):
        if m.re is CITE_RE:
            vol, rep, page = m.group(1), canon_reporter(m.group(2)), m.group(3)
            key = f"{vol} {rep} {page}"
        else:
            key = f"{m.group(1)} WL {m.group(2)}"
        before = text[max(0, m.start() - 260): m.start()]
        nm = NAME_RE.search(before)
        name = clean_name(nm.group(1)) if nm else ""
        pm = PAREN_RE.match(text[m.end(): m.end() + 120])
        court, year = court_of(pm.group(1)) if pm else ("", "")
        if key.endswith(" WL " + key.split()[-1]) and not year:
            year = key.split()[0]
        old = found.get(key)
        if not old or (not old[0] and name) or (not old[2] and year):
            found[key] = (name or (old[0] if old else ""), court or (old[1] if old else ""), year or (old[2] if old else ""))
    return found


def key_of(path):
    """2_24-cv-01933_377.txt -> 2:24-cv-01933|377"""
    m = re.match(r"^(\d)_(\d\d-[a-z]{2}-\d{5})_(\w+)\.txt$", path.name)
    return f"{m.group(1)}:{m.group(2)}|{m.group(3)}" if m else ""


def load(path=OUT):
    try:
        d = json.loads(path.read_text())
        if d.get("version") == 1:
            return d
    except (OSError, ValueError):
        pass
    return {"version": 1, "auth": [], "ops": {}}


def update(texts=TEXTS, out=OUT, today=None, rebuild=False):
    d = {"version": 1, "auth": [], "ops": {}} if rebuild else load(out)
    auth = d["auth"]
    index = {row[0]: i for i, row in enumerate(auth)}
    names = collections.defaultdict(collections.Counter)
    added = 0
    for path in sorted(texts.glob("*.txt")):
        key = key_of(path)
        if not key or key in d["ops"]:
            continue
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        ids = []
        for cite, (name, court, year) in extract(text).items():
            i = index.get(cite)
            if i is None:
                i = index[cite] = len(auth)
                auth.append([cite, name, court, year])
            row = auth[i]
            if name:
                names[i][name] += 1
            if court and not row[2]:
                row[2] = court
            if year and not row[3]:
                row[3] = year
            ids.append(i)
        d["ops"][key] = sorted(ids)
        added += 1
    # The name most opinions use for an authority read in this pass, unless one is already on file.
    for i, c in names.items():
        if not auth[i][1] or rebuild:
            auth[i][1] = c.most_common(1)[0][0]
    if added or rebuild:
        d["built"] = today or dt.date.today().isoformat()
        d["opinions"] = len(d["ops"])
        write(d, out)
    return added


def write(d, out):
    # One authority and one opinion per line, so diffs stay readable.
    lines = ["{", f'"version": 1,', f'"built": {json.dumps(d.get("built", ""))},', f'"opinions": {d.get("opinions", len(d["ops"]))},', '"auth": [']
    lines += [json.dumps(r, ensure_ascii=False) + ("," if i < len(d["auth"]) - 1 else "") for i, r in enumerate(d["auth"])]
    lines += ["],", '"ops": {']
    items = sorted(d["ops"].items())
    lines += [json.dumps(k) + ": " + json.dumps(v, separators=(",", ":")) + ("," if i < len(items) - 1 else "") for i, (k, v) in enumerate(items)]
    lines += ["}", "}"]
    out.write_text("\n".join(lines) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--rebuild", action="store_true", help="read every opinion again")
    a = ap.parse_args(argv)
    n = update(rebuild=a.rebuild)
    d = load()
    print(f"read {n} opinions; {len(d['ops'])} on file, {len(d['auth'])} authorities")


if __name__ == "__main__":
    sys.exit(main())
