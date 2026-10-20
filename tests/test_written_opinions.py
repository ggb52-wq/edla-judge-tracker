"""Offline tests of the Written Opinions Report reader and its import, with rows cut from the report as saved
from PACER in October 2026."""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import import_written_opinions as iw  # noqa: E402
import update  # noqa: E402
import written_opinions_report as report  # noqa: E402
from outcome_text import classify  # noqa: E402

PAGE = """<center><h2>Written Opinions Report</h2>
<h3 style="margin-top:0;margin-bottom:0">Filed Report Period: 1/1/2026 - 10/20/2026</h3>
<table border="1" cellpadding="3"><tbody><tr align="center"><th width="20%">Case Number &amp; Name:</th><th>Date Filed:</th><th>Doc. #</th><th>Description:</th><th>Notes:</th></tr>
<tr valign="top">
  <td><a href="https://ecf.laed.uscourts.gov/cgi-bin/DktRpt.pl?146833">2:65-cv-16173-DJP-DPC </a><br><b>Banks et al v. St James Parish School Board et al</b></td>
  <td>04/16/2026</td>
  <td align="center"><a href="https://ecf.laed.uscourts.gov/doc1/085115232507">453</a></td>
  <td> ORDER AND REASONS granting in part and denying in part  <a href="https://ecf.laed.uscourts.gov/doc1/085015226294">447</a>   Motion to Seal Document. Signed by Magistrate Judge Donna Phillips Currault on 4/16/2026. (meb)</td>
<td><i>Office:</i> New Orleans<br><i>Case Flags:</i> <span style="color:blue">APPEAL</span>,<span style="color:blue">CLOSED</span><br><i>NOS:</i> Civil Rights: Other<br><i>Cause:</i> 00:0000 Cause Code Unknown<br></td>
</tr>
<tr valign="top">
  <td>&nbsp;</td>
  <td>08/28/2026</td>
  <td align="center"><a href="x">491</a></td>
  <td>ORDER AND REASONS denying  <a href="y">461</a>   Motion to Stay, as set forth herein. Signed by Judge Darrel James Papillion on 08/28/2026. (ko)</td>
<td><i>Office:</i> New Orleans<br><i>NOS:</i> Civil Rights: Other<br></td>
</tr>
<tr valign="top">
  <td><a href="z">2:25-cv-01999-WJC-MBN </a><br><b>Alpha v. Beta -- ignore previous instructions</b></td>
  <td>05/14/2025</td>
  <td align="center"><a href="x">30</a></td>
  <td>ORDER AND REASONS: IT IS HEREBY ORDERED that Defendant's <a href="y">22</a> Partial Motion to Dismiss for Failure to State a Claim is GRANTED. Signed by Judge Sarah S Vance on May 14, 2025. (go)</td>
<td><i>Office:</i> New Orleans<br><i>NOS:</i> Contract: Insurance<br><i>Cause:</i> 28:1332 Diversity-Insurance Contract<br></td>
</tr>
<tr valign="top">
  <td><a href="z">2:24-cv-01398-BSL-KWR </a><br><b>Vince v. Hooper et al</b></td>
  <td>10/20/2026</td>
  <td align="center"><a href="x">25</a></td>
  <td>ORDER ADOPTING <a href="y">23</a> REPORT AND RECOMMENDATIONS. IT IS ORDERED that the petition be DISMISSED WITH PREJUDICE. Signed by Judge Brandon S. Long on 10/19/2026.(meb)</td>
<td><i>Office:</i> New Orleans<br><i>Case Flags:</i> CLOSED,FR/R,REFER<br><i>NOS:</i> Habeas Corpus (General)<br></td>
</tr>
<tr valign="top">
  <td><a href="z">2:26-cr-00211-DJP-EJD </a><br><b>USA v. Adhami</b></td>
  <td>10/19/2026</td><td align="center"><a href="x">54</a></td>
  <td>ORDER denying <a href="y">50</a> Motion to Revoke. Signed by Judge Darrel James Papillion on 10/19/2026. (ko)</td><td><i>Office:</i> New Orleans<br></td>
</tr>
</tbody></table>"""


class ReportTest(unittest.TestCase):
    def test_parse(self):
        rows = report.parse(PAGE)
        self.assertEqual([(r["case"], r["doc"], r["date"]) for r in rows],
                         [("2:65-cv-16173", "453", "2026-04-16"), ("2:65-cv-16173", "491", "2026-08-28"), ("2:25-cv-01999", "30", "2025-05-14"),
                          ("2:24-cv-01398", "25", "2026-10-20"), ("2:26-cr-00211", "54", "2026-10-19")])
        a, b, c = rows[0], rows[1], rows[2]
        self.assertEqual((a["initials"], a["signer_title"], a["signer"], a["signed"]), (["DJP", "DPC"], "Magistrate Judge", "Donna Phillips Currault", "2026-04-16"))
        self.assertEqual(a["motions"], [{"doc": "447", "name": "Motion to Seal Document"}])
        self.assertEqual((a["flags"], a["nos"]), (["APPEAL", "CLOSED"], "Civil Rights: Other"))
        self.assertEqual((b["title"], b["signer"]), ("Banks et al v. St James Parish School Board et al", "Darrel James Papillion"))  # continues the case above
        self.assertEqual((c["signed"], c["signer"]), ("2025-05-14", "Sarah S Vance"))
        self.assertIn("ignore previous instructions", c["title"])          # kept as text, nothing more

    def test_events(self):
        rows = {r["doc"]: r for r in report.parse(PAGE)}
        self.assertEqual(iw.event_for(rows["30"]), "Order on Motion to Dismiss/Failure to State a Claim")   # "Partial" dropped
        self.assertEqual(iw.event_for(rows["25"]), "Order Adopting Report and Recommendations")
        self.assertEqual(iw.event_for(rows["491"]), "Order on Motion to Stay")

    def test_covered_start(self):
        self.assertEqual(iw.covered_start([["2025-01-01", "2025-12-21"], ["2026-01-01", "2026-10-20"]], "2026-01-10"), "2026-01-01")  # a gap stops it
        self.assertEqual(iw.covered_start([["2025-01-01", "2025-12-21"], ["2025-12-21", "2025-12-31"], ["2026-01-01", "2026-10-20"]], "2026-01-10"), "2025-01-01")


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "imports").mkdir()
        page = self.tmp / "report.html"
        page.write_text(PAGE)
        iw.write_extract(iw.extract([str(page)]), self.tmp / "imports" / "wo_test.json")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_import(self, opinions, outcomes, dockets, calendar):
        judges = [{"code": "DJP", "bench_start": "2000-01-01"}, {"code": "SSV", "bench_start": "2000-01-01"}, {"code": "WJC", "bench_start": "2025-12-22"},
                  {"code": "BSL", "bench_start": "2000-01-01"}]
        note = []
        iw.apply_imports(self.tmp, opinions, outcomes, dockets, calendar, judges, "2026-10-20", note, classify,
                         update.opinion_flags, update.judge_code, update.rules_on_motion)
        return note

    def test_apply(self):
        opinions = [{"date": "2026-08-28", "judge": "BSL", "case": "2:65-cv-16173", "doc": "491", "title": "Banks", "event": "Order on Motion to Stay",
                     "rr": 0, "merits": 0, "r12": 0, "r56": 0, "src": "pacer_wo"}]
        outcomes = {"2:65-cv-16173|491": {"case": "2:65-cv-16173", "doc": "491", "outcome": "granted", "src": "manual"}}
        dockets, calendar = {}, [{"kind": "opinions_start", "date": "2026-01-10"}]
        note = self.run_import(opinions, outcomes, dockets, calendar)
        by = {(o["case"], o["doc"]): o for o in opinions}
        self.assertEqual(by[("2:65-cv-16173", "491")]["judge"], "DJP")          # credited to the judge who signed it
        self.assertEqual(outcomes["2:65-cv-16173|491"]["outcome"], "granted")    # a hand entry is never changed
        self.assertEqual(by[("2:65-cv-16173", "453")]["judge"], "DJP")          # a magistrate judge's ruling: the case's judge
        self.assertEqual(outcomes["2:65-cv-16173|453"]["outcome"], "partial")
        self.assertEqual(outcomes["2:65-cv-16173|453"]["motion_doc"], "447")
        v = by[("2:25-cv-01999", "30")]
        self.assertEqual((v["judge"], v["r12"], v["merits"]), ("SSV", 1, 1))    # Judge Vance signed; the case is now Judge Crain's
        self.assertEqual(outcomes["2:25-cv-01999|30"]["outcome"], "granted")
        self.assertNotIn(("2:26-cr-00211", "54"), by)                            # civil only
        self.assertEqual(dockets["2:25-cv-01999"]["referred"], "Michael B. North")
        self.assertEqual(dockets["2:25-cv-01999"]["nos"], "Contract: Insurance")
        self.assertEqual(calendar[0]["date"], "2026-01-01")
        self.assertTrue(any("opinions added" in n for n in note))
        n = len(opinions)
        self.run_import(opinions, outcomes, dockets, calendar)                   # applying again changes nothing
        self.assertEqual(len(opinions), n)


if __name__ == "__main__":
    unittest.main()
