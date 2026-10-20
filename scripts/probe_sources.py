"""Temporary: print samples of new data sources so their parsers match the real pages. Removed before merging."""
import io, json, os, re, sys, urllib.request
UA = {"User-Agent": "edla-judge-tracker (github.com/ggb52-wq/edla-judge-tracker)"}
def get(url, headers=None):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()
def show(title, url, n=3000, tail=0):
    print(f"\n===== {title}: {url}")
    try:
        b = get(url); t = b.decode("utf-8", "replace")
        print(f"[{len(b)} bytes]"); print(t[:n])
        if tail: print("..... TAIL ....."); print(t[-tail:])
        return t
    except Exception as e:
        print("ERROR", type(e).__name__, e); return ""
idx = show("MoHear index", "https://www.laed.uscourts.gov/cases/motions/MoHear.htm", 6000)
print("LINKS:", sorted(set(re.findall(r'href=["\']([^"\']+)', idx, re.I)))[:80])
show("MoHear_A", "https://www.laed.uscourts.gov/sites/default/files/motion-dates/MoHear_A.htm", 5000, 1500)
for f in re.findall(r'href=["\']([^"\']*MoHear_[^"\']+)', idx, re.I)[:30]:
    print("FILELINK", f)
mag = [f for f in re.findall(r'href=["\']([^"\']*motion-dates[^"\']+)', idx, re.I) if not re.search(r"MoHear_[A-Z]\.htm", f)]
if mag: show("first other motion-dates file", mag[0] if mag[0].startswith("http") else "https://www.laed.uscourts.gov" + mag[0], 3000)
show("court rss", "https://www.laed.uscourts.gov/rss.xml", 4000)
go = show("general orders", "https://www.laed.uscourts.gov/attorney-information/rules-and-orders/general-orders", 200)
m = re.search(r"<table.*?</table>", go, re.S | re.I)
print("FIRST TABLE:", (m.group(0) if m else "none")[:5000])
print("TABLE COUNT", len(re.findall(r"<table", go, re.I)), "H2/H3:", re.findall(r"<h[23][^>]*>(.*?)</h[23]>", go, re.S)[:20])
feed = show("ca5 feed", "https://www.ca5.uscourts.gov/feeds/opinions", 4000)
items = re.findall(r"<item>(.*?)</item>", feed, re.S)
print("ITEMS", len(items))
for it in items[:40]:
    t = re.search(r"<title>(.*?)</title>", it, re.S); l = re.search(r"<link>(.*?)</link>", it, re.S)
    print("ITEM", (t.group(1) if t else "").strip()[:90], "|", (l.group(1) if l else "").strip())
la = [re.search(r"<link>(.*?)</link>", it, re.S).group(1).strip() for it in items if re.search(r"<title>\s*\d\d-30", it)]
from pypdf import PdfReader
for u in la[:4]:
    try:
        r = PdfReader(io.BytesIO(get(u))); tx = (r.pages[0].extract_text() or "")
        print(f"\n===== PDF {u} pages={len(r.pages)}\n{tx[:1500]}")
        last = r.pages[-1].extract_text() or ""; print("..... LAST PAGE TAIL\n", last[-700:])
    except Exception as e:
        print("PDF ERROR", u, e)
tok = os.environ.get("COURTLISTENER_TOKEN")
if tok:
    print("\n===== CourtListener search type=r sample (1 call)")
    try:
        d = json.loads(get("https://www.courtlistener.com/api/rest/v4/search/?type=r&court=laed&q=docketNumber%3A%2224-cv-01933%22",
                           {"Authorization": f"Token {tok}"}))
        r0 = (d.get("results") or [{}])[0]
        print(json.dumps({k: (v if not isinstance(v, (list, dict)) else f"<{type(v).__name__} {len(v)}>") for k, v in r0.items()}, indent=1)[:4000])
    except Exception as e:
        print("CL ERROR", e)
