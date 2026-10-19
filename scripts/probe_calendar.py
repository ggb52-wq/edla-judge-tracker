"""Temporary probe: finds what the court calendar page's frames load, and prints those pages."""
import re
import sys
import urllib.parse
sys.path.insert(0, "scripts")
import judge_pages as jp  # noqa: E402

BASE = "https://www.laed.uscourts.gov/court-calendar"
html = jp.fetch(BASE)
i = html.find('id="main-content"')
body = html[i:i + 6000]
print("BODY HTML:\n", re.sub(r"\s+", " ", body)[:5000])
srcs = re.findall(r'<iframe[^>]*\ssrc="([^"]*)"', html, re.I) + re.findall(r'\bsrc\s*[:=]\s*["\']([^"\']+)["\']', html)
print("\nSRC candidates:", srcs)
for s in re.findall(r"<script[^>]*>(.*?)</script>", html, re.S | re.I):
    if re.search(r"iframe|calendar|adjust", s, re.I):
        print("\nSCRIPT:\n", s.strip()[:3000])
for js in re.findall(r'<script[^>]*src="([^"]*)"', html):
    if re.search(r"calendar|adjust|iframe|custom", js, re.I):
        u = urllib.parse.urljoin(BASE, js)
        try:
            print("\nJS FILE", u, "\n", jp.fetch(u)[:3000])
        except Exception as e:  # noqa: BLE001
            print("ERR", u, e)
seen = set()
for s in srcs:
    u = urllib.parse.urljoin(BASE, s)
    if u in seen or not u.startswith("http") or re.search(r"\.(js|css|png|jpg|gif|svg)(\?|$)", u):
        continue
    seen.add(u)
    try:
        page = jp.fetch(u)
    except Exception as e:  # noqa: BLE001
        print("ERR", u, e)
        continue
    print(f"\n===== FRAME {u} ({len(page)} bytes)")
    print(re.sub(r"\s+", " ", page)[:6000])
