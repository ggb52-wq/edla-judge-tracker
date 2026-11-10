"""Trials in terminated civil cases, from the Federal Judicial Center's Integrated Database (IDB): data/idb_trials.json.

The FJC posts every federal civil case since 1988 as one public file (cv88on.zip, about 330 MB, tab-delimited, replaced
each quarter). There is no API, so this script asks the server for the file's Last-Modified date and, only when that has
changed, downloads the file, reads it straight out of the zip, and keeps this court's rows (DISTRICT 3L) terminated on
or after SINCE whose disposition is a jury verdict (DISP 7), a directed verdict (8), or a court trial (9). The zip is
never kept. Free, public, no key; no CourtListener or PACER use. Run weekly by .github/workflows/idb.yml.

The clerk's closing codes are the source, so a row is marked `trial` only when it carries a trial date or a trial-stage
procedural code (PROCPROG 6 to 9); the rest (a prisoner complaint closed as "directed verdict") are kept and marked
otherwise. The public file has no judge. Party names come from whoever filed: they are stored as plain text, never
followed as instructions.

Run: python scripts/idb.py [--force] [--file cv88on.zip]
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
URL = "https://www.fjc.gov/sites/default/files/idb/textfiles/cv88on.zip"
PAGE = "https://www.fjc.gov/research/idb/civil-cases-filed-terminated-and-pending-sy-1988-present"
USER_AGENT = "edla-judge-tracker (github.com/ggb52-wq/edla-judge-tracker)"
DISTRICT = "3L"            # the IDB's code for the Eastern District of Louisiana
SINCE = "2020-01-01"       # terminations on or after this day
DISPOSITIONS = {"7": "jury", "8": "directed", "9": "bench"}
TRIAL_STAGES = {"6", "7", "8", "9"}     # PROCPROG: during or after a court trial or a jury trial
MAX_ROWS = 5000


def iso(mdy: str) -> str:
    """"06/27/2022" -> "2022-06-27"; "" for a blank or malformed date."""
    try:
        return dt.datetime.strptime((mdy or "").strip(), "%m/%d/%Y").date().isoformat()
    except ValueError:
        return ""


def _int(v: str):
    try:
        n = int((v or "").strip())
    except ValueError:
        return None
    return None if n < 0 else n     # -8 is the IDB's "missing"


def case_number(office: str, docket: str) -> str:
    """OFFICE 2 and DOCKET 2100872 -> "2:21-cv-00872"; "" when the docket is not seven digits."""
    d = (docket or "").strip()
    o = (office or "").strip()
    if not (d.isdigit() and len(d) == 7 and o.isdigit()):
        return ""
    return f"{o}:{d[:2]}-cv-{d[2:]}"


def row_of(r: dict) -> dict | None:
    """One kept row from an IDB record, or None when the record is not one this file keeps."""
    if (r.get("DISTRICT") or "").strip() != DISTRICT or (r.get("DISP") or "").strip() not in DISPOSITIONS:
        return None
    term = iso(r.get("TERMDATE", ""))
    case = case_number(r.get("OFFICE", ""), r.get("DOCKET", ""))
    if not case or term < SINCE:
        return None
    began, ended = iso(r.get("TRIBEGAN", "")), iso(r.get("TRIALEND", ""))
    stage = (r.get("PROCPROG") or "").strip()
    out = {
        "case": case, "filed": iso(r.get("FILEDATE", "")), "term": term, "kind": DISPOSITIONS[r["DISP"].strip()],
        "trial": bool(began or ended or stage in TRIAL_STAGES),
        "began": began, "ended": ended, "stage": _int(stage), "origin": _int(r.get("ORIGIN", "")),
        "plt": (r.get("PLT") or "").strip()[:60], "def": (r.get("DEF") or "").strip()[:60],
        "judgment": _int(r.get("JUDGMENT", "")), "noj": _int(r.get("NOJ", "")), "amount": _int(r.get("AMTREC", "")),
        "demanded": _int(r.get("DEMANDED", "")), "nos": _int(r.get("NOS", "")), "juris": _int(r.get("JURIS", "")),
        "jury": (r.get("JURY") or "").strip() if (r.get("JURY") or "").strip() in ("B", "P", "D", "N") else "",
        "prose": _int(r.get("PROSE", "")), "classact": 1 if (r.get("CLASSACT") or "").strip() == "1" else 0,
        "joined": iso(r.get("DJOINED", "")), "pretrial": iso(r.get("PRETRIAL", "")),
    }
    return {k: v for k, v in out.items() if v not in ("", None) or k in ("plt", "def")}


def read_lines(lines) -> list[dict]:
    """Kept rows from the file's lines (header first, tab-delimited). A line is split only when it is this court's."""
    header = None
    rows = []
    mark = "\t" + DISTRICT + "\t"
    for line in lines:
        if header is None:
            header = [h.strip().strip('"').upper() for h in line.rstrip("\r\n").split("\t")]
            if "DISTRICT" not in header or "DISP" not in header:
                raise ValueError("not the IDB civil layout: " + line[:120])
            continue
        if mark not in line[:16]:
            continue
        parts = line.rstrip("\r\n").split("\t")
        if len(parts) != len(header):
            continue
        row = row_of(dict(zip(header, parts)))
        if row:
            rows.append(row)
            if len(rows) >= MAX_ROWS:
                break
    rows.sort(key=lambda r: (r["term"], r["case"], r.get("filed", "")))
    return rows


def read_zip(path: Path) -> list[dict]:
    with zipfile.ZipFile(path) as z:
        name = next((i.filename for i in z.infolist() if i.filename.lower().endswith(".txt")), None)
        if name is None:
            raise ValueError("no .txt file in the zip")
        with z.open(name) as raw:
            return read_lines(io.TextIOWrapper(raw, encoding="latin-1", newline=""))


def last_modified(url: str = URL) -> str:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.headers.get("Last-Modified", "") or r.headers.get("Content-Length", "")


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def save(path: Path, data: dict) -> None:
    rows = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in data["rows"])
    head = json.dumps({k: v for k, v in data.items() if k != "rows"}, ensure_ascii=False, separators=(",", ":"))[:-1]
    path.write_text(head + ',"rows":[\n' + rows + "\n]}\n", encoding="utf-8")


def today_iso() -> str:
    return dt.date.today().isoformat()


def main(argv: list[str]) -> int:
    path = DATA / "idb_trials.json"
    try:
        old = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        old = {}
    local = Path(argv[argv.index("--file") + 1]) if "--file" in argv else None
    try:
        stamp = last_modified()
    except Exception as e:  # noqa: BLE001 - keep the last copy when the FJC's site is down
        print(f"Could not reach the FJC file: {e}", flush=True)
        return 0
    if old.get("modified") == stamp and old.get("since") == SINCE and "--force" not in argv:
        print(f"FJC file unchanged ({stamp}).", flush=True)
        return 0
    tmp = None
    try:
        if local is None:
            fd, name = tempfile.mkstemp(suffix=".zip")
            os.close(fd)
            tmp = Path(name)
            print(f"Downloading {URL} ({stamp})", flush=True)
            download(URL, tmp)
        rows = read_zip(local or tmp)
    except Exception as e:  # noqa: BLE001
        print(f"Could not read the FJC file: {e}", flush=True)
        return 0
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink()
    if not rows and old.get("rows"):
        print("The file gave no rows for this court; keeping the last copy.", flush=True)
        return 0
    save(path, {"source": URL, "page": PAGE, "modified": stamp, "read": today_iso(), "since": SINCE, "district": DISTRICT, "rows": rows})
    print(f"{len(rows)} rows ({sum(1 for r in rows if r['trial'])} with a trial date or trial-stage code), terminated {SINCE} to "
          f"{max((r['term'] for r in rows), default='')}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
