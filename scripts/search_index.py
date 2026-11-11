"""Full-text index of the written opinions, for the site's opinion search.

The site is static, so the browser cannot scan 150 MB of opinion text. This script turns `opinions_text/` into an
inverted index the browser reads a few small files at a time: for every word, the opinions that contain it.

Layout (`data/search/`):
  manifest.json     {"version", "built", "stop": [...], "segments": [{"id", "docs", "width", "sealed", "sig"}]}
  <segment>/docs.json            ["2:26-cv-01880|6", ...]; an opinion's place in this list is its number in the segment
  <segment>/t/<prefix>.json      {"word": "<postings>", ...} for every word starting with <prefix>

Postings are the segment numbers of the opinions containing the word, ascending, stored as gaps in base-128 varints
and then base64 ("AQID" is opinions 1, 3, 6).

Segments keep the daily update small. A sealed segment is never rewritten; the one open segment ("open") holds the
opinions not yet in a sealed one and is rebuilt whenever an opinion text is added or changes. When the open segment
reaches SEAL_AT opinions it is sealed under the next number and a new open segment starts. Without this, one new
opinion would rewrite most of a 10 MB index every day and the repository would grow by that much each time.
`python scripts/search_index.py --rebuild` folds everything back into one sealed segment.

The index answers "which opinions contain these words". Phrases and the sentence shown beside a result come from the
opinion's own text file, which the site fetches for the results on screen. Opinion text is data from court PDFs: it is
tokenized and counted here, never interpreted.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT_DIR = ROOT / "opinions_text"
OUT_DIR = ROOT / "data" / "search"
VERSION = 1
SEAL_AT = 500          # the open segment is sealed at this many opinions
WIDE_AT = 1500         # segments this large split their words by the first two characters, smaller ones by the first
MIN_LEN, MAX_LEN = 2, 24
# Words too common to tell opinions apart. A query word on this list is ignored by the index; inside a quoted phrase it
# is still matched against the opinion's text. The same list is written to the manifest for the site.
STOP = sorted("""a an and are as at be been but by for from had has have he her his if in into is it its of on or
she such that the their them then there these they this to was were which will with would not no""".split())
_STOP = frozenset(STOP)
_TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    """Words as the index knows them. `tokenize()` in assets/app.js must match this exactly."""
    text = unicodedata.normalize("NFKC", text or "").lower().replace("\u2019", "").replace("'", "")
    return [t for t in _TOKEN.findall(text)
            if MIN_LEN <= len(t) <= MAX_LEN and t not in _STOP and not (t.isdigit() and len(t) > 6)]


def encode(ids: list[int]) -> str:
    out = bytearray()
    prev = -1
    for i in ids:
        gap = i - prev          # at least 1: ids ascend and never repeat
        prev = i
        while gap >= 0x80:
            out.append((gap & 0x7F) | 0x80)
            gap >>= 7
        out.append(gap)
    return base64.b64encode(bytes(out)).decode("ascii")


def decode(blob: str) -> list[int]:
    ids, prev, gap, shift = [], -1, 0, 0
    for b in base64.b64decode(blob):
        gap |= (b & 0x7F) << shift
        if b & 0x80:
            shift += 7
        else:
            prev += gap
            ids.append(prev)
            gap, shift = 0, 0
    return ids


def name_of(key: str) -> str:
    case, doc = key.split("|")
    return f"{case.replace(':', '_')}_{doc}.txt"


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"


def _write(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoding="utf-8", data=text)
    return True


def _signature(keys: list[str], index: dict) -> str:
    h = hashlib.sha256()
    for k in keys:
        r = index.get(k) or {}
        h.update(f"{k}|{r.get('chars')}|{r.get('read')}\n".encode())
    return h.hexdigest()[:16]


def build_segment(seg_dir: Path, keys: list[str], text_dir: Path, width: int) -> int:
    """Write one segment for these opinions (in this order). Returns the number of files written or removed."""
    postings: dict[str, list[int]] = {}
    for i, key in enumerate(keys):
        path = text_dir / name_of(key)
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        for t in set(tokenize(text)):
            postings.setdefault(t, []).append(i)
    shards: dict[str, dict[str, str]] = {}
    for term, ids in postings.items():
        shards.setdefault(term[:width], {})[term] = encode(ids)
    changed = int(_write(seg_dir / "docs.json", _dump(keys)))
    tdir = seg_dir / "t"
    for prefix, terms in shards.items():
        changed += int(_write(tdir / f"{prefix}.json", _dump(terms)))
    if tdir.exists():
        for old in tdir.glob("*.json"):
            if old.stem not in shards:
                old.unlink()
                changed += 1
    return changed


def update(text_dir: Path = TEXT_DIR, out_dir: Path = OUT_DIR, today: str = "", seal_at: int = SEAL_AT, rebuild: bool = False) -> dict:
    """Bring the index up to date with the opinion texts on file. Returns {"docs", "open", "sealed", "changed"}."""
    try:
        index = json.loads((text_dir / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {}
    have = sorted(k for k, r in index.items() if isinstance(r, dict) and (r.get("chars") or 0) > 0 and re.fullmatch(r"\d:\d\d-[a-z]{2}-\d{5}\|\d+", k))
    mpath = out_dir / "manifest.json"
    try:
        manifest = json.loads(mpath.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    if rebuild or manifest.get("version") != VERSION or manifest.get("stop") != STOP:
        if out_dir.exists():
            shutil.rmtree(out_dir)
        manifest = {}
    segments = [s for s in manifest.get("segments", []) if s.get("sealed")]
    sealed_keys: set[str] = set()
    for s in segments:
        try:
            sealed_keys.update(json.loads((out_dir / s["id"] / "docs.json").read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    open_keys = [k for k in have if k not in sealed_keys]
    sig = _signature(open_keys, index)
    prev_open = next((s for s in manifest.get("segments", []) if not s.get("sealed")), None)
    if manifest and prev_open and prev_open.get("sig") == sig and len(open_keys) < seal_at:
        return {"docs": len(have), "open": len(open_keys), "sealed": len(segments), "changed": 0}
    changed = 0
    if len(open_keys) >= seal_at:
        seg_id = f"s{len(segments)}"
        width = 2 if len(open_keys) >= WIDE_AT else 1
        changed += build_segment(out_dir / seg_id, open_keys, text_dir, width)
        segments.append({"id": seg_id, "docs": len(open_keys), "width": width, "sealed": True, "sig": sig})
        open_keys, sig = [], _signature([], index)
    changed += build_segment(out_dir / "open", open_keys, text_dir, 1)
    segments_out = segments + [{"id": "open", "docs": len(open_keys), "width": 1, "sealed": False, "sig": sig}]
    changed += int(_write(mpath, _dump({"version": VERSION, "built": today, "stop": STOP, "segments": segments_out})))
    return {"docs": len(have), "open": len(open_keys), "sealed": len(segments), "changed": changed}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rebuild", action="store_true", help="discard the index and build it again as one sealed segment")
    ap.add_argument("--today", default="")
    a = ap.parse_args()
    print(update(today=a.today, rebuild=a.rebuild))


if __name__ == "__main__":
    main()
