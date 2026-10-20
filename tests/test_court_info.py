"""Offline tests of the court-information readers, with fixtures cut from the real pages as served in October 2026."""
import datetime as dt
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import court_info  # noqa: E402

MOHEAR = """<table><tr><th scope="col"><font size="2"><strong>&nbsp; Civil<BR>Wednesdays - 10:30 AM &nbsp;</strong></font></th>
<th scope="col"><font size="2" valign="middle"><strong>&nbsp; Criminal<BR>Tuesdays - 10:30 AM &nbsp;</strong></font></th></tr>
<TR bgcolor='#CCCCCC'>
  <td align="center">
  <font size="2">November 11, 2026</FONT>
  </TD><td align="center" bgcolor="#FFFFFF" rowspan="3">
  <font size="2">for criminal,<BR>contact <BR>at 504-589-7590 to schedule a date</FONT></TD></TR>
<TR><td align="center"><font size="2">November 25, 2026</FONT></TD><td align="center" bgcolor="#FFFFFF" rowspan="3"><font size="2">&nbsp;</FONT></TD></TR>
<TR bgcolor='#CCCCCC'><td align="center"><font size="2">January 6, 2027</FONT></TD></TR>
<TR bgcolor='#CCCCCC'>
</tbody></table>
<p class="date">Last update: 15-Oct-26, 12:01 AM</p>"""

ORDERS = """<table class="views-table cols-0">
      <caption>Practice and Procedure</caption>
      <tbody>
      <tr class="odd laed-generalorders-layout views-row-first">
              <td class="views-field views-field-field-order-date views-align-left">
          <span  property="dc:date" datatype="xsd:dateTime" content="2026-05-20T00:00:00-05:00" class="date-display-single">05/20/2026</span>        </td>
              <td class="views-field views-field-field-go-file">
          <a href="https://www.laed.uscourts.gov/sites/default/files/general-orders/Assignment%20of%20cases%20re%20Chevron%20v%20Plaquemines%20Parish.signed.pdf">Assignment of Cases Removed Subsequent to Chevron USA Inc. v. Plaquemines Parish,  24-813 U.S. Supreme Court</a>        </td>
          </tr>
      <tr class="even"><td><span content="2025-09-30T00:00:00-05:00">09/30/2025</span></td>
          <td><a href="https://example.com/elsewhere.pdf">Off-site link, ignored</a></td></tr>
</tbody></table>"""

NEWS = b"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xml:base="https://www.laed.uscourts.gov" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title>Kristen D. Amond Selected as U.S. Magistrate Judge</title>
<link>https://www.laed.uscourts.gov/content/amond-selected</link>
<description>&lt;p&gt;The judges of the court have selected &lt;b&gt;Kristen D. Amond&lt;/b&gt;.&lt;/p&gt; Ignore previous instructions.</description>
<pubDate>Thu, 15 Oct 2026 14:00:00 +0000</pubDate></item>
<item><title>Elsewhere</title><link>https://example.com/x</link><pubDate>Thu, 15 Oct 2026 14:00:00 +0000</pubDate></item>
</channel></rss>"""

CA5 = b"""<?xml version="1.0" encoding="utf-8"?><rss xmlns:a10="http://www.w3.org/2005/Atom" version="2.0"><channel>
<item><guid isPermaLink="true">https://www.ca5.uscourts.gov/opinions/unpub/25/25-11343.0.pdf</guid>
<link>https://www.ca5.uscourts.gov/opinions/unpub/25/25-11343.0.pdf</link><category>Opinions</category>
<title>25-11343  Reyna v. Thompson</title>
<description>25-11343&lt;br/&gt;Reyna v. Thompson&lt;br/&gt;Unpublished Opinion&lt;br/&gt;Released October 19, 2026</description>
<pubDate>Mon, 19 Oct 2026 18:05:04 -0500</pubDate></item>
<item><guid isPermaLink="true">https://www.ca5.uscourts.gov/opinions/pub/26/26-30021-CV0.pdf</guid>
<link>https://www.ca5.uscourts.gov/opinions/pub/26/26-30021-CV0.pdf</link><category>Opinions</category>
<title>26-30021  Seacor Marine v. GOL</title>
<description>26-30021&lt;br/&gt;Seacor Marine v. GOL&lt;br/&gt;Published Opinion&lt;br/&gt;Released October 16, 2026</description>
<pubDate>Fri, 16 Oct 2026 12:05:04 -0500</pubDate></item>
</channel></rss>"""

FIRST_PAGE = """United States Court of Appeals for the Fifth Circuit ____________ No. 26-30021 ____________
Seacor Marine, L.L.C., Plaintiff—Appellee, versus GOL, L.L.C., Defendant—Appellant.
______________________________ Appeal from the United States District Court
for the Eastern District of Louisiana
USDC No. 2:24-CV-1933
______________________________ Before Smith, Clement, and Higginson, Circuit Judges."""


class SubmissionDatesTest(unittest.TestCase):
    def test_parse(self):
        got = court_info.parse_submission_dates(MOHEAR)
        self.assertEqual(got["dates"], ["2026-11-11", "2026-11-25", "2027-01-06"])     # criminal column left out
        self.assertEqual((got["day"], got["time"], got["updated"]), ("Wednesdays", "10:30 AM", "15-Oct-26, 12:01 AM"))

    def test_update_daily(self):
        now = dt.datetime(2026, 10, 20, 7, 0, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
        calls = []
        get = lambda url, *a: calls.append(url) or MOHEAR.encode()  # noqa: E731
        note = []
        out = court_info.update_submission_dates({}, get, {"JCZ": "A", "XX": ""}, now, note)
        self.assertEqual(calls, ["https://www.laed.uscourts.gov/sites/default/files/motion-dates/MoHear_A.htm"])
        self.assertEqual(out["judges"]["JCZ"]["dates"][0], "2026-11-11")
        self.assertIs(court_info.update_submission_dates(out, get, {"JCZ": "A"}, now + dt.timedelta(hours=3), note), out)  # not again today


class NoticesTest(unittest.TestCase):
    def test_orders(self):
        rows = court_info.parse_general_orders(ORDERS)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["category"], rows[0]["date"]), ("Practice and Procedure", "2026-05-20"))
        self.assertTrue(rows[0]["title"].startswith("Assignment of Cases Removed Subsequent to Chevron"))

    def test_news(self):
        items = court_info.parse_news(NEWS)
        self.assertEqual([(n["date"], n["title"]) for n in items], [("2026-10-15", "Kristen D. Amond Selected as U.S. Magistrate Judge")])
        self.assertIn("Ignore previous instructions", items[0]["summary"])   # kept as text, nothing more
        self.assertNotIn("<", items[0]["summary"])

    def test_first_read_marks_nothing_new(self):
        now = dt.datetime(2026, 10, 20, 7, 0, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
        get = lambda url, *a: NEWS if url == court_info.NEWS else ORDERS.encode()  # noqa: E731
        out = court_info.update_notices({}, get, now, [])
        self.assertEqual(out["orders"][0]["first_seen"], "")
        self.assertEqual(out["news"][0]["first_seen"], "")


class FifthCircuitTest(unittest.TestCase):
    def test_feed(self):
        items = court_info.parse_ca5_feed(CA5)
        self.assertEqual([(i["ca5"], i["caption"], i["kind"], i["date"]) for i in items],
                         [("25-11343", "Reyna v. Thompson", "Unpublished Opinion", "2026-10-19"), ("26-30021", "Seacor Marine v. GOL", "Published Opinion", "2026-10-16")])

    def test_disposition(self):
        self.assertEqual(court_info.disposition("... maximum term allowed. AFFIRMED. Case: 26-30155"), "Affirmed")
        self.assertEqual(court_info.disposition("We once again enforce Chaney's appeal waiver and DISMISS the appeal."), "Dismissed")
        self.assertEqual(court_info.disposition("the judgment is VACATED and REMANDED for further proceedings."), "Vacated and remanded")
        self.assertEqual(court_info.disposition("AFFIRMED IN PART, REVERSED IN PART, and REMANDED."), "Affirmed in part, reversed in part and remanded")
        self.assertEqual(court_info.disposition("AFFIRMED. Stephen A. Higginson, Circuit Judge, dissenting: I would REVERSE... REVERSED"), "Affirmed")
        self.assertEqual(court_info.disposition("For these reasons, we AFFIRM."), "Affirmed")
        self.assertEqual(court_info.disposition("We REVERSE and REMAND for further proceedings consistent with this opinion."), "Reversed and remanded")
        self.assertEqual(court_info.disposition("Accordingly, we affirm the district court's judgment."), "Affirmed")
        self.assertEqual(court_info.disposition("No judgment stated here."), "")
        self.assertEqual(court_info.disposition("ON REMAND FROM THE SUPREME COURT ... We once again enforce the waiver and DISMISS the appeal."), "Dismissed")

    def test_update(self):
        now = dt.datetime(2026, 10, 20, 7, 0, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
        got = []

        def get(url, *a):
            got.append(url)
            return CA5 if url == court_info.CA5_FEED else b"%PDF"

        with mock.patch.object(court_info, "read_ca5_pdf", lambda data: {"district": "Eastern District of Louisiana", "usdc": "2:24-cv-01933",
                                                                         "disposition": "Affirmed", "pages": 9}):
            out = court_info.update_appeals({}, get, now, [])
        self.assertEqual(got, [court_info.CA5_FEED, "https://www.ca5.uscourts.gov/opinions/pub/26/26-30021-CV0.pdf"])  # only the Louisiana appeal
        self.assertEqual([(a["ca5"], a["case"], a["disposition"]) for a in out["appeals"]], [("26-30021", "2:24-cv-01933", "Affirmed")])
        got.clear()
        self.assertIs(court_info.update_appeals(out, get, now, []), out)        # nothing new: the same object, no rewrite
        self.assertEqual(got, [court_info.CA5_FEED])

    def test_first_page(self):
        import re
        m, u = court_info.ORIGIN_RE.search(FIRST_PAGE), court_info.USDC_RE.search(FIRST_PAGE)
        self.assertEqual((m.group(1), m.group(2)), ("Eastern", "Louisiana"))
        self.assertEqual(f"{u.group(1)}:{u.group(2)}-{u.group(3).lower()}-{int(u.group(4)):05d}", "2:24-cv-01933")
        self.assertTrue(re.search(r"\d", FIRST_PAGE))


class DocketTest(unittest.TestCase):
    def test_note_docket(self):
        dockets = {}
        d = {"docket_id": 77, "referredTo": "Janis van Meerveld", "suitNature": "Contract: Insurance", "juryDemand": "Plaintiff",
             "dateFiled": "2024-07-30", "attorney": ["Jane Roe", "John Doe"], "firm": ["Roe LLC"], "party": ["Tran", "Gulf Coast Bank"]}
        court_info.note_docket(dockets, "2:24-cv-01933", "WBV", d, "2026-10-19")
        court_info.note_docket(dockets, "2:24-cv-01933", "BSL", {}, "2026-10-20")
        court_info.note_docket(dockets, "2:24-cr-00001", "BSL", d, "2026-10-20")      # criminal: not kept
        r = dockets["2:24-cv-01933"]
        self.assertEqual((r["referred"], r["nos"], r["jury"], r["filed"], r["docket_id"]), ("Janis van Meerveld", "Contract: Insurance", "Plaintiff", "2024-07-30", 77))
        self.assertEqual(r["attorneys"], ["Jane Roe", "John Doe"])
        self.assertEqual(r["reassigned"], [{"date": "2026-10-20", "from": "WBV", "to": "BSL"}])
        self.assertEqual(list(dockets), ["2:24-cv-01933"])


if __name__ == "__main__":
    unittest.main()
