"""Temporary: run the court-information readers against the live sites and print what they find. Removed before merging."""
import datetime as dt, json, sys
from zoneinfo import ZoneInfo
sys.path.insert(0, "scripts")
import court_info, update
now = dt.datetime.now(ZoneInfo("America/Chicago"))
jp = json.load(open("data/judge_pages.json"))
sections = {j["code"]: (j.get("contact") or {}).get("section", "") for j in jp["judges"]}
note = []
sd = court_info.update_submission_dates({}, update.http_get, sections, now, note)
for code, r in sorted(sd["judges"].items()):
    print("SUBMIT", code, r["section"], r["day"], r["time"], len(r["dates"]), r["dates"][:3], r["dates"][-1:], r["updated"])
print("MISSING sections:", sorted(set(sections) - set(sd["judges"])))
nt = court_info.update_notices({}, update.http_get, now, note)
for n in nt["news"][:6]: print("NEWS", n["date"], n["title"][:80], "|", n["summary"][:100])
print("NEWS total", len(nt["news"]))
for o in nt["orders"][:8]: print("ORDER", o["date"], o["category"], "|", o["title"][:90])
print("ORDERS total", len(nt["orders"]), sorted({o["category"] for o in nt["orders"]}))
court_info.CA5_PDF_BUDGET = 40
ap = court_info.update_appeals({}, update.http_get, now, note)
print("SEEN", len(ap["seen"]))
for a in ap["appeals"]: print("APPEAL", a)
import io
from pypdf import PdfReader
items = court_info.parse_ca5_feed(update.http_get(court_info.CA5_FEED))
for it in [i for i in items if i["ca5"][3:5] == "30"][:12]:
    info = court_info.read_ca5_pdf(update.http_get(it["pdf"]))
    print("LA", it["ca5"], it["caption"][:40], "|", info)
print("NOTE", note)
