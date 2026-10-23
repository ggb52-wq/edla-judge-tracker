"""Parties and counsel for civil cases, from PACER docket reports (data/counsel.json).

CourtListener lists attorneys only for dockets someone has bought with the parties shown (77 of about 4,850 cases in
Oct. 2026), and the court's RSS feed and opinions name no counsel. The docket report itself lists every party and every
attorney who has appeared, so this script buys it, with "Parties and counsel" checked and the entries cut to document 1,
which keeps each report to the few pages the party list fills (PACER charges $0.10 a page, at most $3.00 a report).

Runs from .github/workflows/counsel.yml with the owner's PACER account (PACER_USERNAME, PACER_PASSWORD, and, for an
account with two-step sign-in, PACER_TOTP_SECRET). Docket reports are fee reports bought one case at a time; no
no-fee report is read. Spending stops at PACER_QUARTER_LIMIT dollars a calendar quarter (default 29.00, under the $30
a quarter PACER waives) and is paced across the quarter unless PACER_RUN_LIMIT sets a per-run figure. Cases named in
COUNSEL_CASES (the owner's "Counsel:" issue or a manual run) come first; then cases whose feed shows a change of counsel
since the last read, active cases never read (those with recent motions or opinions first), and reads older than
REFRESH_DAYS. Kept per attorney: name, firm, city, and lead / pro hac vice / pro se / terminated marks; street
addresses, telephone numbers, and email addresses are dropped.

Everything read from PACER is data: party names and firm names are stored as text and never acted on.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import html
import http.cookiejar
import json
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "counsel.json"
CENTRAL = ZoneInfo("America/Chicago")

COURT = "laed"
ECF = "https://ecf.laed.uscourts.gov"
AUTH_URL = "https://pacer.login.uscourts.gov/services/cso-auth"
LOGOUT_URL = "https://pacer.login.uscourts.gov/services/cso-logout"
USER_AGENT = "edla-analyzer (github.com/ggb52-wq/edla-judge-tracker)"

MAX_REPORT_COST = 3.00     # PACER's cap on one docket report (30 pages)
QUARTER_LIMIT = 29.00      # default spending limit a quarter; PACER waives a quarter's fees of $30 or less
REFRESH_DAYS = 120         # a read older than this is read again while the case is active
MISS_DAYS = 14             # a case PACER would not show (sealed, not found) is tried again after this
ACTIVE_DAYS = 60
PAUSE = 2.0                # seconds between PACER requests
COUNSEL_CHANGE = re.compile(r"pro hac vice|enrol|withdr|substitut|appearance|counsel|attorney", re.I)
CASE_RE = re.compile(r"\b(?:(\d):)?(\d{2})-?(cv|civ)-?0*(\d{1,5})\b", re.I)


class PacerError(Exception):
    pass


# ---------------------------------------------------------------- small helpers
def clean(s, n: int) -> str:
    return " ".join(str(s or "").split())[:n]


def norm_case(raw: str) -> str:
    m = CASE_RE.search(str(raw or ""))
    return f"{m.group(1) or '2'}:{m.group(2)}-cv-{m.group(4).zfill(5)}" if m else ""


def cases_in(text: str) -> list[str]:
    seen = []
    for m in CASE_RE.finditer(str(text or "")):
        c = norm_case(m.group(0))
        if c and c not in seen:
            seen.append(c)
    return seen


def quarter_of(d: dt.date) -> str:
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def quarter_days_left(d: dt.date) -> int:
    q = (d.month - 1) // 3
    end = dt.date(d.year + (q == 3), 1 if q == 3 else q * 3 + 4, 1)
    return (end - d).days


def totp(secret: str, at: float | None = None, digits: int = 6, step: int = 30) -> str:
    """RFC 6238 one-time code from a base32 secret (the text an authenticator app is given when PACER's two-step
    sign-in is set up)."""
    key = base64.b32decode(re.sub(r"[\s-]", "", secret).upper() + "=" * (-len(re.sub(r"[\s-]", "", secret)) % 8))
    counter = int((time.time() if at is None else at) // step)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def text_of(page: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", page)).split())


def receipt(page: str) -> tuple[int, float] | None:
    """Billable pages and cost from the PACER transaction receipt at the foot of a fee report."""
    t = text_of(page)
    p = re.search(r"Billable Pages:\s*(\d+)", t)
    c = re.search(r"Cost:\s*\$?\s*(\d+(?:\.\d+)?)", t)
    return (int(p.group(1)), float(c.group(1))) if p and c else None


def possible_cases(xml: str) -> list[dict]:
    """possible_case_numbers.pl answers <request><case number=".." id=".." title=".."/></request>."""
    out = []
    for m in re.finditer(r"<case\b([^>]*)/?>", xml or "", re.I):
        attrs = {k.lower(): html.unescape(v) for k, v in re.findall(r'(\w+)\s*=\s*["\']([^"\']*)["\']', m.group(1))}
        if attrs.get("id", "").isdigit():
            out.append(attrs)
    return out


def pick_case_id(case: str, found: list[dict]) -> str:
    for c in found:
        if norm_case(c.get("number", "")) == case and not c.get("defendant"):
            return c["id"]
    return ""


class FormReader(HTMLParser):
    """The first form on a CM/ECF page: its action and the default value of each control."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.action, self.fields, self.names, self._in_form, self._select, self._done = "", {}, [], False, None, False

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if self._done:
            return
        if tag == "form" and not self._in_form:
            self._in_form, self.action = True, a.get("action", "")
            return
        if not self._in_form:
            return
        name = a.get("name", "")
        if tag == "input" and name:
            kind = a.get("type", "text").lower()
            self.names.append(name)
            if kind in ("checkbox", "radio"):
                if "checked" in a:
                    self.fields[name] = a.get("value", "on")
            elif kind not in ("submit", "button", "reset", "image"):
                self.fields[name] = a.get("value", "")
        elif tag == "select" and name:
            self._select = name
            self.names.append(name)
        elif tag == "option" and self._select:
            if self._select not in self.fields or "selected" in a:
                self.fields[self._select] = a.get("value", "")

    def handle_endtag(self, tag):
        if tag == "select":
            self._select = None
        elif tag == "form" and self._in_form:
            self._in_form, self._done = False, True


def read_form(page: str) -> FormReader:
    f = FormReader()
    f.feed(page)
    return f


def report_fields(form: FormReader, pacer_id: str) -> dict:
    """The docket report form, filled in for the party list only: parties and counsel (terminated ones too), and
    entries cut to document 1."""
    fields = dict(form.fields)
    for name in list(fields):
        if name in ("list_of_member_cases", "view_multi_docs", "pdf_header", "list_of_parties_and_counsel", "terminated_parties"):
            fields.pop(name)
    fields.update({"all_case_ids": pacer_id, "list_of_parties_and_counsel": "on", "terminated_parties": "on",
                   "documents_numbered_from_": "1", "documents_numbered_to_": "1", "date_from": "", "date_to": "",
                   "output_format": "html", "date_range_type": fields.get("date_range_type") or "Filed"})
    fields.setdefault("sort1", "oldest date first")
    return fields


# ---------------------------------------------------------------- reading the party list
ROLE_DATE = re.compile(r"TERMINATED:\s*(\d{1,2})/(\d{1,2})/(\d{4})", re.I)
CITY_RE = re.compile(r"^(.+?),?\s+([A-Z]{2})\s+\d{5}(?:-\d{4})?$")
NOT_FIRM = re.compile(r"^(?:\d|p\.?\s*o\.?\s|post office|suite\b|ste\.?\s|floor\b|\(see above|email:|e-mail|fax|tel|phone|\(?\d{3}\)?[\s.-]\d{3})", re.I)


def contact_bits(contact: str) -> tuple[str, str]:
    lines = [clean(x, 120) for x in str(contact or "").splitlines() if x.strip()]
    firm = ""
    if lines and not NOT_FIRM.search(lines[0]) and not CITY_RE.match(lines[0]) and "@" not in lines[0]:
        firm = lines[0][:100]
    city = next((f"{m.group(1).strip().rstrip(',')}, {m.group(2)}" for m in map(CITY_RE.match, lines) if m), "")
    return firm, city[:60]


def iso_role_date(roles: list[str]) -> str:
    for r in roles:
        m = ROLE_DATE.search(r)
        if m:
            return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return ""


def normalize_parties(parties: list[dict]) -> list[dict]:
    out, last = [], "Party"
    for p in parties or []:
        kind = clean(p.get("type"), 40)
        if not kind or kind.lower() in ("unknown", "service list"):
            kind = last if kind.lower() != "service list" else ""
            if not kind:
                continue
        last = kind
        name = clean(p.get("name"), 160)
        if not name:
            continue
        row = {"type": kind, "name": name}
        ended = p.get("date_terminated")
        if ended:
            row["terminated"] = ended.isoformat() if hasattr(ended, "isoformat") else clean(ended, 10)
        lawyers = []
        for a in p.get("attorneys") or []:
            aname = clean(a.get("name"), 100)
            if not aname:
                continue
            roles = [clean(r, 60).upper() for r in a.get("roles") or []]
            at = {"name": aname}
            firm, city = contact_bits(a.get("contact", ""))
            if any(r.startswith("PRO SE") for r in roles) or aname.lower() == name.lower():
                at["pro_se"] = True
                firm = ""
            if firm:
                at["firm"] = firm
            if city:
                at["city"] = city
            if any("LEAD ATTORNEY" in r for r in roles):
                at["lead"] = True
            if any("PRO HAC VICE" in r for r in roles):
                at["phv"] = True
            end = iso_role_date(roles)
            if end:
                at["terminated"] = end
            lawyers.append(at)
        if lawyers:
            row["attorneys"] = lawyers
        out.append(row)
    return out


def parse_report(page: str) -> list[dict]:
    """Parties and counsel from a docket report, read with Free Law Project's juriscraper (the parser CourtListener
    runs on every PACER docket)."""
    import logging
    logging.disable(logging.CRITICAL)  # juriscraper logs every page it parses
    from juriscraper.pacer import DocketReport
    report = DocketReport(COURT)
    report._parse_text(page)
    try:
        parties = report.data.get("parties") or []  # .data fills "see above for address" from the attorney's first listing
    except Exception:
        parties = report.parties or []
    return normalize_parties(parties)


# ---------------------------------------------------------------- PACER
class Pacer:
    def __init__(self, username: str, password: str, client_code: str = "", otp_secret: str = ""):
        self.username, self.password, self.client_code, self.otp_secret = username, password, client_code, otp_secret
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.token = ""
        self._last = 0.0

    def _wait(self):
        gap = PAUSE - (time.time() - self._last)
        if gap > 0:
            time.sleep(gap)
        self._last = time.time()

    def _cookie(self, name: str, value: str):
        self.jar.set_cookie(http.cookiejar.Cookie(0, name, value, None, False, ".uscourts.gov", True, True, "/", True,
                                                  True, None, False, None, None, {}))

    def login(self):
        body = {"loginId": self.username, "password": self.password, "redactFlag": "1"}
        if self.client_code:
            body["clientCode"] = self.client_code
        if self.otp_secret:
            body["otpCode"] = totp(self.otp_secret)
        req = urllib.request.Request(AUTH_URL, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT})
        self._wait()
        with self.opener.open(req, timeout=60) as r:
            res = json.loads(r.read().decode("utf-8", "replace") or "{}")
        if str(res.get("loginResult")) != "0" or not res.get("nextGenCSO"):
            # The message is PACER's own ("Invalid username or password", "one-time passcode required"); no credential is in it.
            raise PacerError("PACER sign-in refused: " + clean(res.get("errorDescription") or f"result {res.get('loginResult')}", 200))
        self.token = res["nextGenCSO"]
        self._cookie("NextGenCSO", self.token)
        self._cookie("PacerSession", self.token)
        if self.client_code:
            self._cookie("PacerClientCode", self.client_code)

    def logout(self):
        if not self.token:
            return
        try:
            req = urllib.request.Request(LOGOUT_URL, data=json.dumps({"nextGenCSO": self.token}).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT})
            self.opener.open(req, timeout=30).read()
        except Exception:
            pass
        self.token = ""

    def fetch(self, url: str, data: dict | None = None) -> str:
        self._wait()
        req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data is not None else None,
                                     headers={"User-Agent": USER_AGENT})
        with self.opener.open(req, timeout=120) as r:
            landed = urllib.parse.urlsplit(r.geturl()).hostname or ""
            page = r.read().decode("latin-1" if "latin" in (r.headers.get_content_charset() or "") else "utf-8", "replace")
        if landed.startswith("pacer.login."):  # CM/ECF sends a request without a live session to the sign-in page
            raise PacerError("PACER session ended")
        return page

    def case_id(self, case: str) -> str:
        """The court's internal case id, from the case-number lookup the docket report form itself uses (no fee)."""
        office, rest = case.split(":")
        yy, _, num = rest.split("-")
        for q in (case, f"{office}:{yy}-cv-{int(num)}", f"{yy}-{int(num)}"):
            ids = possible_cases(self.fetch(f"{ECF}/cgi-bin/possible_case_numbers.pl?{urllib.parse.quote(q, safe=':-')}"))
            got = pick_case_id(case, ids)
            if got:
                return got
        return ""

    def party_report(self, pacer_id: str, allowance: float) -> tuple[str, float]:
        """Buys the docket report with parties and counsel and document 1 only. Returns the page and its cost."""
        form_page = self.fetch(f"{ECF}/cgi-bin/DktRpt.pl?{pacer_id}")
        form = read_form(form_page)
        if form.action and "DktRpt.pl" in form.action:
            url = urllib.parse.urljoin(f"{ECF}/cgi-bin/", form.action)
            fields = report_fields(form, pacer_id)
        else:
            url = f"{ECF}/cgi-bin/DktRpt.pl?1-L_1_0-1"
            fields = report_fields(FormReader(), pacer_id)
        page = self.fetch(url, fields)
        if "represented by" not in page and "DOCKET FOR CASE" not in page.upper():
            # A long report can come back as a notice naming its cost, with a button to go on.
            ask = re.search(r"Cost:?\s*\$?\s*(\d+(?:\.\d+)?)", text_of(page))
            nxt = read_form(page)
            if ask and nxt.action:
                if float(ask.group(1)) > allowance:
                    raise PacerError(f"report would cost ${float(ask.group(1)):.2f}")
                page = self.fetch(urllib.parse.urljoin(f"{ECF}/cgi-bin/", nxt.action), nxt.fields)
        rc = receipt(page)
        if "DOCKET FOR CASE" not in page.upper():
            raise PacerError("no docket report (" + clean(text_of(page), 120) + ")")
        return page, (rc[1] if rc else MAX_REPORT_COST)


# ---------------------------------------------------------------- choosing cases
def load(path: Path, empty):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return empty


def queue(counsel: dict, activity: dict, motions: list, opinions: list, feed: list, requested: list[str], today: dt.date) -> list[tuple[str, bool]]:
    """Cases to read, in order, each with whether the owner asked for it."""
    have = counsel.get("cases", {})
    misses = counsel.get("misses", {})
    floor = (today - dt.timedelta(days=ACTIVE_DAYS)).isoformat()
    miss_floor = (today - dt.timedelta(days=MISS_DAYS)).isoformat()
    stale = (today - dt.timedelta(days=REFRESH_DAYS)).isoformat()
    last = {}
    for row in activity.get("cases", []):
        if len(row) == 3 and "-cv-" in row[0] and row[2] >= floor:
            last[row[0]] = row[2]
    busy = {r.get("case") for r in list(motions) + list(opinions) if r.get("date", "") >= floor}
    changed = {}
    for r in feed:
        if COUNSEL_CHANGE.search(r.get("event", "")):
            changed[r.get("case")] = max(changed.get(r.get("case"), ""), r.get("at", "")[:10])
    out, seen = [], set()
    for c in requested:
        if c not in seen:
            out.append((c, True))
            seen.add(c)
    ranked = []
    for c, when in last.items():
        if c in seen or misses.get(c, "") >= miss_floor:
            continue
        read = have.get(c, {}).get("read", "")
        if read and changed.get(c, "") >= read and read < today.isoformat():
            ranked.append(((1, -int(changed[c].replace("-", ""))), c))
        elif not read:
            ranked.append(((2 if c in busy else 3, -int(when.replace("-", ""))), c))
        elif read < stale:
            ranked.append(((4, int(read.replace("-", ""))), c))
    out += [(c, False) for _, c in sorted(ranked)]
    return out


# ---------------------------------------------------------------- the file
def save(counsel: dict) -> None:
    """One case per line, so a day's reads show as a short diff."""
    cases = counsel.get("cases", {})
    head = {k: v for k, v in counsel.items() if k != "cases"}
    lines = [json.dumps(c, ensure_ascii=False) + ":" + json.dumps(cases[c], ensure_ascii=False, separators=(",", ":")) for c in sorted(cases)]
    body = json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1]
    OUT.write_text(body + (',' if head else '') + '"cases":{\n' + ",\n".join(lines) + "\n}}\n")


def run(pacer, counsel: dict, todo: list[tuple[str, bool]], now: dt.datetime, quarter_limit: float, run_limit: float | None,
        note: list[str]) -> dict:
    today = now.date()
    q = quarter_of(today)
    spent = counsel.setdefault("spent", {})
    spent.setdefault(q, 0.0)
    cases = counsel.setdefault("cases", {})
    misses = counsel.setdefault("misses", {})
    pace = (quarter_limit - spent[q]) / max(quarter_days_left(today), 1)
    cap = run_limit if run_limit is not None else max(pace, 0.0)
    run_spent, read, logged_in = 0.0, 0, False
    for case, asked in todo:
        left_q = quarter_limit - spent[q]
        if left_q < MAX_REPORT_COST:
            note.append(f"quarter limit reached (${spent[q]:.2f} of ${quarter_limit:.2f})")
            break
        if not asked and run_spent >= cap:
            break
        if not logged_in:
            pacer.login()
            logged_in = True
        try:
            pid = cases.get(case, {}).get("pacer_id") or pacer.case_id(case)
            if not pid:
                misses[case] = today.isoformat()
                note.append(f"{case}: not found in CM/ECF")
                continue
            page, cost = pacer.party_report(pid, left_q)
        except PacerError as e:
            if "session ended" in str(e) or "sign-in" in str(e):
                raise
            misses[case] = today.isoformat()
            note.append(f"{case}: {e}")
            continue
        spent[q] = round(spent[q] + cost, 2)
        run_spent = round(run_spent + cost, 2)
        try:
            parties = parse_report(page)
        except Exception as e:  # paid for, but unreadable: kept as a miss so it is not bought again for two weeks
            misses[case] = today.isoformat()
            note.append(f"{case}: report not readable ({type(e).__name__})")
            continue
        cases[case] = {"read": today.isoformat(), "cost": cost, "pacer_id": pid, "parties": parties}
        misses.pop(case, None)
        read += 1
    counsel["checked"] = now.isoformat(timespec="minutes")
    floor = (today - dt.timedelta(days=MISS_DAYS)).isoformat()
    counsel["misses"] = {c: d for c, d in sorted(misses.items()) if d >= floor}
    note.insert(0, f"{read} dockets read, ${run_spent:.2f} this run, ${spent[q]:.2f} of ${quarter_limit:.2f} this quarter")
    return counsel


def main() -> int:
    user, pw = os.environ.get("PACER_USERNAME", ""), os.environ.get("PACER_PASSWORD", "")
    result_file = os.environ.get("RESULT_FILE")
    if not user or not pw:
        msg = "PACER_USERNAME and PACER_PASSWORD are not set as repository secrets; no docket was read."
        print(msg)
        if result_file:
            Path(result_file).write_text(msg + "\n")
        return 0
    now = dt.datetime.now(CENTRAL)
    def money(name, default):
        try:
            return float(os.environ.get(name) or default)
        except ValueError:
            return default
    quarter_limit = money("PACER_QUARTER_LIMIT", QUARTER_LIMIT)
    run_limit = money("PACER_RUN_LIMIT", -1.0)
    counsel = load(OUT, {})
    requested = cases_in(os.environ.get("COUNSEL_CASES", ""))
    todo = queue(counsel, load(DATA / "case_activity.json", {}), load(DATA / "motions.json", []), load(DATA / "opinions.json", []),
                 load(DATA / "feed.json", []), requested, now.date())
    note: list[str] = []
    pacer = Pacer(user, pw, os.environ.get("PACER_CLIENT_CODE", ""), os.environ.get("PACER_TOTP_SECRET", ""))
    try:
        counsel = run(pacer, counsel, todo, now, quarter_limit, run_limit if run_limit >= 0 else None, note)
        ok = True
    except Exception as e:  # what was read before the stop is still saved; only PACER's own messages are printed
        note.insert(0, f"stopped: {e if isinstance(e, PacerError) else type(e).__name__}")
        counsel["checked"] = now.isoformat(timespec="minutes")
        ok = False
    finally:
        pacer.logout()
    save(counsel)
    for c in requested:
        row = counsel.get("cases", {}).get(c)
        note.append(f"{c}: " + (f"{len(row['parties'])} parties, {sum(len(p.get('attorneys', [])) for p in row['parties'])} attorney listings (read {row['read']})"
                                 if row and row.get("read") == now.date().isoformat() else "not read"))
    print("\n".join(note))
    if result_file:
        Path(result_file).write_text("\n".join(note) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
