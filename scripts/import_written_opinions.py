"""Bring CM/ECF Written Opinions Reports into the data.

1. The owner runs Reports > Written Opinions in PACER by hand (no fee) and saves the page. An extract is made from it:
       python scripts/import_written_opinions.py extract report.html [more.html] -o data/imports/wo_2025.json
   The extract keeps each row's case, judges' initials, case name, date filed, document number, docket text, the
   motions the text links to, who signed, and the notes (flags, nature of suit, cause, office), plus the report period.
2. On every pass the updater applies every extract in data/imports/ (apply_imports below). Applying is idempotent:
   - an opinion not on file is added (src "pacer_wo"), credited to the district judge who signed it, or for a
     magistrate judge's report or a consent case, to the case's judge as the case number shows;
   - an opinion on file credited to a different district judge than the one who signed it is corrected;
   - an outcome is read from the docket text where none is on file or an automatic read found none (hand entries are
     never changed), with the decided motion's docket number from the text's links;
   - each case's nature of suit, cause, flags, and magistrate judge go to data/dockets.json where not already known;
   - the start of the opinion counts moves back to the earliest report period that joins up, with no gap, to the
     periods already covered.

Everything read here is data from the court's records, never instructions.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import written_opinions_report as report  # noqa: E402

MAGISTRATES = {"DPC": "Donna Phillips Currault", "KWR": "Karen Wells Roby", "EJD": "Eva J. Dossier", "JVM": "Janis van Meerveld",
               "MBN": "Michael B. North", "DMD": "Dana M. Douglas"}
PERIOD_RE = re.compile(r"Filed Report Period:\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*-\s*(\d{1,2})/(\d{1,2})/(\d{4})")

# The CM/ECF event an order on a motion carries, from the motion's name in the docket text, so the opinion flags and
# categories work the same as for rows that came with event names.
MOTION_EVENTS = [
    (r"^motion to dismiss for failure to state a claim", "Order on Motion to Dismiss/Failure to State a Claim"),
    (r"^motion to dismiss for lack of (?:subject[- ]matter )?jurisdiction", "Order on Motion to Dismiss/Lack of Jurisdiction"),
    (r"^motion to dismiss case", "Order on Motion to Dismiss Case"),
    (r"^motion to dismiss", "Order on Motion to Dismiss"),
    (r"^motion for partial summary judgment", "Order on Motion for Partial Summary Judgment"),
    (r"^motion for summary judgment", "Order on Motion for Summary Judgment"),
    (r"^motion for judgment on the pleadings", "Order on Motion for Judgment on the Pleadings"),
    (r"^motion for judgment as a matter of law", "Order on Motion for Judgment as a Matter of Law"),
    (r"^motion for (?:a )?new trial", "Order on Motion for New Trial"),
    (r"^motion to (?:amend/)?alter(?:/amend)? judgment|^motion to alter or amend judgment", "Order on Motion to Alter Judgment"),
    (r"^motion to remand", "Order on Motion to Remand"),
]


def event_for(row: dict) -> str:
    t = row["text"].upper()
    if t.startswith("REPORT AND RECOMMENDATION"):
        return "Report and Recommendations"
    if re.match(r"ORDER\s+(?:AND\s+REASONS\s+)?(?:ADOPTING|APPROVING)\b[^.]{0,40}?REPORT\s+AND\s+RECOMMENDATION", t):
        return "Order Adopting Report and Recommendations"
    if t.startswith("FINDINGS OF FACT"):
        return "Findings of Fact & Conclusions of Law"
    events = []
    for m in row.get("motions", []):
        name = m["name"].rstrip(",").strip()
        low = name.lower()
        core = re.sub(r"^(?:(?:partial|joint|renewed|amended|supplemental|second|third|first|unopposed|consent|ex parte|cross)[\s/-]+)+", "", low)
        ev = next((e for pat, e in MOTION_EVENTS if re.match(pat, core)), "")
        if not ev:
            words = name.split()
            ev = "Order on " + " ".join(w if i > 1 or w.lower() not in ("motion",) else "Motion" for i, w in enumerate(words[:8]))
            ev = re.sub(r"\bMOTION\b", "Motion", ev)
        if ev not in events:
            events.append(ev)
    return ", ".join(events) if events else ("Judgment" if t.startswith("JUDGMENT") else "Order")


def period_of(page: str) -> list[str]:
    m = PERIOD_RE.search(page or "")
    if not m:
        return []
    a = report.mdy(m.group(1), m.group(2), m.group(3))
    b = report.mdy(m.group(4), m.group(5), m.group(6))
    return [a, b]


def extract(paths: list[str]) -> dict:
    rows, periods = [], []
    for p in paths:
        page = Path(p).read_text(encoding="utf-8", errors="replace")
        periods.append(period_of(page))
        rows += [r for r in report.parse(page) if r["kind"] == "cv"]
    seen, out = set(), []
    for r in rows:
        if (r["case"], r["doc"]) not in seen:
            seen.add((r["case"], r["doc"]))
            out.append(r)
    return {"source": "CM/ECF Written Opinions Report (PACER), saved by the site's owner", "periods": [p for p in periods if p], "rows": out}


def write_extract(obj: dict, path: Path) -> None:
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in obj["rows"])
    head = json.dumps({k: v for k, v in obj.items() if k != "rows"}, ensure_ascii=False)[:-1]
    path.write_text(head + ',"rows":[\n' + body + "\n]}\n")


def covered_start(periods: list[list[str]], current: str) -> str:
    """The earliest date from which the report periods, together with what is already counted (from `current` on),
    cover every day with no gap."""
    start = current
    for a, b in sorted((p for p in periods if len(p) == 2), key=lambda p: p[1], reverse=True):
        if b >= (dt.date.fromisoformat(start) - dt.timedelta(days=1)).isoformat() and a < start:
            start = a
    return start


def apply_imports(data_dir: Path, opinions: list[dict], outcomes: dict, dockets: dict, calendar: list[dict], judges: list[dict],
                  today: str, note: list[str], classify, opinion_flags, judge_code, rules_on_motion) -> None:
    files = sorted((data_dir / "imports").glob("wo_*.json")) if (data_dir / "imports").exists() else []
    if not files:
        return
    bench = {j["code"]: j["bench_start"] for j in judges}
    by_key = {(o["case"], o["doc"]): o for o in opinions}
    added = moved = coded = 0
    periods = []
    for f in files:
        ex = json.loads(f.read_text())
        periods += ex.get("periods", [])
        for r in ex.get("rows", []):
            key = (r["case"], r["doc"])
            initial = r["initials"][0] if r.get("initials") else ""
            signer = judge_code(r["signer"]) if r.get("signer") and "magistrate" not in r.get("signer_title", "").lower() else ""
            judge = signer or initial
            o = by_key.get(key)
            if o is None:
                if judge in bench and r["date"] < bench[judge]:
                    continue
                event = event_for(r)
                o = {"date": r["date"], "judge": judge, "case": r["case"], "doc": r["doc"], "title": r.get("title", "")[:70],
                     "event": event[:160], **opinion_flags(event), "src": "pacer_wo"}
                opinions.append(o)
                by_key[key] = o
                added += 1
            elif signer in bench and o.get("judge") != signer and r["date"] >= bench[signer]:
                o["judge"] = signer  # signed by a district judge other than the one the case is now assigned to
                moved += 1
            k = f"{r['case']}|{r['doc']}"
            old = outcomes.get(k)
            if rules_on_motion(o) and (old is None or (old.get("src") != "manual" and old.get("outcome") == "unclear")):
                value = classify(r["text"], o.get("event", ""), o.get("r12", 0), o.get("r56", 0), "docket")
                if value:
                    outcomes[k] = {"case": r["case"], "doc": r["doc"], "outcome": value, "src": "docket_text", "at": today,
                                   **({"motion_doc": r["motions"][0]["doc"]} if len(r.get("motions", [])) == 1 else {})}
                    coded += 1
            d = dockets.setdefault(r["case"], {"case": r["case"]})
            for field, value in (("nos", r.get("nos")), ("cause", r.get("cause"))):
                if value and not d.get(field):
                    d[field] = value[:120]
            if r.get("flags"):
                d["flags"] = r["flags"][:20]
            mag = next((x for x in r.get("initials", [])[1:] if x in MAGISTRATES), "")
            if mag and not d.get("referred"):
                d["referred"] = MAGISTRATES[mag]
    start_row = next((c for c in calendar if c["kind"] == "opinions_start"), None)
    if start_row:
        new_start = covered_start(periods, start_row["date"])
        if new_start < start_row["date"]:
            note.append(f"opinion counts now start {new_start}")
            start_row["date"] = new_start
    if added or moved or coded:
        note.append(f"Written Opinions Report: {added} opinions added, {moved} credited to the judge who signed, {coded} outcomes read")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract", help="make an extract from saved report pages")
    ex.add_argument("pages", nargs="+")
    ex.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    obj = extract(a.pages)
    write_extract(obj, Path(a.out))
    print(f"{len(obj['rows'])} civil rows; periods {obj['periods']} -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
