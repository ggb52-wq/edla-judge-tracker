"""Written opinions from GovInfo's United States Courts collection (USCOURTS): new ones the data lacks, and PDFs,
page counts, and text for opinions already in it.

GovInfo publishes the documents a court flags as written opinions, one package per case
(USCOURTS-laed-2_23-cv-00931) and one granule per document (...-0, -1, ... in filing order). Its granules are
numbered within the case, not by docket entry, so each PDF is matched to our rows by the stamp CM/ECF prints
on every page: "Case 2:23-cv-00931-BSL-JVM Document 99 Filed 01/12/26".

Listing a package's granules is one api.data.gov call (key in GOVINFO_API_KEY, sent as a header so it never
appears in a URL or a log line). The PDFs themselves are public downloads. Everything read here is data: the
text is matched with regular expressions and handed to the outcome reader, never interpreted.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import re
import time
import urllib.error

API = "https://api.govinfo.gov/"
CONTENT = "https://www.govinfo.gov/content/pkg/"
COURT = "laed"
PKG_RE = re.compile(r"^USCOURTS-laed-\d_\d\d-cv-\d{5}$")
GRANULE_RE = re.compile(r"^(USCOURTS-laed-\d_\d\d-cv-\d{5})-(\d{1,4})$")
# The CM/ECF header stamp. Attachments read "Document 99-1" and are skipped.
STAMP_RE = re.compile(r"Document\s*(\d{1,5})(?![-\d])\s*Filed\s*(\d{1,2})/(\d{1,2})/(\d{2,4})", re.I)
API_BUDGET = 100        # api.data.gov calls per run; the key allows 1,000 an hour and runs are at most 4 an hour
PDF_BUDGET = 200        # PDF downloads per run
PDF_PAUSE = 0.3         # seconds between downloads, to be polite to GovInfo
RECHECK_DAYS = 3        # re-list a package after this long, for opinions GovInfo had not posted yet
DISCOVER_API = 40       # of the run's calls, at most this many go to finding new opinions; the backfill gets the rest
DISCOVER_PDFS = 60      # and at most this many downloads
DISCOVER_DAYS = 60      # new opinions are added only when filed within this many days
DISCOVER_OVERLAP = dt.timedelta(hours=2)   # each listing starts this long before the last complete one
CASE_STAMP_RE = re.compile(r"Case\s*(\d:\d\d-cv-\d{5})-([A-Z]{2,4})\b")
# The title an order carries under the caption, first match in the opening text.
HEADING_RE = re.compile(
    r"(?m)^\s*(REPORT\s+AND\s+RECOMMENDATIONS?|FINDINGS\s+OF\s+FACT\b[^\n]*|ORDER\s+(?:AND|&)\s+REASONS|"
    r"MEMORANDUM\s+(?:OPINION\s+)?(?:AND|&)\s+ORDER|ORDER\s+AND\s+OPINION|MEMORANDUM\s+(?:OPINION|RULING)|"
    r"ORDER\s+AND\s+JUDGMENT|JUDGMENT|ORDER|OPINION)\b")
# A motion's name as orders write it, in title case: "Motion to Dismiss for Failure to State a Claim". Lowercase words
# other than short connectors end it ("... filed by", "... is GRANTED").
_WORD = r"[A-Z][\w'/&-]*"
MOTION_NAME_RE = re.compile(rf"\bMotion\s+(?:to|for|in)\s+(?:(?:{_WORD}|of|the|and|or|to|for|in|on|a|an|as|with|from|under)\s+)*{_WORD}")


def package_id(case: str) -> str:
    return f"USCOURTS-{COURT}-" + case.replace(":", "_")


def pdf_link(granule: str) -> str:
    m = GRANULE_RE.match(granule)
    return f"{CONTENT}{m.group(1)}/pdf/{granule}.pdf" if m else ""


def read_stamp(text: str) -> tuple[str, str]:
    """(docket number, filing date YYYY-MM-DD) from the CM/ECF stamp, or ("", "")."""
    m = STAMP_RE.search(text or "")
    if not m:
        return "", ""
    doc, mo, d, y = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    y = y + 2000 if y < 100 else y
    try:
        return doc, dt.date(y, mo, d).isoformat()
    except ValueError:
        return doc, ""


def case_stamp(text: str) -> tuple[str, str]:
    """(case number, presiding judge's initials) from the CM/ECF stamp, or ("", "")."""
    m = CASE_STAMP_RE.search(text or "")
    return (m.group(1), m.group(2)) if m else ("", "")


def describe(text: str) -> dict:
    """The order's title and the motions its opening paragraph names, read from the PDF text as plain data:
    {"text": "ORDER AND REASONS", "motions": [{"name": "Motion to Dismiss"}]}, the shape event_for() reads."""
    head = HEADING_RE.search((text or "")[:6000])
    title = re.sub(r"\s+", " ", head.group(1)).upper() if head else ""
    body = re.sub(r"\s+", " ", (text or "")[head.end() if head else 0:][:1500])
    names: list[str] = []
    for m in MOTION_NAME_RE.finditer(body):
        name = m.group(0).strip()
        low = name.lower()
        # "Motion to Dismiss" after "Motion to Dismiss for Failure to State a Claim" is the same motion, named short.
        if not any(n.lower().startswith(low) or low.startswith(n.lower()) for n in names):
            names.append(name)
        if len(names) == 3:
            break
    return {"text": title, "motions": [{"name": n} for n in names]}


def pdf_text(data: bytes) -> tuple[str, int]:
    """Text and page count of a PDF. Needs pypdf; returns ("", 0) when the file cannot be read."""
    from pypdf import PdfReader  # imported here so the updater runs without it (GovInfo is then skipped)
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        pages = len(reader.pages)
        text = "\n".join((p.extract_text() or "") for p in reader.pages[:60])
        return text, pages
    except Exception:  # a damaged or image-only PDF: count it as read, with nothing found
        return "", 0


class GovInfo:
    def __init__(self, key: str | None, http_get, deadline: float, log=print):
        self.key = key
        self.http_get = http_get
        self.deadline = deadline
        self.log = log
        self.api_calls = 0
        self.pdfs = 0
        self.stopped = ""   # why this run stopped calling GovInfo, if it did
        self.errors: list[str] = []

    def _out(self) -> bool:
        if not self.stopped and time.monotonic() >= self.deadline:
            self.stopped = "time limit"
        return bool(self.stopped)

    def granules(self, pkg: str) -> list[str] | None:
        """Granule IDs in a package, oldest first; [] when GovInfo has no such package; None when it cannot say."""
        ids: list[str] = []
        url = f"{API}packages/{pkg}/granules?offsetMark=*&pageSize=100"
        while url:
            if self._out() or self.api_calls >= API_BUDGET:
                self.stopped = self.stopped or "call budget"
                return None
            self.api_calls += 1
            try:
                data = json.loads(self.http_get(url, {"X-Api-Key": self.key, "Accept": "application/json"}))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return []
                self.errors.append(f"GovInfo HTTP {e.code}")
                if e.code in (401, 403, 429):
                    self.stopped = f"HTTP {e.code}"
                return None
            except Exception as e:  # network error or bad JSON
                self.errors.append(f"GovInfo {type(e).__name__}")
                return None
            ids += [g.get("granuleId", "") for g in data.get("granules", []) if GRANULE_RE.match(g.get("granuleId", ""))]
            nxt = data.get("nextPage") or ""
            url = nxt if nxt.startswith(API) else ""
        return sorted(set(ids), key=lambda g: int(GRANULE_RE.match(g).group(2)))

    def modified_packages(self, since: dt.datetime) -> list[dict] | None:
        """This court's civil packages changed since `since` (a new opinion changes its case's package), as
        [{"id", "modified", "title"}]; None when GovInfo cannot say."""
        stamp = since.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        url = f"{API}collections/USCOURTS/{stamp}?offsetMark=*&pageSize=100&courtCode={COURT}"
        out: list[dict] = []
        for _ in range(10):
            if self._out() or self.api_calls >= DISCOVER_API:
                self.stopped = self.stopped or "call budget"
                return None
            self.api_calls += 1
            try:
                data = json.loads(self.http_get(url, {"X-Api-Key": self.key, "Accept": "application/json"}))
            except urllib.error.HTTPError as e:
                self.errors.append(f"GovInfo HTTP {e.code}")
                if e.code in (401, 403, 429):
                    self.stopped = f"HTTP {e.code}"
                return None
            except Exception as e:
                self.errors.append(f"GovInfo {type(e).__name__}")
                return None
            out += [{"id": p["packageId"], "modified": str(p.get("lastModified") or ""), "title": str(p.get("title") or "")}
                    for p in data.get("packages", []) if PKG_RE.match(str(p.get("packageId") or ""))]
            nxt = data.get("nextPage") or ""
            if not nxt.startswith(API):
                return out
            url = nxt
        self.errors.append("GovInfo listing past the page limit not read")
        return None

    def pdf(self, granule: str) -> bytes | None:
        link = pdf_link(granule)
        if not link or self._out() or self.pdfs >= PDF_BUDGET:
            self.stopped = self.stopped or ("download budget" if link else "")
            return None
        self.pdfs += 1
        try:
            return self.http_get(link, {"Accept": "application/pdf"}, 60)
        except urllib.error.HTTPError as e:
            self.errors.append(f"GovInfo PDF HTTP {e.code}")
            if e.code == 429:
                self.stopped = "HTTP 429"
            return None
        except Exception as e:
            self.errors.append(f"GovInfo PDF {type(e).__name__}")
            return None
        finally:
            time.sleep(PDF_PAUSE)


def backfill(gi: GovInfo, opinions: list[dict], needs, cache: dict, apply, today: str) -> dict:
    """Find GovInfo's copy of each opinion that `needs` work and hand it to `apply(row, pdf_url, pages, text)`.

    Cases with the newest needed opinions go first. Within a case, granules are read newest first and reading
    stops once every needed docket number is found or the stamps reach dates older than any needed opinion.
    `cache` (data/govinfo.json) remembers each package's granule list and each granule's docket number, so no
    PDF is downloaded twice except to re-read an opinion's text.
    """
    packages = cache.setdefault("packages", {})
    granules = cache.setdefault("granules", {})
    cutoff = (dt.date.fromisoformat(today) - dt.timedelta(days=RECHECK_DAYS)).isoformat()
    by_case: dict[str, list[dict]] = {}
    for o in opinions:
        if needs(o) and str(o.get("doc", "")).isdigit():
            by_case.setdefault(o["case"], []).append(o)
    stats = {"cases": 0, "read": 0, "matched": 0}
    for case in sorted(by_case, key=lambda c: max(o["date"] for o in by_case[c]), reverse=True):
        if gi._out():
            break
        pkg = package_id(case)
        if not PKG_RE.match(pkg):
            continue
        rows = {o["doc"]: o for o in by_case[case]}
        pc = packages.get(pkg)
        if pc is None or pc.get("checked", "") <= cutoff:
            ids = gi.granules(pkg)
            if ids is None:
                if gi.stopped:
                    break
                continue
            pc = packages[pkg] = {**(pc or {}), "checked": today, "granules": ids}
        stats["cases"] += 1
        oldest = min(o["date"] for o in rows.values())
        for g in sorted(pc["granules"], key=lambda g: int(GRANULE_RE.match(g).group(2)), reverse=True):
            if not rows or gi._out():
                break
            known = granules.get(g)
            if known and known.get("doc") not in rows:
                if known.get("date") and known["date"] < oldest:
                    break  # older than anything still needed in this case
                continue
            data = gi.pdf(g)
            if data is None:
                break
            text, pages = pdf_text(data)
            doc, filed = read_stamp(text)
            granules[g] = {"doc": doc, "date": filed, "pages": pages}
            stats["read"] += 1
            if doc in rows:
                apply(rows.pop(doc), pdf_link(g), pages, text)
                stats["matched"] += 1
            elif filed and filed < oldest:
                break
    return stats


def discover(gi: GovInfo, cache: dict, known: set, add, now: dt.datetime) -> dict:
    """Find written opinions GovInfo has posted that are not in the data and hand each to
    `add(case, doc, filed, text, pages, pdf_url, title)`.

    Lists the court's packages changed since the last complete listing, newest first. In each, granules not read
    before are read newest first, stopping at the first one already on file or filed more than DISCOVER_DAYS ago,
    so a case with a long history costs one or two downloads. A package is marked done (its `modified` time kept)
    only when read to that point, and the listing time advances only when every package is done.
    """
    packages = cache.setdefault("packages", {})
    granules = cache.setdefault("granules", {})
    last = cache.get("discovered", "")
    since = (dt.datetime.fromisoformat(last) - DISCOVER_OVERLAP) if last else now - dt.timedelta(days=7)
    stats = {"packages": 0, "read": 0, "added": 0, "complete": False}
    listed = gi.modified_packages(since)
    if listed is None:
        return stats
    cutoff = (now.date() - dt.timedelta(days=DISCOVER_DAYS)).isoformat()
    today = now.date().isoformat()
    complete = True
    for p in sorted(listed, key=lambda p: p["modified"], reverse=True):
        pkg, pc = p["id"], packages.get(p["id"]) or {}
        if pc.get("modified", "") >= p["modified"] and pc.get("modified"):
            continue
        if gi._out() or gi.api_calls >= DISCOVER_API or gi.pdfs >= DISCOVER_PDFS:
            complete = False
            break
        ids = gi.granules(pkg)
        if ids is None:
            complete = False
            if gi.stopped:
                break
            continue
        stats["packages"] += 1
        case = pkg.replace(f"USCOURTS-{COURT}-", "").replace("_", ":")
        done = True
        for g in sorted(ids, key=lambda g: int(GRANULE_RE.match(g).group(2)), reverse=True):
            seen = granules.get(g)
            if seen:
                if (case, seen.get("doc")) in known or (seen.get("date") or "9999") < cutoff:
                    break
                continue
            if gi.pdfs >= DISCOVER_PDFS:
                done = False
                break
            data = gi.pdf(g)
            if data is None:
                done = False
                break
            text, pages = pdf_text(data)
            doc, filed = read_stamp(text)
            granules[g] = {"doc": doc, "date": filed, "pages": pages}
            stats["read"] += 1
            if not doc or (case, doc) in known:
                if doc:
                    break
                continue
            if filed and filed < cutoff:
                break
            if case_stamp(text)[0] in ("", case) and filed:
                add(case, doc, filed, text, pages, pdf_link(g), p["title"])
                known.add((case, doc))
                stats["added"] += 1
        if done:
            packages[pkg] = {**pc, "checked": today, "granules": ids, "modified": p["modified"]}
        else:
            complete = False
            break
    if complete:
        cache["discovered"] = now.astimezone(dt.timezone.utc).isoformat(timespec="seconds")
    stats["complete"] = complete
    return stats


def load_cache(path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {"packages": {}, "granules": {}}


def save_cache(path, cache: dict) -> None:
    path.write_text(json.dumps(cache, sort_keys=True, indent=0, separators=(",", ":")) + "\n")
