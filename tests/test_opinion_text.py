"""Offline tests of the opinion text store (opinions_text/), its backfill, and the search script."""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import opinion_text  # noqa: E402
import search_opinions  # noqa: E402
import update  # noqa: E402

GOV = "https://www.govinfo.gov/content/pkg/USCOURTS-laed-2_26-cv-01880/pdf/USCOURTS-laed-2_26-cv-01880-0.pdf"
CLS = "https://storage.courtlistener.com/recap/gov.uscourts.laed.900/gov.uscourts.laed.900.9.0.pdf"


def minimal_pdf(lines):
    """A one-page PDF whose text is `lines`."""
    content = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({ln}) Tj T*" for ln in lines) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(content)} >>\nstream\n{content}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n"
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    return (out + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n").encode()


PDFS = {GOV: minimal_pdf(["Case 2:26-cv-01880 Document 6 Filed 10/01/26", "ORDER AND REASONS",
                          "The motion for spoliation sanctions is DENIED. No adverse", "inference instruction will issue."]),
        CLS: b"not a pdf"}


@unittest.skipUnless(__import__("importlib").util.find_spec("pypdf"), "pypdf not installed")
class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = opinion_text.Store(self.tmp / "opinions_text")
        self.rows = [{"date": "2026-10-01", "case": "2:26-cv-01880", "doc": "6", "judge": "BSL", "pdf": GOV, "title": "GEICO v. US",
                      "event": "Order on Motion for Sanctions"},
                     {"date": "2026-10-02", "case": "2:26-cv-00900", "doc": "9", "judge": "EEF", "pdf": CLS},
                     {"date": "2026-10-03", "case": "2:26-cv-00901", "doc": "2", "judge": "EEF"}]  # no PDF: never tried

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def backfill(self, today="2026-10-20"):
        with mock.patch.object(opinion_text.time, "sleep", lambda s: None):
            return self.store.backfill(self.rows, lambda url, *a: PDFS[url], today, time.monotonic() + 60)

    def test_backfill(self):
        stats = self.backfill()
        self.assertEqual((stats["tried"], stats["saved"], stats["empty"], stats["left"]), (2, 1, 1, 1))
        text = (self.tmp / "opinions_text" / "2_26-cv-01880_6.txt").read_text()
        self.assertIn("spoliation sanctions is DENIED", text)
        self.store.write_index()
        index = json.loads((self.tmp / "opinions_text" / "index.json").read_text())
        self.assertEqual(index["2:26-cv-01880|6"]["src"], "govinfo")
        self.assertEqual(index["2:26-cv-00900|9"]["chars"], 0)                    # unreadable: recorded, no file
        self.assertFalse((self.tmp / "opinions_text" / "2_26-cv-00900_9.txt").exists())
        self.assertEqual(self.backfill()["tried"], 0)                             # nothing downloaded twice
        self.assertEqual(self.backfill(today="2026-11-30")["tried"], 1)           # the empty one, after RETRY_DAYS

    def test_save_keeps_first(self):
        self.assertTrue(self.store.save("2:26-cv-01880", "6", "First text.", 1, "courtlistener", "2026-10-20"))
        self.assertFalse(self.store.save("2:26-cv-01880", "6", "Second text.", 1, "govinfo", "2026-10-20"))
        self.assertFalse(self.store.save("not-a-case", "6", "Text.", 1, "govinfo", "2026-10-20"))
        self.assertEqual((self.tmp / "opinions_text" / "2_26-cv-01880_6.txt").read_text(), "First text.\n")

    def test_search(self):
        self.backfill()
        rows = [{**r, "r12": 0, "r56": 0} for r in self.rows]
        out = io.StringIO()
        with mock.patch.object(search_opinions, "DIR", self.tmp / "opinions_text"), \
             mock.patch.object(search_opinions, "load_rows", lambda: [{**r, "outcome": "denied"} for r in rows]), \
             contextlib.redirect_stdout(out):
            search_opinions.main(["adverse inference", "spoliation"])         # a phrase split across lines, plus a word
            search_opinions.main(["spoliation", "--judge", "EEF"])
        text = out.getvalue()
        self.assertIn("2:26-cv-01880 doc 6", text)
        self.assertIn("No adverse inference instruction", text)                  # the snippet joins the PDF's line break
        self.assertIn("-- 1 opinion shown", text)
        self.assertIn("-- 0 opinions shown", text)


class MotionEventTest(unittest.TestCase):
    def test_relief_names(self):
        for e in ["Compel", "Continue", "Leave to File Document", "Extension of Deadlines AND Continue", "Dismiss Case", "Amend/Correct",
                  "Proceed In Forma Pauperis", "Motion to Dismiss", "Ex Parte/Consent Motion for Extension of Deadlines"]:
            self.assertTrue(update.is_motion_event(e), e)
        for e in ["Amended Complaint", "Order on Motion to Dismiss", "Reply to Response to Motion", "Notice of Voluntary Dismissal",
                  "Set Hearings", "Settlement Conference", "Judgment", "Answer to Amended Complaint", "Summons Issued"]:
            self.assertFalse(update.is_motion_event(e), e)


if __name__ == "__main__":
    unittest.main()
