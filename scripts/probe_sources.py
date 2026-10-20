"""Temporary: check Fifth Circuit judgments read from live opinions. Removed before merging."""
import sys
sys.path.insert(0, "scripts")
import court_info, update
items = court_info.parse_ca5_feed(update.http_get(court_info.CA5_FEED))
for it in [i for i in items if i["ca5"][3:5] == "30"]:
    info = court_info.read_ca5_pdf(update.http_get(it["pdf"]))
    print("LA", it["ca5"], it["caption"][:40], "|", info["district"], info["usdc"], "|", info["disposition"] or "(none)")
