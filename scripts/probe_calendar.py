"""Temporary probe: prints the court's calendar page and the pages it links to, as outlines and link lists."""
import re
import sys
import urllib.parse
sys.path.insert(0, "scripts")
import judge_pages as jp  # noqa: E402


def show(url, limit=8000):
    try:
        html = jp.fetch(url)
    except Exception as e:  # noqa: BLE001
        print("ERR", url, e)
        return None
    print(f"\n===== {url} ({len(html)} bytes)")
    print(jp.outline(html)[:limit])
    return html


html = show("https://www.laed.uscourts.gov/court-calendar", 12000)
if html:
    root = jp.parse(html)
    links = []
    for a in root.find_all(lambda n: n.tag == "a"):
        h = a.attrs.get("href", "")
        t = jp.clean(a.text())
        if re.search(r"calendar|docket|hearing|trial|cal|judge", h + " " + t, re.I):
            links.append((t, urllib.parse.urljoin("https://www.laed.uscourts.gov/court-calendar", h)))
    print("\nLINKS:")
    for t, u in links:
        print("  ", repr(t[:80]), "->", u)
    seen = set()
    for t, u in links:
        if u in seen or "court-calendar" in u and u.rstrip("/").endswith("court-calendar"):
            continue
        seen.add(u)
        if len(seen) > 4:
            break
        if re.search(r"calendar|cal", u, re.I) and not u.endswith(".pdf"):
            show(u, 6000)
