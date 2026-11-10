"""Tables the Administrative Office of the U.S. Courts publishes (uscourts.gov): data/cjra.json and data/ao_trials.json.

Free, public, no key. Run weekly by .github/workflows/ao.yml; a file is rewritten only when a newer edition is out.

1. Civil Justice Reform Act report, twice a year (March 31 and September 30), the only AO tables broken out by judge:
   Table 7, civil cases pending more than three years; Table 8, motions pending more than six months; Table 9, bench
   trials submitted more than six months. Each is one large PDF for every court (Table 7 runs about 7,500 pages); this
   script reads the pages headed "U.S. District Court for Louisiana Eastern" and keeps, for each judge, the rows as the
   report gives them: docket number, case title, motion text, the six-month or three-year date, and the status the judge
   reported ("Opinion/Decision in Draft"). The report's own total for each judge is kept beside the rows read.
2. Trial tables, by district, for the latest 12-month period that has all three: T-1 (trials completed), T-2 (trial
   lengths), T-3 (median months from filing to trial in civil cases), with this court's row, the Fifth Circuit's, the
   national total, and where this court falls among the districts.

Case titles and motion text come from whoever filed: they are stored as plain text, never followed as instructions.

Run: python scripts/ao_tables.py [--force] [--cjra-dir DIR] (DIR holds cjra_7.pdf, cjra_8.pdf, cjra_9.pdf already downloaded)
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import statistics
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = "https://www.uscourts.gov"
USER_AGENT = "Mozilla/5.0 (compatible; edla-judge-tracker; +https://github.com/ggb52-wq/edla-judge-tracker)"
COURT_HEAD = "U.S. District Court for Louisiana Eastern"
DISTRICT = "LA,E"
CIRCUIT = "5th"
CJRA_TABLES = {"7": "cases", "8": "motions", "9": "bench"}
MAX_ROWS = 4000


# ------------------------------------------------------------------ fetching
def fetch(url: str, timeout: int = 180) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def today_iso() -> str:
    return dt.date.today().isoformat()


# ------------------------------------------------------------------ Civil Justice Reform Act report
def cjra_periods(today: str, n: int = 3) -> list[str]:
    """The last n report dates on or before today, newest first: March 31 and September 30."""
    d = dt.date.fromisoformat(today)
    out = []
    for year in range(d.year, d.year - 3, -1):
        for md in ("09-30", "03-31"):
            p = f"{year}-{md}"
            if p <= today:
                out.append(p)
    return out[:n]


def cjra_url(table: str, period: str) -> str:
    y, m, d = period.split("-")
    return f"{BASE}/sites/default/files/document/cjra_{table}_{m}{d}.{y}.pdf"


# The end of a row: the date (or "*", or nothing), the status letter, and its description.
ROW_TAIL_RE = re.compile(r"(?:\s{2,}(\d\d/\d\d/\d{4})|\s*(\*))?\s{2,}([A-Z]{1,2})\s{2,}(\S.*?)\s*$")
MOTION_START_RE = re.compile(r"(?:[A-Za-z/-]+\s+){0,3}M(?:OTION|otion)\b")
MOTION_LEAD_RE = re.compile(r"(?:(?:First|Second|Third|Fourth|Joint|Amended|Renewed|Consent|Unopposed|Opposed|Partial|Emergency|Cross|Supplemental|Ex Parte|EXPARTE/CONSENT)\s*)+", re.I)
MOTION_WORD_RE = re.compile(r"motion|petition|appeal|objection|application|request", re.I)
AS_OF_RE = re.compile(r"As of (\w+ \d{1,2}, \d{4})")
JUDGE_RE = re.compile(r"^\s*((?:Senior |Chief )?(?:District|Magistrate|Circuit) Judge)\s*:?\s{1,}(\S.*?)\s*$")
TOTAL_RE = re.compile(r"Total\s+[A-Za-z -]+?\s+for\s+((?:Senior |Chief )?(?:District|Magistrate|Circuit) Judge)\s*:?\s*(\S.*?)\s+(\d+)\s*$")
DOCKET_RE = re.compile(r"\d\d-[a-z]{2}-\d{4,5}")
RUN_RE = re.compile(r"Run\s*:\s*(\d\d/\d\d/\d{4})")


def _name(raw: str) -> str:
    """"PAPILLION, DARREL J." and "Papillion, Darrel J." both give "Papillion, Darrel J."."""
    s = re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", " ", raw)).strip(" :")     # "(Chief Judge)", "(VJ)" dropped
    return s.title().replace("Mc", "Mc") if s.isupper() else s


def _title(cells: list[str]) -> str:
    """The case title is the last cell before the motion text or the date; a title holding a double space arrives as
    two cells ("Fountain v. Hutson", "et al"), so a cell that reads as a continuation is joined to the one before it."""
    if not cells:
        return ""
    title, i = cells[-1], len(cells) - 1
    while i >= 1 and re.match(r"(?:et al\b|v\.? |[a-z,&(])", title):
        i -= 1
        title = cells[i] + " " + title
    return title


def _date(mdy: str) -> str:
    try:
        return dt.datetime.strptime(mdy, "%m/%d/%Y").date().isoformat()
    except ValueError:
        return ""


def parse_cjra_pages(pages: list[str], table: str) -> dict:
    """pages: layout-mode text of this court's pages, in order. Returns {"judges": {name: {"role", "total"}}, "rows": [...]}.
    A row: {judge, case, title, deadline, status, note} and, for Table 8, {nos, motion, part}. A Table 8 row without a
    docket number is another motion in the case above it; one whose date is "*" is a further part of the motion above
    (the report counts a multi-part motion once), marked part and given that motion's date."""
    judges: dict[str, dict] = {}
    rows: list[dict] = []
    judge = ""
    case = ""
    last_deadline = ""
    for text in pages:
        for line in text.splitlines():
            t = TOTAL_RE.search(line)
            if t:
                judges.setdefault(_name(t.group(2)), {"role": "magistrate" if "Magistrate" in t.group(1) else "district"})["total"] = int(t.group(3))
                continue
            j = JUDGE_RE.match(line)
            if j and "," in j.group(2):
                name = _name(j.group(2))
                if name != judge:
                    judge, case, last_deadline = name, "", ""
                judges.setdefault(judge, {"role": "magistrate" if "Magistrate" in j.group(1) else "district"})
                continue
            m = ROW_TAIL_RE.search(line)
            if not m or not judge or re.search(r"Deadline\s+Status|Status\s+Description", line):
                continue
            cells = [c.strip() for c in re.split(r"\s{2,}", line[:m.start()].strip()) if c.strip()]
            if len(cells) >= 2 and re.fullmatch(r"\d{1,2}", cells[0]) and DOCKET_RE.fullmatch(cells[1]):
                case = f"{cells[0]}:{cells[1]}"
                cells = cells[2:]
            if not case:
                continue
            date, star, status, note = m.group(1), bool(m.group(2)), m.group(3), m.group(4)[:80]
            row = {"judge": judge, "case": case}
            if table == "8":
                if cells and re.fullmatch(r"\d{3}", cells[0]):
                    row["nos"] = int(cells[0])
                    cells = cells[1:]
                if cells and cells[-1].endswith("*"):       # the mark can sit against a motion text cut short
                    star, cells[-1] = True, cells[-1].rstrip("* ")
                has_motion = any(MOTION_START_RE.match(c) for c in cells) or (bool(cells) and bool(MOTION_WORD_RE.search(cells[-1])) and len(cells) >= 3)
                if not date and not star and not has_motion:
                    # No motion text and no date: a second status the judge reported for the motion on the row above.
                    if rows and rows[-1]["judge"] == judge and rows[-1]["case"] == case and note not in rows[-1]["note"]:
                        rows[-1]["note"] = (rows[-1]["note"] + "; " + note)[:160]
                    continue
                # The motion text starts at the cell that names a MOTION (CM/ECF capitals) and can hold double spaces.
                at = next((i for i, c in enumerate(cells) if MOTION_START_RE.match(c)), len(cells) - 1 if cells else 0)
                while at >= 1 and MOTION_LEAD_RE.fullmatch(cells[at - 1]):     # "Second" split from "MOTION to Dismiss" by a double space
                    at -= 1
                row["motion"] = re.sub(r"\s+", " ", " ".join(cells[at:]))[:160]
                row["title"] = _title(cells[:at])[:90]
            else:
                if not date:
                    continue
                row["title"] = (_title(cells) if len(cells) >= 2 else "")[:90]
            deadline = last_deadline if star else _date(date or "")
            if not star:
                last_deadline = deadline
            row.update({"deadline": deadline, "status": status, "note": note})
            if star:
                row["part"] = True
            rows.append(row)
            if len(rows) >= MAX_ROWS:
                return {"judges": judges, "rows": rows}
    return {"judges": judges, "rows": rows}


def court_pages(pdf_path: Path) -> tuple[list[str], str, str]:
    """Layout-mode text of the pages for this court, the report's run date, and the date the report is "as of". Every
    page is read once as plain text to find them (about a minute for the largest table)."""
    import pypdf
    reader = pypdf.PdfReader(str(pdf_path))
    out, run, as_of = [], "", ""
    for page in reader.pages:
        plain = page.extract_text() or ""
        if COURT_HEAD not in plain:
            if out:
                break       # this court's pages are together; stop at the first page after them
            continue
        if not run:
            r = RUN_RE.search(plain)
            run = _date(r.group(1)) if r else ""
            a = AS_OF_RE.search(plain)
            try:
                as_of = dt.datetime.strptime(a.group(1), "%B %d, %Y").date().isoformat() if a else ""
            except ValueError:
                as_of = ""
        out.append(page.extract_text(extraction_mode="layout") or "")
    return out, run, as_of


def code_for(name: str, role: str, judges: list[dict]) -> str:
    """The site's code for a judge the report names ("Papillion, Darrel J." -> DJP; "Van Meerveld, Janis" -> JVM)."""
    surname = re.sub(r"[^a-z]+", "", name.split(",")[0].lower())
    if role == "magistrate":
        import magistrates
        return next((j["code"] for j in magistrates.ROSTER if re.sub(r"[^a-z]+", "", j["short"].lower()) == surname), "")
    return next((j["code"] for j in judges if re.sub(r"[^a-z]+", "", j["name"].lower()) == surname), "")


def build_cjra(texts: dict[str, list[str]], period: str, run: str, judges: list[dict]) -> dict:
    """texts: table number -> this court's pages. One file: the judges with the report's totals, and the rows."""
    parsed = {t: parse_cjra_pages(texts.get(t, []), t) for t in CJRA_TABLES}
    names: dict[str, dict] = {}
    for t, key in CJRA_TABLES.items():
        for name, info in parsed[t]["judges"].items():
            row = names.setdefault(name, {"name": name, "role": info["role"], "code": code_for(name, info["role"], judges)})
            row[key] = info.get("total", 0)
    code = {n: r["code"] for n, r in names.items()}

    def tidy(r: dict) -> dict:
        out = {"judge": code.get(r["judge"]) or r["judge"], **{k: v for k, v in r.items() if k != "judge" and v not in ("", None)}}
        return out
    cases: dict[tuple, dict] = {}
    for r in parsed["7"]["rows"]:       # Table 7 repeats a case for each status reported: one row per case, statuses joined
        k = (r["judge"], r["case"])
        c = cases.setdefault(k, {**tidy(r), "note": []})
        if r["note"] not in c["note"]:
            c["note"].append(r["note"])
        if r.get("title") and not c.get("title"):
            c["title"] = r["title"]
    for c in cases.values():
        c.pop("status", None)
        c["note"] = "; ".join(c["note"])
    return {"period": period, "run": run, "read": today_iso(),
            "source": {t: cjra_url(t, period) for t in CJRA_TABLES},
            "judges": sorted(names.values(), key=lambda r: (r["role"] != "district", r["name"])),
            "cases": list(cases.values()), "motions": [tidy(r) for r in parsed["8"]["rows"]], "bench": [tidy(r) for r in parsed["9"]["rows"]]}


def save_cjra(path: Path, data: dict) -> None:
    lists = ("judges", "cases", "motions", "bench")
    head = json.dumps({k: v for k, v in data.items() if k not in lists}, ensure_ascii=False, separators=(",", ":"))[:-1]
    body = "".join(',\n"%s":[\n%s\n]' % (k, ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in data[k])) for k in lists)
    path.write_text(head + body + "}\n", encoding="utf-8")


def update_cjra(argv: list[str], judges: list[dict]) -> None:
    path = DATA / "cjra.json"
    try:
        old = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        old = {}
    local = Path(argv[argv.index("--cjra-dir") + 1]) if "--cjra-dir" in argv else None
    for period in cjra_periods(today_iso()):
        if old.get("period") == period and "--force" not in argv and local is None:
            print(f"Civil Justice Reform Act report: {period} already on file.", flush=True)
            return
        texts, run, as_of = {}, "", ""
        with tempfile.TemporaryDirectory() as tmp:
            try:
                for t in CJRA_TABLES:
                    f = (local / f"cjra_{t}.pdf") if local else Path(tmp) / f"cjra_{t}.pdf"
                    if not local:
                        data = fetch(cjra_url(t, period), timeout=600)
                        if not data.startswith(b"%PDF"):
                            raise ValueError(f"Table {t} for {period} is not posted")
                        f.write_bytes(data)
                    texts[t], r, a = court_pages(f)
                    run, as_of = run or r, as_of or a
            except Exception as e:  # noqa: BLE001 - a report not yet posted, or the site down: try the edition before
                print(f"Civil Justice Reform Act report {period}: {e}", flush=True)
                if local:
                    return
                continue
        period = as_of or period      # the report states its own date
        if old.get("period") == period and "--force" not in argv:
            print(f"Civil Justice Reform Act report: {period} already on file.", flush=True)
            return
        new = build_cjra(texts, period, run, judges)
        if not new["judges"]:
            print(f"Civil Justice Reform Act report {period}: no pages for this court were read; keeping the last copy.", flush=True)
            return
        save_cjra(path, new)
        print(f"Civil Justice Reform Act report {period}: {len(new['judges'])} judges, {len(new['motions'])} motion rows, "
              f"{len(new['cases'])} cases over three years, {len(new['bench'])} bench trials.", flush=True)
        return
    print("Civil Justice Reform Act report: no edition could be read.", flush=True)


# ------------------------------------------------------------------ trial tables (xlsx)
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def xlsx_rows(data: bytes) -> list[list]:
    """Rows of the first sheet of an .xlsx file as lists of strings and numbers (no library needed)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    sheet = next(n for n in sorted(z.namelist()) if n.startswith("xl/worksheets/sheet"))
    rows = []
    for row in ET.fromstring(z.read(sheet)).iter("{%s}row" % NS["m"]):
        cells: list = []
        for c in row.findall("m:c", NS):
            col = 0
            for ch in re.match(r"[A-Z]+", c.get("r", "A")).group(0):
                col = col * 26 + ord(ch) - 64
            v = c.find("m:v", NS)
            kind = c.get("t")
            if kind == "s" and v is not None:
                val = shared[int(v.text)]
            elif kind == "inlineStr":
                val = "".join(t.text or "" for t in c.iter("{%s}t" % NS["m"]))
            elif v is not None and v.text is not None:
                try:
                    val = float(v.text) if "." in v.text or "E" in v.text.upper() else int(v.text)
                except ValueError:
                    val = v.text
            else:
                val = None
            while len(cells) < col - 1:
                cells.append(None)
            cells.append(val)
        rows.append(cells)
    return rows


def table_rows(rows: list[list], width: int) -> dict[str, list]:
    """Label -> the row's numbers ("-" and blanks as None), for rows that carry numbers: districts ("LA,E"), circuits
    ("5th"), and "Total". The first occurrence of a label wins (headers repeat on later pages of the sheet)."""
    out: dict[str, list] = {}
    for r in rows:
        if not r or not isinstance(r[0], str):
            continue
        label = r[0].strip()
        vals = [(v if isinstance(v, (int, float)) else None) for v in (r[1:width + 1] + [None] * width)[:width]]
        if label and "\n" not in label and len(label) <= 12 and any(v is not None for v in vals) and label not in out:
            out[label] = vals
    return out


def is_district(label: str) -> bool:
    return label not in ("Total",) and not re.fullmatch(r"\d{1,2}(?:st|nd|rd|th)", label)


T1_COLS = ["all", "civil", "civil_nonjury", "civil_jury", "criminal", "criminal_nonjury", "criminal_jury"]
T2_BINS = ["1", "2", "3", "4–9", "10–19", "20+"]


def build_trials(t1: list[list], t2: list[list], t3: list[list], period: str, source: dict) -> dict:
    a, b, c = table_rows(t1, 7), table_rows(t2, 15), table_rows(t3, 7)
    if DISTRICT not in a or "Total" not in a:
        raise ValueError("Table T-1 has no row for this court")
    districts = {k: v for k, v in a.items() if is_district(k)}

    def t1row(v):
        return {k: (v[i] or 0) for i, k in enumerate(T1_COLS)}
    mine = t1row(a[DISTRICT])
    rank, median, values = {}, {}, {}
    for i, k in enumerate(T1_COLS):
        col = [(v[i] or 0) for v in districts.values()]
        rank[k] = 1 + sum(1 for x in col if x > mine[k])
        median[k] = statistics.median(col)
        values[k] = sorted(col)

    def t2row(v):
        return {"civil": [(x or 0) for x in v[2:8]], "criminal": [(x or 0) for x in v[9:15]]} if v else None

    def t3row(v):
        return {"trials": v[0], "months": v[1], "nonjury_trials": v[2], "nonjury_months": v[3], "jury_trials": v[4], "jury_months": v[5]} if v else None
    return {"period": period, "read": today_iso(), "source": source, "districts": len(districts),
            "t1": {"court": mine, "circuit": t1row(a[CIRCUIT]) if CIRCUIT in a else None, "national": t1row(a["Total"]),
                   "rank": rank, "median": median, "values": {k: values[k] for k in ("civil", "civil_jury", "civil_nonjury")}},
            "t2": {"bins": T2_BINS, "court": t2row(b.get(DISTRICT)), "circuit": t2row(b.get(CIRCUIT)), "national": t2row(b.get("Total"))},
            "t3": {"court": t3row(c.get(DISTRICT)), "circuit": t3row(c.get(CIRCUIT)), "national": t3row(c.get("Total"))}}


PUBLICATION = {"03": "federal-judicial-caseload-statistics", "06": "statistical-tables-federal-judiciary",
               "09": "judicial-business", "12": "statistical-tables-federal-judiciary"}


def quarter_ends(today: str, n: int = 6) -> list[str]:
    d = dt.date.fromisoformat(today)
    out = []
    for year in range(d.year, d.year - 3, -1):
        for md in ("12-31", "09-30", "06-30", "03-31"):
            p = f"{year}-{md}"
            if p <= today:
                out.append(p)
    return out[:n]


def table_file(code: str, period: str) -> str:
    """The .xlsx address on a table's page for a period; raises when the page or the file is not there."""
    y, m, d = period.split("-")
    page = fetch(f"{BASE}/data-news/data-tables/{y}/{m}/{d}/{PUBLICATION[m]}/{code}", timeout=60).decode("utf-8", "replace")
    hit = re.search(r'href="(/sites/default/files/[^"]+\.xlsx)"', page)
    if not hit:
        raise ValueError(f"no spreadsheet on the {code} page for {period}")
    return BASE + hit.group(1)


def update_trials(argv: list[str]) -> None:
    path = DATA / "ao_trials.json"
    try:
        old = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        old = {}
    for period in quarter_ends(today_iso()):
        if old.get("period") == period and "--force" not in argv:
            print(f"Trial tables: {period} already on file.", flush=True)
            return
        try:
            source = {c: table_file(c, period) for c in ("t-1", "t-2", "t-3")}
            new = build_trials(*(xlsx_rows(fetch(source[c])) for c in ("t-1", "t-2", "t-3")), period, source)
        except Exception as e:  # noqa: BLE001 - not every quarter has all three tables
            print(f"Trial tables {period}: {str(e)[:120]}", flush=True)
            continue
        path.write_text(json.dumps(new, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"Trial tables {period}: {new['t1']['court']['civil']} civil trials for this court, {new['districts']} districts.", flush=True)
        return
    print("Trial tables: no period with all three tables could be read.", flush=True)


def main(argv: list[str]) -> int:
    judges = json.loads((DATA / "judges.json").read_text())
    for step in (lambda: update_trials(argv), lambda: update_cjra(argv, judges)):
        try:
            step()
        except Exception as e:  # noqa: BLE001 - one source failing does not stop the other
            print(f"Stopped: {e}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
