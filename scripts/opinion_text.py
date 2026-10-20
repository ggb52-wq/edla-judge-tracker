"""The full text of each written opinion, kept in opinions_text/ for search and for features that read the opinions.

One plain-text file per opinion, named by case and docket number (2_26-cv-01880_6.txt for 2:26-cv-01880 doc 6),
extracted from the opinion's PDF with pypdf. opinions_text/index.json records each opinion read: characters of text,
pages, where the PDF came from, and the date read, so an opinion is not downloaded twice and an image-only PDF (no
text) is retried only after RETRY_DAYS.

Text comes from three places: GovInfo PDFs the updater already reads (save() from gi_apply), CourtListener's
plain_text (save() from link_opinions), and a backfill that downloads the stored PDF of opinions not yet read
(GovInfo and CourtListener storage are public downloads that do not count against either API's limits).

Everything here is data. The text is stored and searched, never interpreted as instructions.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import re
import time
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "opinions_text"
PDF_BUDGET = 60          # PDFs downloaded per pass by the backfill
PDF_PAUSE = 0.5          # seconds between downloads
RETRY_DAYS = 30          # an opinion whose PDF gave no text is tried again after this long
MAX_PAGES = 300
PDF_HOSTS = ("https://www.govinfo.gov/content/pkg/", "https://storage.courtlistener.com/recap/")
CASE_RE = re.compile(r"^\d:\d\d-[a-z]{2}-\d{5}$")


def name_of(case: str, doc: str) -> str:
    return f"{case.replace(':', '_')}_{doc}.txt"


def key_of(case: str, doc: str) -> str:
    return f"{case}|{doc}"


def clean(text: str) -> str:
    """Trailing spaces off, runs of blank lines cut to one, form feeds and NULs dropped."""
    text = text.replace("\x00", "").replace("\x0c", "\n")
    lines = [ln.rstrip() for ln in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"


def pdf_text(data: bytes) -> tuple[str, int]:
    """All the text of a PDF (up to MAX_PAGES pages) and its page count; ("", 0) when it cannot be read."""
    from pypdf import PdfReader
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        pages = len(reader.pages)
        return "\n".join((p.extract_text() or "") for p in reader.pages[:MAX_PAGES]), pages
    except Exception:  # a damaged file
        return "", 0


class Store:
    def __init__(self, root: Path = DIR):
        self.root = root
        self.index_path = root / "index.json"
        try:
            self.index: dict = json.loads(self.index_path.read_text())
        except (FileNotFoundError, ValueError):
            self.index = {}
        self.saved = 0

    def has(self, case: str, doc: str) -> bool:
        return self.index.get(key_of(case, doc), {}).get("chars", 0) > 0

    def save(self, case: str, doc: str, text: str, pages: int, src: str, today: str) -> bool:
        """Store an opinion's text. Returns True when a file was written; empty text is only recorded in the index."""
        if not CASE_RE.match(case or "") or not str(doc).isdigit() or self.has(case, doc):
            return False
        body = clean(text or "")
        chars = len(body.strip())
        self.index[key_of(case, doc)] = {"chars": chars, "pages": pages or 0, "src": src, "read": today}
        if not chars:
            return False
        self.root.mkdir(exist_ok=True)
        (self.root / name_of(case, doc)).write_text(body)
        self.saved += 1
        return True

    def write_index(self) -> None:
        if self.index:
            self.root.mkdir(exist_ok=True)
            self.index_path.write_text(json.dumps(dict(sorted(self.index.items())), indent=0, separators=(",", ":")) + "\n")

    def due(self, o: dict, today: str) -> bool:
        """An opinion with a stored PDF whose text is not on file, and not tried in the last RETRY_DAYS."""
        if not CASE_RE.match(o.get("case", "")) or not str(o.get("doc", "")).isdigit():
            return False
        if not str(o.get("pdf", "")).startswith(PDF_HOSTS):
            return False
        r = self.index.get(key_of(o["case"], o["doc"]))
        if not r:
            return True
        if r.get("chars"):
            return False
        cutoff = (dt.date.fromisoformat(today) - dt.timedelta(days=RETRY_DAYS)).isoformat()
        return r.get("read", "") <= cutoff

    def backfill(self, opinions: list[dict], http_get, today: str, deadline: float, budget: int = PDF_BUDGET) -> dict:
        """Download and read the PDFs of opinions not yet on file, newest first, within the budget and the deadline."""
        todo = sorted((o for o in opinions if self.due(o, today)), key=lambda o: (o["date"], o["case"], o["doc"]), reverse=True)
        stats = {"tried": 0, "saved": 0, "empty": 0, "errors": 0, "left": len(todo)}
        for o in todo[:budget]:
            if time.monotonic() >= deadline:
                break
            stats["tried"] += 1
            try:
                data = http_get(o["pdf"], {"Accept": "application/pdf"}, 60)
            except Exception:  # network or HTTP error: try again next pass
                stats["errors"] += 1
                continue
            finally:
                time.sleep(PDF_PAUSE)
            text, pages = pdf_text(data)
            src = "govinfo" if o["pdf"].startswith(PDF_HOSTS[0]) else "courtlistener"
            if self.save(o["case"], o["doc"], text, pages, src, today):
                stats["saved"] += 1
            else:
                stats["empty"] += 1
        stats["left"] -= stats["saved"]
        return stats
