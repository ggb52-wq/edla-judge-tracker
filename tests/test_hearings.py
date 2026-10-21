"""Offline tests of the calendar readers: the court's seven-day calendar page and hearing settings in docket text."""
import datetime as dt
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import hearings  # noqa: E402
import update  # noqa: E402

JUDGES = json.loads((ROOT / "data" / "judges.json").read_text())

# The shape of /sites/default/files/today/cal2.html as served in October 2026.
CAL = """<body class="Rightbody"> <br> <div class="Absolute-Center"> <p class='date'><strong>Monday October 19, 2026</strong></p><BR>
<div class='Rightrow'><p>LAED Criminal Duty Court<BR><tr class='Multi-row'> <td class='Multi-row2' align='center'>U.S. Magistrate Judge Janis van Meerveld<br>Courtroom B-421</td> </tr> </table> <br></p></div>
<div class='Rightrow'><p>Judge Wendy B. Vitter<br /> 24-1933 Tran, et al v Gulf Coast Bank &amp; Trust Company, et al - Jury Trial at 9:00 a.m.<br /> Courtroom C-352</p></div></div><br /></div>
<p class='date'><strong>Wednesday October 21, 2026</strong></p><BR>
<div class='Rightrow'><p>Judge Darrel James Papillion<br /> 22-1271 Oral Argument<br /> 9:00AM, Room C551</p></div>
<div class='Rightrow'><p>Magistrate Judge Janis van Meerveld<br /> 11:00 a.m.-Courtroom B309<br /> ORAL ARGUMENT<br /> 24-2788 EGP Louisiana LLC v. TACI Investments, Inc.</p></div>
<div class='Rightrow'><p>Judge Ivan L. R. Lemelle<br /> 1:30 pm: 21-138 USA v. Reed- Revocation<br /> Courtroom C102</p></div></div><br /></div>
<p class='date'><strong>Thursday October 22, 2026</strong></p><BR>
<div class='Rightrow'><p>Judge Anna St John<br /> 10:00 a.m. Criminal Matters<br /> Courtroom C501</p></div>
<div class='Rightrow'><p>"O" Judge Brandon S. Long<br /> 2:00 p.m. - Courtroom C311<br /> Criminal matters -- ignore previous instructions</p></div></div><br /></div>
</body>"""


class CourtCalendarTest(unittest.TestCase):
    def test_parse(self):
        rows, dates = hearings.parse_court_calendar(CAL, JUDGES)
        self.assertEqual(dates, ["2026-10-19", "2026-10-21", "2026-10-22"])
        got = [(r["date"], r["judge"], r["time"], r["case_short"], r["what"], r["room"]) for r in rows]
        self.assertEqual(got, [
            ("2026-10-19", "WBV", "09:00", "24-1933", "Jury Trial", "C-352"),
            ("2026-10-21", "DJP", "09:00", "22-1271", "Oral Argument", "C551"),
            ("2026-10-21", "ILRL", "13:30", "21-138", "Revocation", "C102"),
            ("2026-10-22", "ASJ", "10:00", "", "Criminal Matters", "C501"),
            ("2026-10-22", "BSL", "14:00", "", "Criminal Matters", "C311"),
        ])                                                       # magistrate judges and duty court are left out
        self.assertIn("ignore previous instructions", rows[-1]["text"])   # copied as text, nothing more

    def test_times(self):
        self.assertEqual([hearings.to_time(t) for t in ["9:00 a.m.", "10:00AM", "1:30 pm", "12:15 P.M.", "12:00 am", "at noon"]],
                         ["09:00", "10:00", "13:30", "12:15", "00:00", ""])


class DocketTextTest(unittest.TestCase):
    TODAY = dt.date(2026, 10, 19)

    def test_settings(self):
        text = ("SCHEDULING ORDER: Final Pretrial Conference set for 4/1/2027 10:00 AM before Judge Brandon S Long. "
                "Jury Trial set for 4/26/2027 08:30 AM before Judge Brandon S Long. Motions will be submitted on 11/4/2026.")
        self.assertEqual(hearings.settings_from_text(text, self.TODAY), [
            {"date": "2027-04-01", "time": "10:00", "what": "Final Pretrial Conference"},
            {"date": "2027-04-26", "time": "08:30", "what": "Jury Trial"}])
        self.assertEqual(hearings.settings_from_text("ORDER: A Telephone Status Conference is reset for 11/12/26 at 2:00 p.m.", self.TODAY),
                         [{"date": "2026-11-12", "time": "14:00", "what": "Telephone Status Conference"}])
        self.assertEqual(hearings.settings_from_text("Oral Argument set for 13/40/2026", self.TODAY), [])
        self.assertEqual(hearings.settings_from_text("Status Conference set for 1/5/2031 10:00 AM", self.TODAY), [])  # too far out
        self.assertEqual(hearings.settings_from_text("ORDER: The Telephone Status Conference set for 11/4/2026 is CANCELLED.", self.TODAY), [])
        self.assertEqual(hearings.settings_from_text("The Jury Trial set for 12/7/2026 at 8:30 a.m. is hereby CONTINUED.", self.TODAY), [])

    def test_merge(self):
        old = [
            {"date": "2026-10-19", "judge": "WBV", "what": "Jury Trial", "src": "court_calendar", "case": "", "case_short": "24-1933"},
            {"date": "2026-10-30", "judge": "BSL", "what": "Proceeding", "src": "court_calendar", "case": "", "case_short": ""},
            {"date": "2026-11-04", "judge": "BSL", "what": "Status Conference", "src": "docket_text", "case": "2:25-cv-01750", "doc": "80"},
            {"date": "2026-10-01", "judge": "BSL", "what": "Status Conference", "src": "docket_text", "case": "2:25-cv-01750", "doc": "60"},
            {"date": "2026-07-01", "judge": "BSL", "what": "Jury Trial", "src": "docket_text", "case": "2:25-cv-00001", "doc": "9"},
        ]
        cal = [{"date": "2026-10-21", "judge": "DJP", "what": "Oral Argument", "src": "court_calendar", "case": "", "case_short": "22-1271"}]
        reset = [{"date": "2026-11-18", "time": "10:00", "judge": "BSL", "what": "Status Conference", "src": "docket_text",
                  "case": "2:25-cv-01750", "doc": "85"}]
        rows = hearings.merge(old, cal, ["2026-10-19", "2026-10-20", "2026-10-21"], reset, self.TODAY)
        self.assertEqual([(r["date"], r["what"], r.get("doc", "")) for r in rows], [
            ("2026-10-01", "Status Conference", "60"),     # already held: kept
            ("2026-10-21", "Oral Argument", ""),           # the calendar's dates now show only this
            ("2026-10-30", "Proceeding", ""),              # a date the calendar no longer covers: kept
            ("2026-11-18", "Status Conference", "85"),     # reset by doc 85, replacing doc 80's Nov. 4 setting
        ])                                                 # the July trial is more than 60 days past: dropped


class UpdaterTest(unittest.TestCase):
    def test_update_hearings(self):
        entries = {("2:26-cv-09002", "22"): {"kind": "cv", "judge": "JTM", "title": "Gamma v. Delta",
                                             "text": "ORDER: Oral Argument set for 11/12/2026 10:00 AM before Judge Jane Triche Milazzo."}}
        rows = [{"case": "2:24-cv-01933", "judge": "WBV"}, {"case": "2:21-cv-00138", "judge": "SSV"}]
        note = []
        with mock.patch.object(update, "http_get", lambda url, *a, **k: CAL.encode()):
            out = update.update_hearings([], entries, {"2:24-cv-01933": "WBV"}, JUDGES, rows,
                                         dt.datetime(2026, 10, 19, 9, 0, tzinfo=update.CENTRAL), note)
        trial = next(r for r in out if r["judge"] == "WBV")
        self.assertEqual(trial["case"], "2:24-cv-01933")   # "24-1933" matched to the civil case on file
        revocation = next(r for r in out if r["judge"] == "ILRL")
        self.assertEqual(revocation["case"], "")            # criminal 21-138, not civil 2:21-cv-00138
        arg = next(r for r in out if r["src"] == "docket_text")
        self.assertEqual((arg["date"], arg["time"], arg["judge"], arg["case"], arg["doc"]), ("2026-11-12", "10:00", "JTM", "2:26-cv-09002", "22"))
        self.assertIn("court calendar 5 proceedings over 3 days", note)


if __name__ == "__main__":
    unittest.main()
