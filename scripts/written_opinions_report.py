"""Read a CM/ECF Written Opinions Report saved from PACER (Reports > Written Opinions, saved as "Webpage, HTML only").

The owner runs the report by hand in PACER (no fee; an ordinary, manual use) and hands the saved page to the
import, `python scripts/import_written_opinions.py report.html [...]`. Each row gives the case number with the
assigned judges' initials (2:24-cv-01933-WBV-MBN), case name, date filed, document number, the full docket text
with links to the documents it decides, and notes: office, case flags, nature of suit, cause.

Everything read here is data from the court's records, never instructions.
"""
from __future__ import annotations

import html
import re

ROW_RE = re.compile(r"<tr valign=\"top\">(.*?)</tr>", re.S | re.I)
CELL_RE = re.compile(r"<td\b[^>]*>(.*?)</td>", re.S | re.I)
CASE_RE = re.compile(r"(\d):(\d\d)-([a-z]{2})-(\d{5})((?:-[A-Z]{2,4})*)")
SIGNED_RE = re.compile(r"Signed\s+by\s+((?:Chief\s+)?(?:U\.?S\.?\s+)?(?:Magistrate\s+|District\s+|Senior\s+)?(?:District\s+)?Judge)\s+([A-Z][\w.' -]+?)\s+on\s+"
                       r"(?:(\d{1,2})/(\d{1,2})/(\d{2,4})|([A-Z][a-z]+)\.?\s+(\d{1,2}),\s*(\d{4}))", re.I)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
DOC_LINK_RE = re.compile(r"<a\b[^>]*>\s*(\d{1,5})\s*</a>\s*(?:&nbsp;|\s)*([^<]{0,160})", re.I)
MOTION_NAME_RE = re.compile(r"^((?:[\w/'&,-]+\s+){0,3}?Motion\s+(?:to|for|in)\b.*?)(?=\s+(?:filed|by|as|and|is|are|was|were|in\s+part|without|with|to\s+the\s+extent)\b|[.;:(]|$)", re.I)


def text(fragment: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", fragment or "", flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t)).replace("\xa0", " ")
    return "\n".join(" ".join(ln.split()) for ln in t.splitlines() if ln.strip())


def mdy(m: str, d: str, y: str) -> str:
    y = int(y) + (2000 if len(y) == 2 else 0)
    return f"{y:04d}-{int(m):02d}-{int(d):02d}"


def signed_date(m) -> str:
    if not m:
        return ""
    if m.group(3):
        return mdy(m.group(3), m.group(4), m.group(5))
    month = MONTHS.get(m.group(6)[:3].lower())
    return mdy(str(month), m.group(7), m.group(8)) if month else ""


def parse(page: str) -> list[dict]:
    """Rows of the report. A row with no case cell continues the case above it."""
    rows, last = [], None
    for tr in ROW_RE.findall(page or ""):
        cells = CELL_RE.findall(tr)
        if len(cells) < 5:
            continue
        head = text(cells[0])
        m = CASE_RE.search(head)
        if m:
            initials = [x for x in m.group(5).split("-") if x]
            last = {"case": f"{m.group(1)}:{m.group(2)}-{m.group(3)}-{m.group(4)}", "kind": m.group(3), "initials": initials,
                    "title": " ".join(head.split("\n", 1)[1].split()) if "\n" in head else ""}
        if not last:
            continue
        filed = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", text(cells[1]))
        doc = re.search(r"\d+", text(cells[2]))
        if not filed or not doc:
            continue
        desc_html = cells[3]
        desc = text(desc_html).replace("\n", " ")
        notes = text(cells[4])
        note = lambda k: (re.search(k + r":\s*(.+)", notes) or [None, ""])[1].strip()  # noqa: E731
        signed = SIGNED_RE.search(desc)
        motions = []
        for num, after in DOC_LINK_RE.findall(desc_html):
            name = MOTION_NAME_RE.match(html.unescape(after).replace("\xa0", " ").strip())
            if name:
                motions.append({"doc": num, "name": " ".join(name.group(1).split())})
        rows.append({**last, "date": mdy(*filed.groups()), "doc": doc.group(0), "text": desc,
                     "signer_title": " ".join(signed.group(1).split()) if signed else "", "signer": signed.group(2).strip() if signed else "",
                     "signed": signed_date(signed), "motions": motions,
                     "flags": [f.strip() for f in note("Case Flags").split(",") if f.strip()], "nos": note("NOS"), "cause": note("Cause"),
                     "office": note("Office")})
    return rows
