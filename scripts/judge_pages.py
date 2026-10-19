"""Each district judge's page on the court's website: section, chambers contact, the judge's practice requirements
(the page's tabs, such as "Chambers Communication", "Courtroom Rules", "Motions & Oral Argument"), and the standing
orders and forms the page links to. Writes data/judge_pages.json; run daily by .github/workflows/judge_pages.yml.

Page text is copied as data, never interpreted or followed. Staff names are not kept. Each run compares what it read
with the last copy: a section whose text changed gets a new "changed" date, and a document link not seen before gets
a "first_seen" date, so the site can flag what is new.

Run: python scripts/judge_pages.py [--print]   (--print writes the result to stdout instead of the data file)
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = "https://www.laed.uscourts.gov"
LISTING = BASE + "/judges-information/district-judges"
JUDGE_PATH = "/judges-information/judge/"
USER_AGENT = "edla-judge-tracker (github.com/ggb52-wq/edla-judge-tracker)"
PAUSE = 1.0                 # seconds between page requests
DEBUG = bool(__import__("os").environ.get("JUDGE_PAGES_DEBUG"))
DOC_RE = re.compile(r"/sites/default/files/|\.(pdf|docx?|wpd|rtf|xlsx?)(\?|#|$)", re.I)
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
BLOCK = {"p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "blockquote", "fieldset", "section", "article"}


# ------------------------------------------------------------------ a small DOM from html.parser
class Node:
    __slots__ = ("tag", "attrs", "kids", "parent")

    def __init__(self, tag: str, attrs: dict, parent: "Node | None"):
        self.tag, self.attrs, self.kids, self.parent = tag, attrs, [], parent

    def cls(self) -> str:
        return self.attrs.get("class") or ""

    def walk(self):
        yield self
        for k in self.kids:
            if isinstance(k, Node):
                yield from k.walk()

    def find_all(self, pred):
        return [n for n in self.walk() if pred(n)]

    def find(self, pred):
        return next((n for n in self.walk() if pred(n)), None)

    def text(self) -> str:
        out = []
        for k in self.kids:
            if isinstance(k, str):
                out.append(k)
            elif k.tag == "br":
                out.append("\n")
            elif k.tag not in ("script", "style"):
                out.append(k.text())
        return "".join(out)


class Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {}, None)
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        a = {}
        for k, v in attrs:
            if k == "class" and "class" in a:   # the court's pages repeat class attributes
                a[k] = a[k] + " " + (v or "")
            elif k not in a:
                a[k] = v or ""
        node = Node(tag, a, self.cur)
        self.cur.kids.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.cur = self.cur.parent

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.kids.append(data)


def parse(html: str) -> Node:
    b = Builder()
    b.feed(html)
    b.close()
    return b.root


# ------------------------------------------------------------------ helpers
def clean(s: str) -> str:
    return re.sub(r"[ \t\r\f\v ]+", " ", s).replace(" \n", "\n").replace("\n ", "\n").strip()


def absolute(href: str) -> str:
    href = (href or "").strip()
    if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
        return ""
    url = urllib.parse.urljoin(BASE + "/", href)
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https"):
        return ""
    return urllib.parse.urlunsplit((p.scheme, p.netloc, urllib.parse.quote(urllib.parse.unquote(p.path), safe="/%:@-._~!$&'()*+,;="), p.query, ""))


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def has_class(n: Node, *names: str) -> bool:
    c = n.cls().split()
    return any(x in c for x in names)


# ------------------------------------------------------------------ content blocks
def inline(node: Node, out: list) -> None:
    """Text and links inside one block, as segments: plain strings and [text, url] pairs."""
    for k in node.kids:
        if isinstance(k, str):
            out.append(k)
        elif k.tag == "br":
            out.append("\n")
        elif k.tag == "a":
            text = clean(k.text())
            url = absolute(k.attrs.get("href", ""))
            mail = (k.attrs.get("href") or "").strip()
            if url and text:
                out.append([text, url])
            elif mail.startswith("mailto:") and text:
                out.append([text, mail.split("?")[0]])
            else:
                out.append(k.text())
        elif k.tag in ("script", "style", "img"):
            continue
        elif k.tag in BLOCK:
            continue        # nested blocks are emitted as their own blocks
        else:
            inline(k, out)


def tidy(segs: list) -> list:
    """Merge neighboring strings, collapse spaces, and drop empty pieces."""
    out: list = []
    for s in segs:
        if isinstance(s, str):
            if out and isinstance(out[-1], str):
                out[-1] += s
            else:
                out.append(s)
        else:
            out.append(s)
    res = []
    for i, s in enumerate(out):
        if isinstance(s, str):
            t = re.sub(r"[ \t\r\f\v ]+", " ", s)
            t = re.sub(r" *\n+ *", "\n", t)
            if i == 0:
                t = t.lstrip()
            if i == len(out) - 1:
                t = t.rstrip()
            if t:
                res.append(t)
        else:
            res.append(s)
    return res


def blocks(node: Node, depth: int = 0) -> list[dict]:
    """Paragraphs, headings, and list items in reading order. Each block: {"k": "p"|"h"|"li", "d": depth, "s": segments}."""
    out: list[dict] = []

    def emit(kind: str, n: Node, d: int) -> None:
        segs: list = []
        inline(n, segs)
        segs = tidy(segs)
        if segs:
            if kind == "p" and len(segs) == 1 and isinstance(segs[0], str) and is_heading(n):
                kind = "h"
            out.append({"k": kind, "d": d, "s": segs})

    def visit(n: Node, d: int, inline_done: bool = False) -> None:
        """inline_done: the node's own text was already emitted (a <p> or <li>); only its nested blocks remain."""
        run: list = []

        def flush() -> None:
            if run:
                wrap = Node("div", {}, None)
                wrap.kids = list(run)
                run.clear()
                emit("p", wrap, d)

        for k in n.kids:
            if isinstance(k, str) or k.tag not in BLOCK and k.tag not in ("script", "style", "legend"):
                if not inline_done:
                    run.append(k)
                continue
            flush()
            if k.tag in ("script", "style", "legend"):
                continue
            if k.tag in ("ul", "ol"):
                visit(k, d + (1 if n.tag == "li" else 0))
            elif k.tag == "li":
                emit("li", k, d)
                visit(k, d, True)
            elif k.tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                emit("h", k, d)
            elif k.tag == "p":
                emit("p", k, d)
                visit(k, d, True)
            else:
                visit(k, d)
        flush()

    visit(node, depth)
    return [b for b in out if b["s"]]


def is_heading(n: Node) -> bool:
    """A paragraph whose only content is bold text reads as a subheading."""
    kids = [k for k in n.kids if not (isinstance(k, str) and not k.strip()) and not (isinstance(k, Node) and k.tag == "br")]
    return len(kids) == 1 and isinstance(kids[0], Node) and kids[0].tag in ("strong", "b") and len(clean(kids[0].text())) <= 90


# ------------------------------------------------------------------ one judge page
def read_page(html: str, url: str) -> dict:
    root = parse(html)
    h1 = root.find(lambda n: n.tag == "h1" and n.attrs.get("id") == "page-title")
    title = clean(h1.text()) if h1 else ""
    node = root.find(lambda n: n.tag == "div" and has_class(n, "node--judge")) or root.find(lambda n: n.attrs.get("id") == "main-content") or root
    body = node.find(lambda n: has_class(n, "field--name-body"))
    info = clean(body.text()) if body else ""
    contact: dict = {}
    m = re.search(r"\bSection\s+([A-Z]{1,2})\b", info)
    if m:
        contact["section"] = m.group(1)
    m = re.search(r"\(?\d{3}\)?[\s.-]*\d{3}[\s.-]\d{4}", info)
    if m:
        contact["phone"] = m.group(0)
    mails = re.findall(r"mailto:([^\"'?\s>]+)", html_of(body)) if body else []
    if mails:
        contact["email"] = mails[0]
    m = re.search(r"\bRoom\s+([A-Z]?-?\d{2,4}[A-Z]?)\b", info)
    if m:
        contact["room"] = m.group(1)
    fjc = body.find(lambda n: n.tag == "a" and "fjc.gov" in (n.attrs.get("href") or "")) if body else None
    if fjc:
        contact["bio"] = absolute(fjc.attrs.get("href", ""))

    sections = []
    for fs in node.find_all(lambda n: n.tag == "fieldset" and has_class(n, "field-group-htab", "field-group-fieldset", "collapsible")):
        legend = fs.find(lambda n: n.tag == "legend")
        name = clean(legend.text()) if legend else ""
        wrap = fs.find(lambda n: has_class(n, "fieldset-wrapper")) or fs
        bl = blocks(wrap)
        if name and bl:
            sections.append({"title": name, "blocks": bl})
    if not sections:
        # Pages without tabs: everything in the judge node after the contact block and the staff list.
        rest = [k for k in node.kids if isinstance(k, Node)]
        bl = []
        for k in rest:
            for n in k.walk():
                if has_class(n, "field--name-body", "staff-info-wrap", "group-staff-info"):
                    break
            else:
                bl.extend(blocks(k))
        if bl:
            sections.append({"title": "Requirements", "blocks": bl})

    docs = []
    seen = set()
    for sec in sections:
        for b in sec["blocks"]:
            for s in b["s"]:
                if isinstance(s, list) and DOC_RE.search(s[1]) and "/css/" not in s[1] and s[1] not in seen:
                    seen.add(s[1])
                    docs.append({"title": s[0], "url": s[1], "section": sec["title"]})
    return {"url": url, "title": title, "contact": contact, "sections": sections, "docs": docs}


def outline(html: str) -> str:
    """The page from its title on, as tags with ids and classes plus short text, for the log when a page reads oddly."""
    root = parse(html)
    start = root.find(lambda n: n.attrs.get("id") == "page-title") or root
    node = start.parent if start.parent is not None else root
    out = []

    def go(n: Node, d: int) -> None:
        for k in n.kids:
            if isinstance(k, str):
                t = clean(k)
                if t:
                    out.append("  " * d + repr(t[:80]))
            elif k.tag not in ("script", "style", "svg", "nav", "form", "footer"):
                attrs = " ".join(f'{a}="{k.attrs[a][:60]}"' for a in ("id", "class", "href") if k.attrs.get(a))
                out.append("  " * d + f"<{k.tag}{(' ' + attrs) if attrs else ''}>")
                go(k, d + 1)
    go(node, 0)
    return "\n".join(out)


def html_of(node: Node) -> str:
    """Attributes back out of a node, enough to find mailto: links."""
    return " ".join(f'{k}="{v}"' for n in node.walk() for k, v in n.attrs.items())


# ------------------------------------------------------------------ the run
def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace")


def find_pages(listing_html: str, judges: list[dict]) -> dict:
    """Map judge code -> {"urls": addresses to try, "section": letter}. A link matches a judge when its address ends
    with the judge's name ("...honorable-nannette-jolivette-brown") or, failing that, when its text names the judge.
    The listing links each judge twice, once by section letter ("G") and once by name; the letter is kept. Its links
    use /judge/<name>, which the court's site does not always serve, so /judges-information/judge/<name> is tried first."""
    root = parse(listing_html)
    start = root.find(lambda n: n.attrs.get("id") in ("main-content", "page-title"))
    scope = start.parent if start is not None and start.parent is not None else root
    links = []
    for a in scope.find_all(lambda n: n.tag == "a"):
        url = absolute(a.attrs.get("href", ""))
        if url.startswith(BASE) and not DOC_RE.search(url):
            links.append((url, clean(a.text())))
    letters = {u: t for u, t in links if re.fullmatch(r"[A-Z]{1,2}", t)}
    out = {}
    for j in judges:
        s = slug(j["name"])
        by_url = sorted({u for u, _ in links if u.rstrip("/").split("/")[-1] == s or u.rstrip("/").endswith("-" + s)})
        by_text = sorted({u for u, t in links if re.search(r"(?<![\w.])" + re.escape(j["name"]) + r"(?![\w])", t, re.I)})
        hit = (by_url or by_text)[:1]
        if hit:
            last = hit[0].rstrip("/").split("/")[-1]
            urls = [BASE + JUDGE_PATH + last] + [u for u in hit if u != BASE + JUDGE_PATH + last]
            out[j["code"]] = {"urls": urls, "section": letters.get(hit[0], "")}
    if len(out) < len(judges) or DEBUG:
        print(f"Matched {len(out)} of {len(judges)} judges on the listing. Links seen:", flush=True)
        for u, t in links[:120]:
            print(f"  {t[:60]!r} -> {u}", flush=True)
    return out


def digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def merge(prev: dict | None, cur: dict, today: str) -> dict:
    """Carry forward first-seen dates for documents and changed dates for sections. On a judge's first read nothing
    is marked changed; a document's first_seen is that day, which the site treats as "already there"."""
    prev = prev or {}
    pdocs = {d["url"]: d for d in prev.get("docs", [])}
    for d in cur["docs"]:
        d["first_seen"] = pdocs.get(d["url"], {}).get("first_seen", today)
    psec = {s["title"]: s for s in prev.get("sections", [])}
    for s in cur["sections"]:
        s["hash"] = digest(s["blocks"])
        old = psec.get(s["title"])
        s["changed"] = (today if prev else "") if old is None else old.get("changed", "") if old.get("hash") == s["hash"] else today
    cur["hash"] = digest([cur["contact"], [(s["title"], s["hash"]) for s in cur["sections"]], [d["url"] for d in cur["docs"]]])
    cur["changed"] = prev.get("changed", "") if prev.get("hash") == cur["hash"] else (today if prev else "")
    cur["first_read"] = prev.get("first_read") or today
    cur["checked"] = today
    return cur


def write(path: Path, data: dict) -> None:
    rows = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in data["judges"])
    head = json.dumps({k: v for k, v in data.items() if k != "judges"}, ensure_ascii=False, separators=(",", ":"))[:-1]
    path.write_text(head + ',"judges":[\n' + rows + "\n]}\n", encoding="utf-8")


def today_iso() -> str:
    return dt.date.today().isoformat()


def main(argv: list[str]) -> int:
    judges = json.loads((DATA / "judges.json").read_text())
    path = DATA / "judge_pages.json"
    old = json.loads(path.read_text()) if path.exists() else {"judges": []}
    prev = {r["code"]: r for r in old.get("judges", [])}
    today = today_iso()
    try:
        pages = find_pages(fetch(LISTING), judges)
    except Exception as e:  # noqa: BLE001 - keep the last copy when the court's site is down
        print(f"Could not read the judge listing: {e}", flush=True)
        return 0
    rows = []
    for j in sorted(judges, key=lambda j: j["name"]):
        found = pages.get(j["code"], {})
        urls = found.get("urls") or [prev.get(j["code"], {}).get("url", "")]
        urls = [u for u in dict.fromkeys(urls + [prev.get(j["code"], {}).get("url", "")]) if u]
        if not urls:
            print(f"{j['name']}: no page found on the listing", flush=True)
            if j["code"] in prev:
                rows.append(prev[j["code"]])
            continue
        html, url, errors = "", "", []
        for u in urls:
            time.sleep(PAUSE)
            try:
                html, url = fetch(u), u
                break
            except Exception as e:  # noqa: BLE001
                errors.append(f"{e} ({u})")
        if not html:
            print(f"{j['name']}: " + "; ".join(errors), flush=True)
            if j["code"] in prev:
                rows.append({**prev[j["code"]], "error": errors[-1][:200]})
            continue
        cur = read_page(html, url)
        if found.get("section") and not cur["contact"].get("section"):
            cur["contact"]["section"] = found["section"]
        if DEBUG or not cur["sections"]:
            print(f"{j['name']}: {url}\n" + outline(html)[:6000 if DEBUG else 600], flush=True)
        row = {"code": j["code"], **merge(prev.get(j["code"]), cur, today)}
        print(f"{j['name']}: {row['title']} · {len(row['sections'])} sections · {len(row['docs'])} documents"
              + (" · changed" if row["changed"] == today and j["code"] in prev else ""), flush=True)
        rows.append(row)
    data = {"checked": today, "since": old.get("since") or today, "source": LISTING, "judges": rows}
    if "--print" in argv:
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0
    # Rewrite the file when a page changed, or once a week so the "checked" dates stay current; not every day.
    stale = old.get("checked", "") < (dt.date.fromisoformat(today) - dt.timedelta(days=7)).isoformat()
    if rows and (stale or unchecked(old) != unchecked(data)):
        write(path, data)
    else:
        print("No change on the judges' pages.", flush=True)
    return 0


def unchecked(obj):
    """The data without its "checked" dates, for telling a real change from a routine read."""
    if isinstance(obj, dict):
        return {k: unchecked(v) for k, v in obj.items() if k != "checked"}
    if isinstance(obj, list):
        return [unchecked(v) for v in obj]
    return obj


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
