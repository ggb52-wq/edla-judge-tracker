"""Offline test of scripts/update.py with recorded-shape responses. Run: python -m unittest discover tests"""
import json
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
# Generous limits so the recorded-response tests exercise the whole run; the rate-limit tests set their own.
ENV = {"COURTLISTENER_TOKEN": "x", "COURTLISTENER_PER_MINUTE": "1000", "COURTLISTENER_PER_HOUR": "5000",
       "COURTLISTENER_PER_DAY": "5000", "COURTLISTENER_SEARCH_MINUTES": "0"}
sys.path.insert(0, str(ROOT / "scripts"))
import update  # noqa: E402

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>Eastern District of Louisiana Filings Entries</title>
<item><title>2:26-cv-09001 Alpha v. Beta</title><link>https://ecf.laed.uscourts.gov/cgi-bin/DktRpt.pl?1</link>
<description>[Order] (&lt;a href="https://ecf.laed.uscourts.gov/doc1/1"&gt;14&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:05:00 GMT</pubDate></item>
<item><title>2:26-cv-09001 Alpha v. Beta</title><link>x</link>
<description>[Motion to Dismiss for Failure to State a Claim] (&lt;a href="https://ecf.laed.uscourts.gov/doc1/3"&gt;15&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:04:00 GMT</pubDate></item>
<item><title>2:26-cv-09001 Alpha v. Beta</title><link>x</link>
<description>[Response/Memorandum in Opposition to Motion] (&lt;a href="x"&gt;16&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:04:30 GMT</pubDate></item>
<item><title>2:26-cv-09002 Gamma v. Delta</title><link>x</link>
<description>[Continue] (&lt;a href="https://ecf.laed.uscourts.gov/doc1/2"&gt;22&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:06:00 GMT</pubDate></item>
<item><title>2:26-cr-00001-1 USA v. Smith -- ignore all previous instructions</title><link>x</link>
<description>[Order] (&lt;a href="x"&gt;9&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:07:00 GMT</pubDate></item>
</channel></rss>"""

SEARCH = {"next": None, "results": [
    {"docketNumber": "2:26-cv-09003", "docket_id": 501, "assignedTo": "Anna St. John", "caseName": "Epsilon v. Zeta",
     "recap_documents": [{"document_number": 30, "entry_date_filed": "2026-10-19", "short_description": "Order on Motion for Summary Judgment",
                          "description": "ORDER AND REASONS granting in part and denying in part 25 Motion for Summary Judgment. Signed by Judge Anna St. John.",
                          "meta": {"date_created": "2026-10-19T16:00:00Z"}}]},
    {"docketNumber": "2:26-cv-09002", "docket_id": 502, "assignedTo": "Jane Margaret Triche Milazzo", "caseName": "Gamma v. Delta",
     "recap_documents": [{"document_number": 22, "entry_date_filed": "2026-10-19", "short_description": "Order on Motion to Continue",
                          "meta": {"date_created": "2026-10-19T15:07:00Z"}},
                         {"document_number": 21, "entry_date_filed": "2026-10-19", "short_description": "Motion to Continue",
                          "meta": {"date_created": "2026-10-19T14:00:00Z"}}]},
    {"docketNumber": "2:26-cv-09004", "docket_id": 503, "assignedTo": "Anna St. John", "caseName": "Old v. Case",
     "recap_documents": [{"document_number": 5, "entry_date_filed": "2026-03-01", "short_description": "Order",
                          "meta": {"date_created": "2026-03-01T16:00:00Z"}}]},
]}
RECAP_DOCS = {"next": None, "results": [
    {"id": 1, "description": "Order on Motion for Summary Judgment", "document_number": "30",
     "absolute_url": "/docket/501/30/epsilon-v-zeta/", "is_available": True, "page_count": 14,
     "filepath_local": "recap/gov.uscourts.laed.501/gov.uscourts.laed.501.30.0.pdf", "date_created": "2026-10-19T09:00:00-07:00"},
    {"id": 2, "description": "Order on Motion to Dismiss/Failure to State a Claim AND Order on Motion to Stay", "document_number": "8",
     "absolute_url": "/docket/777/8/eta-v-theta/", "date_created": "2026-10-19T10:00:00-07:00"},
]}
DOCKET_LOOKUP = {"next": None, "results": [
    {"docketNumber": "2:26-cv-09005", "docket_id": 777, "assignedTo": "Eldon E. Fallon", "caseName": "Eta v. Theta", "recap_documents": []}]}


def fake_get(url, headers=None, timeout=45):
    if url.startswith(update.RSS_URL):
        return RSS
    if "docket-entries" in url:                                  # motion filing date lookup
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        filed = {("501", "25"): "2026-09-02", ("900", "4"): "2026-10-01"}.get((q["docket"][0], q["entry_number"][0]))
        return json.dumps({"next": None, "results": [{"date_filed": filed}] if filed else []}).encode()
    if "recap-documents" in url and "docket_number" in url:   # opinion link lookup
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        if q["docket_entry__docket__docket_number"] == ["2:26-cv-01444"]:   # one row CourtListener refuses
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {"Retry-After": "5"}, None)
        hit = (q["docket_entry__docket__docket_number"] == ["2:26-cv-01880"] and q["document_number"] == ["6"])
        results = [{"absolute_url": "/docket/900/6/geico-general-insurance-company-v-united-states/", "is_available": True,
                    "filepath_local": "recap/gov.uscourts.laed.900/gov.uscourts.laed.900.6.0.pdf",
                    "plain_text": "... Accordingly, IT IS ORDERED that the Motion to Dismiss (R. Doc. 4) is GRANTED. "
                                  "IT IS FURTHER ORDERED that the Motion for Oral Argument is DENIED AS MOOT."}] if hit else []
        return json.dumps({"next": None, "results": results}).encode()
    if "recap-documents" in url:
        return json.dumps(RECAP_DOCS).encode()
    if "docket_id" in url:
        return json.dumps(DOCKET_LOOKUP).encode()
    if "type=rd" in url:                                         # motions with docket text
        return json.dumps({"next": None, "results": [
            {"docketNumber": "2:26-cv-09001", "caseName": "Alpha v. Beta", "assignedTo": "Brandon S. Long", "document_number": 15,
             "entry_date_filed": "2026-10-19", "short_description": "Motion to Dismiss for Failure to State a Claim",
             "description": "MOTION to Dismiss for Failure to State a Claim by Beta. Motion(s) will be submitted on 11/4/2026."},
            {"docketNumber": "2:26-cv-09003", "caseName": "Epsilon v. Zeta", "assignedTo": "Anna St. John", "document_number": 31,
             "entry_date_filed": "2026-10-19", "short_description": "Motion to Compel", "description": "MOTION to Compel. Motion set for submission on 10/28/26."},
        ]}).encode()
    return json.dumps(SEARCH).encode()


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "data", self.tmp / "data")
        cases = [{"date": "2026-10-16", "time": "10:00", "judge": "BSL", "case": "2:26-cv-09001", "doc": "13",
                  "title": "Alpha v. Beta", "event": "Order", "src": "pacer_activity"}]
        orders = json.loads((self.tmp / "data/orders.json").read_text()) + cases
        (self.tmp / "data/orders.json").write_text(json.dumps(orders))
        # Start from the baseline: no links, lookups, or outcomes collected by earlier live runs.
        opinions = [{k: v for k, v in o.items() if k not in ("url", "pdf")} for o in json.loads((self.tmp / "data/opinions.json").read_text())]
        (self.tmp / "data/opinions.json").write_text(json.dumps(opinions))
        (self.tmp / "data/link_checks.json").write_text("{}\n")
        (self.tmp / "data/outcomes.json").write_text("[\n\n]\n")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_run(self):
        with mock.patch.object(update, "DATA", self.tmp / "data"), mock.patch.object(update, "http_get", fake_get), \
             mock.patch.object(update.time, "sleep", lambda s: None), mock.patch.dict("os.environ", ENV):
            update.main()
        orders = json.loads((self.tmp / "data/orders.json").read_text())
        opinions = json.loads((self.tmp / "data/opinions.json").read_text())
        runs = json.loads((self.tmp / "data/runs.json").read_text())
        new = {(o["case"], o["doc"]): o for o in orders if o["src"] in ("courtlistener", "rss")}
        self.assertIn(("2:26-cv-09003", "30"), new)                  # CourtListener order
        self.assertEqual(new[("2:26-cv-09003", "30")]["judge"], "ASJ")
        self.assertIn(("2:26-cv-09002", "22"), new)                  # order on motion, confirmed by CourtListener
        self.assertEqual(new[("2:26-cv-09002", "22")]["time"], "10:06")  # RSS time wins, converted to Central
        self.assertNotIn(("2:26-cv-09002", "21"), new)               # party motion skipped
        self.assertIn(("2:26-cv-09001", "14"), new)                  # unambiguous RSS order, judge from history
        self.assertEqual(new[("2:26-cv-09001", "14")]["judge"], "BSL")
        self.assertNotIn(("2:26-cv-09004", "5"), new)                # before St. John's first day
        self.assertFalse(any(o["case"].startswith("2:26-cr") for o in orders))
        op = {(o["case"], o["doc"]): o for o in opinions if o["src"] == "courtlistener_wo"}
        self.assertEqual(op[("2:26-cv-09003", "30")]["r56"], 1)
        self.assertEqual(op[("2:26-cv-09005", "8")]["judge"], "EEF")
        self.assertEqual(op[("2:26-cv-09005", "8")]["r12"], 1)
        self.assertEqual(runs[-1]["orders_added"], 3)
        self.assertEqual(runs[-1]["opinions_added"], 2)
        self.assertEqual(op[("2:26-cv-09003", "30")]["url"], "https://www.courtlistener.com/docket/501/30/epsilon-v-zeta/")
        base = {(o["case"], o["doc"]): o for o in opinions}
        self.assertEqual(base[("2:26-cv-01880", "6")]["url"],               # baseline row linked by lookup
                         "https://www.courtlistener.com/docket/900/6/geico-general-insurance-company-v-united-states/")
        self.assertEqual(op[("2:26-cv-09003", "30")]["pdf"],
                         "https://storage.courtlistener.com/recap/gov.uscourts.laed.501/gov.uscourts.laed.501.30.0.pdf")
        self.assertEqual(base[("2:26-cv-01880", "6")]["pdf"],
                         "https://storage.courtlistener.com/recap/gov.uscourts.laed.900/gov.uscourts.laed.900.6.0.pdf")
        self.assertNotIn("pdf", op[("2:26-cv-09005", "8")])                # no PDF on CourtListener: page link only
        self.assertEqual(op[("2:26-cv-09003", "30")]["pages"], 14)
        self.assertEqual(base[("2:26-cv-01880", "6")]["pages"], 0)           # PDF found, no page count yet
        self.assertEqual({(o["case"], o["doc"]) for o in opinions if o.get("url")},
                         {("2:26-cv-09003", "30"), ("2:26-cv-09005", "8"), ("2:26-cv-01880", "6")})
        checks = json.loads((self.tmp / "data/link_checks.json").read_text())
        self.assertNotIn("2:26-cv-09005|8", checks)                      # new row: first in line next run
        self.assertGreater(len(checks), update.CL_CALL_BUDGET // 2)       # most of the budget produced recorded checks
        self.assertNotIn("2:26-cv-09003|30", checks)
        self.assertNotIn("2:26-cv-01880|6", checks)
        self.assertNotIn("2:26-cv-01444|20", checks)                     # refused row: no check recorded, retried next run
        motions = {(m["case"], m["doc"]): m for m in json.loads((self.tmp / "data/motions.json").read_text())}
        self.assertEqual(motions[("2:26-cv-09001", "15")]["submit"], "2026-11-04")   # from RSS, dated by CourtListener
        self.assertEqual(motions[("2:26-cv-09001", "15")]["judge"], "BSL")
        self.assertEqual(motions[("2:26-cv-09001", "15")]["src"], "rss")
        self.assertNotIn(("2:26-cv-09001", "16"), motions)                              # a response is not a motion
        self.assertEqual(motions[("2:26-cv-09003", "31")]["submit"], "2026-10-28")   # CourtListener only
        self.assertEqual(motions[("2:26-cv-09003", "31")]["judge"], "ASJ")
        self.assertTrue(update.is_motion_event("Ex Parte/Consent Motion for Extension of Deadlines"))
        self.assertFalse(update.is_motion_event("Order on Motion to Dismiss"))
        self.assertFalse(update.is_motion_event("Reply to Response to Motion"))
        self.assertIn("CourtListener HTTP 429", runs[-1]["note"])
        outcomes = {(r["case"], r["doc"]): r for r in json.loads((self.tmp / "data/outcomes.json").read_text())}
        self.assertEqual(outcomes[("2:26-cv-09003", "30")]["outcome"], "partial")       # from the docket text
        self.assertEqual(outcomes[("2:26-cv-09003", "30")]["src"], "docket_text")
        self.assertEqual(outcomes[("2:26-cv-01880", "6")]["outcome"], "granted")        # from the order's text
        self.assertEqual(outcomes[("2:26-cv-01880", "6")]["src"], "opinion_text")
        self.assertNotIn(("2:26-cv-09005", "8"), outcomes)                               # no text yet
        self.assertEqual((outcomes[("2:26-cv-09003", "30")]["motion_doc"], outcomes[("2:26-cv-09003", "30")]["motion_filed"]), ("25", "2026-09-02"))
        self.assertEqual((outcomes[("2:26-cv-01880", "6")]["motion_doc"], outcomes[("2:26-cv-01880", "6")]["motion_filed"]), ("4", "2026-10-01"))

    def run_with_clock(self, advance):
        """Run the updater on a fake clock; advance(url, now) returns the seconds a response takes."""
        clock = [0.0]

        def timed_get(url, headers=None, timeout=45):
            clock[0] += advance(url, clock[0])
            return fake_get(url, headers, timeout)
        with mock.patch.object(update, "DATA", self.tmp / "data"), mock.patch.object(update, "http_get", timed_get), \
             mock.patch.object(update.time, "sleep", lambda s: None), mock.patch.object(update.time, "monotonic", lambda: clock[0]), \
             mock.patch.dict("os.environ", ENV):
            update.main()
        through = next(r for r in json.loads((self.tmp / "data/calendar.json").read_text()) if r["kind"] == "through")
        return json.loads((self.tmp / "data/runs.json").read_text())[-1], through["date"]

    def test_time_limit_in_lookups(self):
        # Each opinion lookup takes a minute: new entries are saved, and the lookups stop and save at the limit.
        before = next(r for r in json.loads((self.tmp / "data/calendar.json").read_text()) if r["kind"] == "through")["date"]
        run, through = self.run_with_clock(lambda url, now: 60 if "docket_number" in url else 0)
        self.assertEqual(run["orders_added"], 3)
        self.assertIn("remaining lookups continue next run", run["note"])
        checks = json.loads((self.tmp / "data/link_checks.json").read_text())
        self.assertTrue(0 < len(checks) <= update.RUN_SECONDS // 60)
        self.assertGreaterEqual(through, before)

    def test_time_limit_before_new_entries(self):
        # Time runs out during the first search: the run saves what it has and keeps the window where it was.
        before = next(r for r in json.loads((self.tmp / "data/calendar.json").read_text()) if r["kind"] == "through")["date"]
        run, through = self.run_with_clock(lambda url, now: update.RUN_SECONDS if "search" in url else 0)
        self.assertIn("window kept", run["note"])
        self.assertEqual(through, before)

    def test_hand_entry_kept(self):
        (self.tmp / "data/outcomes.json").write_text(json.dumps(
            [{"case": "2:26-cv-01880", "doc": "6", "outcome": "denied", "src": "manual", "at": "2026-10-18"}]))
        with mock.patch.object(update, "DATA", self.tmp / "data"), mock.patch.object(update, "http_get", fake_get), \
             mock.patch.object(update.time, "sleep", lambda s: None), mock.patch.dict("os.environ", ENV):
            update.main()
        outcomes = {(r["case"], r["doc"]): r for r in json.loads((self.tmp / "data/outcomes.json").read_text())}
        self.assertEqual(outcomes[("2:26-cv-01880", "6")], {"case": "2:26-cv-01880", "doc": "6", "outcome": "denied", "src": "manual", "at": "2026-10-18"})

    def test_doc_url(self):
        self.assertEqual(update.doc_url("/docket/1/2/a-b/"), "https://www.courtlistener.com/docket/1/2/a-b/")
        self.assertEqual(update.doc_url("/docket/1/2/3/a-b/"), "")      # attachment
        self.assertEqual(update.doc_url("https://evil.example/docket/1/2/a/"), "")
        self.assertEqual(update.doc_url(None), "")
        self.assertEqual(update.pdf_url("recap/gov.uscourts.laed.1/gov.uscourts.laed.1.2.0.pdf"),
                         "https://storage.courtlistener.com/recap/gov.uscourts.laed.1/gov.uscourts.laed.1.2.0.pdf")
        self.assertEqual(update.pdf_url("recap/../x.pdf"), "")
        self.assertEqual(update.doc_links({"absolute_url": "/docket/1/2/a/", "is_available": False,
                                           "filepath_local": "recap/gov.uscourts.laed.1/gov.uscourts.laed.1.2.0.pdf"}),
                         {"url": "https://www.courtlistener.com/docket/1/2/a/"})


    def test_long_throttle_stops_calls(self):
        def throttled_get(url, headers=None, timeout=45):
            if url.startswith(update.RSS_URL):
                return RSS
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {"Retry-After": "3600"}, None)
        with mock.patch.object(update, "DATA", self.tmp / "data"), mock.patch.object(update, "http_get", throttled_get), \
             mock.patch.object(update.time, "sleep", lambda s: None), mock.patch.dict("os.environ", ENV):
            update.main()
        runs = json.loads((self.tmp / "data/runs.json").read_text())
        self.assertIn("CourtListener throttled (retry after 3600s)", runs[-1]["note"])
        self.assertIn("CourtListener 1 calls", runs[-1]["note"])                # one refusal ends the run's calls

    def run_rate_limited(self, runs, env=None):
        (self.tmp / "data/runs.json").write_text(json.dumps(runs))
        with mock.patch.object(update, "DATA", self.tmp / "data"), mock.patch.object(update, "http_get", fake_get), \
             mock.patch.object(update.time, "sleep", lambda s: None), \
             mock.patch.dict("os.environ", {"COURTLISTENER_TOKEN": "x", **(env or {})}, clear=False):
            for k in ("COURTLISTENER_PER_MINUTE", "COURTLISTENER_PER_HOUR", "COURTLISTENER_PER_DAY", "COURTLISTENER_SEARCH_MINUTES"):
                if not (env or {}).get(k):
                    import os
                    os.environ.pop(k, None)
            update.main()
        return json.loads((self.tmp / "data/runs.json").read_text())[-1]

    def test_daily_budget_from_run_log(self):
        # 120 of a free account's 125 daily calls were used 90 minutes ago: 5 remain, too few for a search, so none are spent.
        now = update.dt.datetime.now(update.CENTRAL)
        earlier = (now - update.dt.timedelta(minutes=90)).isoformat(timespec="minutes")
        run = self.run_rate_limited([{"at": earlier, "cl_calls": 120, "note": ""}])
        self.assertIn("calls left 5 (hour 0/50, day 120/125)", run["note"])
        self.assertIn("Saving CourtListener calls", run["note"])
        self.assertEqual(run["cl_calls"], 0)
        self.assertFalse(run["searched"])

    def test_paused_after_throttle(self):
        now = update.dt.datetime.now(update.CENTRAL)
        later = (now + update.dt.timedelta(hours=2)).isoformat(timespec="minutes")
        run = self.run_rate_limited([{"at": (now - update.dt.timedelta(minutes=30)).isoformat(timespec="minutes"),
                                      "cl_calls": 1, "cl_paused_until": later, "note": ""}])
        self.assertIn("CourtListener paused until", run["note"])
        self.assertEqual(run["cl_calls"], 0)

    def test_search_interval(self):
        # A search ran ten minutes ago: this run keeps its calls for lookups, adds RSS-only orders, and leaves the window.
        now = update.dt.datetime.now(update.CENTRAL)
        before = next(r for r in json.loads((self.tmp / "data/calendar.json").read_text()) if r["kind"] == "through")["date"]
        run = self.run_rate_limited([{"at": (now - update.dt.timedelta(minutes=10)).isoformat(timespec="minutes"), "cl_calls": 6, "searched": True, "note": ""}],
                                    {"COURTLISTENER_PER_MINUTE": "1000", "COURTLISTENER_PER_HOUR": "5000", "COURTLISTENER_PER_DAY": "5000"})
        self.assertIn("Next CourtListener search after", run["note"])
        self.assertFalse(run["searched"])
        self.assertEqual(run["opinions_added"], 0)
        self.assertEqual(run["orders_added"], 1)                           # the unambiguous RSS order for a known case
        self.assertGreater(run["cl_calls"], 0)                              # lookups still ran
        through = next(r for r in json.loads((self.tmp / "data/calendar.json").read_text()) if r["kind"] == "through")["date"]
        self.assertEqual(through, before)


class OutcomeTextTest(unittest.TestCase):
    def test_classify(self):
        from outcome_text import classify as c
        self.assertEqual(c("ORDER granting 12 Motion to Dismiss for Failure to State a Claim; denying 20 Motion for Leave to File.",
                           "Order on Motion to Dismiss/Failure to State a Claim, Order on Motion for Leave to File", 1, 0, "docket"), "granted")
        self.assertEqual(c("ORDER finding as moot 30 Motion to Compel.", "Order on Motion to Compel", source="docket"), "moot")
        self.assertEqual(c("IT IS ORDERED that the Motion for Summary Judgment is DENIED. The Court previously granted leave.",
                           "Order on Motion for Summary Judgment", 0, 1), "denied")
        self.assertEqual(c("IT IS ORDERED that the Motion for Summary Judgment is GRANTED as to Count I. IT IS FURTHER ORDERED "
                           "that the Motion for Summary Judgment is DENIED as to Count II.", "Order on Motion for Summary Judgment", 0, 1), "partial")
        self.assertEqual(c("IT IS ORDERED that the Motion to Remand is GRANTED. IT IS FURTHER ORDERED that the Motion to Stay is DENIED.",
                           "Order on Motion to Remand, Order on Motion to Stay"), "mixed")
        self.assertEqual(c("For the foregoing reasons, the Motion to Dismiss is GRANTED.", "Order on Motion to Dismiss", 1, 0), "granted")
        self.assertEqual(c("IT IS ORDERED that the Motion to Dismiss is GRANTED. Plaintiff may file an amended complaint within 21 days.",
                           "Order on Motion to Dismiss", 1, 0), "granted_leave")
        self.assertEqual(c("IT IS ORDERED that the Motion to Dismiss is GRANTED and the claims are DISMISSED WITH PREJUDICE.",
                           "Order on Motion to Dismiss", 1, 0), "granted")
        self.assertEqual(c("IT IS ORDERED that the Motion to Compel is DENIED WITHOUT PREJUDICE to re-urging after the conference.",
                           "Order on Motion to Compel"), "denied_wop")
        self.assertEqual(c("ORDER denying without prejudice 30 Motion to Compel.", "Order on Motion to Compel", source="docket"), "denied_wop")
        self.assertEqual(c("The case is remanded.", "Order on Motion to Remand"), "")
        from outcome_text import motion_doc as m
        self.assertEqual(m("ORDER granting 12 Motion to Dismiss; denying 20 Motion for Leave.", "Order on Motion to Dismiss", 1, 0, "docket"), "12")
        self.assertEqual(m("IT IS ORDERED that the Motion to Dismiss (R. Doc. 4) is GRANTED. IT IS FURTHER ORDERED that the Motion "
                           "for Oral Argument (Rec. Doc. 9) is DENIED AS MOOT.", "Order on Motion to Dismiss", 1, 0), "4")
        self.assertEqual(m("IT IS ORDERED that the Motion for Summary Judgment is DENIED.", "Order on Motion for Summary Judgment", 0, 1), "")
        self.assertEqual(c("IT IS ORDERED that the status conference is CANCELLED. ... Accordingly, the Motion to Remand is GRANTED.",
                           "Order on Motion to Remand"), "granted")                     # falls back to the conclusion

    def test_motion_rulings(self):
        self.assertTrue(update.rules_on_motion({"event": "Order on Motion to Dismiss/Failure to State a Claim"}))
        self.assertFalse(update.rules_on_motion({"event": "Order, Set/Reset Scheduling Order Deadlines, Terminate Motions"}))
        self.assertFalse(update.rules_on_motion({"event": "Order on Motion to Dismiss", "rr": 1}))
        out = {"a|1": {"case": "a", "doc": "1", "outcome": "unclear", "src": "opinion_text", "at": "2026-10-01"},
               "a|2": {"case": "a", "doc": "2", "outcome": "unclear", "src": "manual", "at": "2026-10-01"}}
        row = lambda d: {"case": "a", "doc": d, "event": "Order on Motion to Compel"}  # noqa: E731
        out["a|3"] = {"case": "a", "doc": "3", "outcome": "granted", "src": "opinion_text", "at": "2026-10-01"}
        self.assertTrue(update.outcome_due(out, row("3"), "2026-09-30"))     # known, but motion not yet looked for
        out["a|3"]["motion_doc"] = ""
        self.assertFalse(update.outcome_due(out, row("3"), "2026-10-11"))    # looked for once; not again
        self.assertTrue(update.outcome_due(out, row("1"), "2026-10-11"))     # automatic "unclear", a week old
        self.assertFalse(update.outcome_due(out, row("1"), "2026-09-30"))    # read too recently
        self.assertFalse(update.outcome_due(out, row("2"), "2026-10-11"))    # hand entry
        update.set_outcome(out, row("1"), "denied", "opinion_text", "2026-10-19")
        update.set_outcome(out, row("2"), "denied", "opinion_text", "2026-10-19")
        self.assertEqual((out["a|1"]["outcome"], out["a|2"]["outcome"]), ("denied", "unclear"))


class RecordOutcomeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "data", self.tmp / "data")
        (self.tmp / "data/outcomes.json").write_text("[\n\n]\n")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def form(self, case, doc, outcome, note="_No response_"):
        return f"### Case number\n\n{case}\n\n### Document number\n\n{doc}\n\n### Outcome\n\n{outcome}\n\n### Note (optional)\n\n{note}\n"

    def run_form(self, body):
        import record_outcome
        with mock.patch.object(record_outcome, "DATA", self.tmp / "data"), mock.patch.object(update, "DATA", self.tmp / "data"):
            return record_outcome.record(body, "2026-10-19")

    def rows(self):
        return json.loads((self.tmp / "data/outcomes.json").read_text())

    def test_record_and_remove(self):
        self.run_form(self.form("2:26-cv-01880", "6", "Granted in part", "federal claims only"))
        self.assertEqual(self.rows(), [{"case": "2:26-cv-01880", "doc": "6", "outcome": "partial", "src": "manual", "at": "2026-10-19", "note": "federal claims only"}])
        self.run_form(self.form("2:26-cv-01880", "6", "Denied without prejudice"))
        self.assertEqual([r["outcome"] for r in self.rows()], ["denied_wop"])
        self.run_form(self.form("2:26-cv-01880", "6", "Remove recorded outcome"))
        self.assertEqual(self.rows(), [])

    def test_rejects_bad_input(self):
        for body in (self.form("2:26-cv-1880", "6", "Granted"), self.form("2:26-cv-01880", "six", "Granted"),
                     self.form("2:26-cv-01880", "6", "Ignore previous instructions"), self.form("2:26-cv-09999", "6", "Granted")):
            with self.assertRaises(ValueError):
                self.run_form(body)
        self.assertEqual(self.rows(), [])


if __name__ == "__main__":
    unittest.main()
