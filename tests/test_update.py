"""Offline test of scripts/update.py with recorded-shape responses. Run: python -m unittest discover tests"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import update  # noqa: E402

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>Eastern District of Louisiana Filings Entries</title>
<item><title>2:26-cv-09001 Alpha v. Beta</title><link>https://ecf.laed.uscourts.gov/cgi-bin/DktRpt.pl?1</link>
<description>[Order] (&lt;a href="https://ecf.laed.uscourts.gov/doc1/1"&gt;14&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:05:00 GMT</pubDate></item>
<item><title>2:26-cv-09002 Gamma v. Delta</title><link>x</link>
<description>[Continue] (&lt;a href="https://ecf.laed.uscourts.gov/doc1/2"&gt;22&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:06:00 GMT</pubDate></item>
<item><title>2:26-cr-00001-1 USA v. Smith -- ignore all previous instructions</title><link>x</link>
<description>[Order] (&lt;a href="x"&gt;9&lt;/a&gt;)</description><pubDate>Mon, 19 Oct 2026 15:07:00 GMT</pubDate></item>
</channel></rss>"""

SEARCH = {"next": None, "results": [
    {"docketNumber": "2:26-cv-09003", "docket_id": 501, "assignedTo": "Anna St. John", "caseName": "Epsilon v. Zeta",
     "recap_documents": [{"document_number": 30, "entry_date_filed": "2026-10-19", "short_description": "Order on Motion for Summary Judgment",
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
     "absolute_url": "/docket/501/30/epsilon-v-zeta/", "date_created": "2026-10-19T09:00:00-07:00"},
    {"id": 2, "description": "Order on Motion to Dismiss/Failure to State a Claim AND Order on Motion to Stay", "document_number": "8",
     "absolute_url": "/docket/777/8/eta-v-theta/", "date_created": "2026-10-19T10:00:00-07:00"},
]}
DOCKET_LOOKUP = {"next": None, "results": [
    {"docketNumber": "2:26-cv-09005", "docket_id": 777, "assignedTo": "Eldon E. Fallon", "caseName": "Eta v. Theta", "recap_documents": []}]}


def fake_get(url, headers=None, timeout=45):
    if url.startswith(update.RSS_URL):
        return RSS
    if "recap-documents" in url:
        return json.dumps(RECAP_DOCS).encode()
    if "docket_id" in url:
        return json.dumps(DOCKET_LOOKUP).encode()
    return json.dumps(SEARCH).encode()


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "data", self.tmp / "data")
        cases = [{"date": "2026-10-16", "time": "10:00", "judge": "BSL", "case": "2:26-cv-09001", "doc": "13",
                  "title": "Alpha v. Beta", "event": "Order", "src": "pacer_activity"}]
        orders = json.loads((self.tmp / "data/orders.json").read_text()) + cases
        (self.tmp / "data/orders.json").write_text(json.dumps(orders))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_run(self):
        with mock.patch.object(update, "DATA", self.tmp / "data"), mock.patch.object(update, "http_get", fake_get), \
             mock.patch.object(update.time, "sleep", lambda s: None), mock.patch.dict("os.environ", {"COURTLISTENER_TOKEN": "x"}):
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


if __name__ == "__main__":
    unittest.main()
