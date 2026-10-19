"""Temporary probe: prints the court's judge index and two judge pages, reduced to tags, links, and text."""
import re
import urllib.request

UA = "edla-judge-tracker probe (github.com/ggb52-wq/edla-judge-tracker)"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        print(f"== {url} -> {r.status} {r.headers.get('Content-Type')} final={r.geturl()}")
        return r.read().decode("utf-8", "replace")


def reduce(html):
    html = re.sub(r"(?is)<(script|style|svg|noscript)\b.*?</\1>", "", html)
    html = re.sub(r"(?s)<!--.*?-->", "", html)
    html = re.sub(r"\s+", " ", html)
    # keep tag names with id/class/href, drop other attributes
    def tag(m):
        name, attrs = m.group(1), m.group(2) or ""
        keep = " ".join(re.findall(r'\b(?:id|class|href)="[^"]*"', attrs))
        return f"<{name}{(' ' + keep) if keep else ''}>"
    return re.sub(r"<(/?[a-zA-Z0-9]+)([^>]*)>", tag, html)


idx = get("https://www.laed.uscourts.gov/judges-information")
links = sorted(set(re.findall(r'href="([^"]*judges-information/judge[^"]*)"', idx)))
print("JUDGE LINKS", len(links))
for l in links:
    print("  ", l)
body = reduce(idx)
i = body.find("<main")
print("INDEX MAIN:", body[i if i >= 0 else 0:][:6000])
for slug in ["honorable-nannette-jolivette-brown", "honorable-lance-m-africk"]:
    url = "https://www.laed.uscourts.gov/judges-information/judge/" + slug
    try:
        page = reduce(get(url))
    except Exception as e:  # noqa: BLE001
        print("ERR", url, e)
        continue
    i = page.find("<main")
    print("PAGE MAIN:", page[i if i >= 0 else 0:][:20000])
