#!/usr/bin/env python3
"""Record a hand-entered outcome from an "Outcome:" issue form into data/outcomes.json.

Run by .github/workflows/outcome.yml with the issue body in ISSUE_BODY. The body is form input:
it is parsed as data, validated against the opinions on file, and never executed or interpreted.
Writes a one-line result to RESULT_FILE (for the issue comment) and exits 1 on invalid input.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

from outcome_text import FORM_LABELS
from update import CASE_RE, DATA, load, save

REMOVE = "remove recorded outcome"


def form_fields(body: str) -> dict:
    """Issue forms render as "### Label" headings followed by the answer."""
    fields, label = {}, None
    for line in body.replace("\r\n", "\n").split("\n"):
        if line.startswith("### "):
            label = line[4:].strip().lower()
            fields[label] = ""
        elif label is not None and line.strip():
            fields[label] = (fields[label] + " " + line.strip()).strip()
    return {k: ("" if v == "_No response_" else v) for k, v in fields.items()}


def record(body: str, today: str) -> str:
    f = form_fields(body)
    case = f.get("case number", "").strip()
    doc = f.get("document number", "").strip().lstrip("#")
    choice = f.get("outcome", "").strip().lower()
    note = re.sub(r"\s+", " ", f.get("note (optional)", ""))[:200]
    if not CASE_RE.fullmatch(case):
        raise ValueError(f"Case number {case[:40]!r} is not in the form 2:23-cv-00931.")
    if not doc.isdigit():
        raise ValueError(f"Document number {doc[:20]!r} is not a number.")
    if choice != REMOVE and choice not in FORM_LABELS:
        raise ValueError(f"Outcome {choice[:40]!r} is not one of the form's choices.")
    if not any(o["case"] == case and o["doc"] == doc for o in load("opinions")):
        raise ValueError(f"No written opinion {case} doc {doc} is in data/opinions.json.")
    rows = [r for r in load("outcomes") if not (r["case"] == case and r["doc"] == doc)]
    if choice == REMOVE:
        msg = f"Removed the recorded outcome for {case} doc {doc}. The updater may read it again from the order."
    else:
        row = {"case": case, "doc": doc, "outcome": FORM_LABELS[choice], "src": "manual", "at": today}
        if note:
            row["note"] = note
        rows.append(row)
        msg = f"Recorded {case} doc {doc}: {FORM_LABELS[choice]}."
    rows.sort(key=lambda r: (r["case"], int(r["doc"]) if r["doc"].isdigit() else 0))
    save("outcomes", rows)
    return msg


def main() -> int:
    today = dt.date.today().isoformat()
    out = Path(os.environ.get("RESULT_FILE", "/dev/stdout"))
    if not (DATA / "outcomes.json").exists():
        (DATA / "outcomes.json").write_text("[\n\n]\n")
    try:
        msg, code = record(os.environ.get("ISSUE_BODY", ""), today), 0
    except ValueError as e:
        msg, code = f"Not recorded: {e}", 1
    out.write_text(msg + "\n")
    print(msg)
    return code


if __name__ == "__main__":
    sys.exit(main())
