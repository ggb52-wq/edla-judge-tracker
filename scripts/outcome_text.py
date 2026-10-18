"""Read what a ruling did to a motion, from CM/ECF docket text or from an order's decretal language.

Outcomes describe the motion, not a party: "granted" means the motion was granted, whoever filed it.
  granted   the motion was granted
  partial   granted in part and denied in part, or granted as to some relief and denied as to the rest
  denied    the motion was denied
  mixed     several motions were decided different ways and the ruling type does not say which one counts
  moot      the motion was denied or dismissed as moot
  other     anything else (entered by hand only)
  unclear   the order text was read and no outcome was found (written by the updater so it does not re-read it)
"""
from __future__ import annotations

import re

VALUES = ("granted", "partial", "denied", "mixed", "moot", "other", "unclear")

# The text a reader picks on the issue form, mapped to the stored value.
FORM_LABELS = {
    "granted": "granted", "granted in part": "partial", "denied": "denied", "mixed (several motions)": "mixed",
    "moot": "moot", "other": "other", "not determined": "unclear",
}

_VERDICT = re.compile(r"\b(grant(?:ed|ing|s)|den(?:ied|ying|ies))\b(\s+in\s+part|\s+(?:as|for\s+being)\s+moot)?", re.I)
_MOOT = re.compile(r"\b(?:finding\s+as\s+moot|moot(?:ed|ing)?)\b", re.I)
_MOTION = re.compile(r"\bmotions?\b", re.I)
_DECRETAL = re.compile(r"\bIT\s+IS\s+(?:FURTHER\s+|HEREBY\s+|SO\s+|ALSO\s+)*ORDERED\b", re.I)
_CONCLUSION = re.compile(r"\b(?:accordingly|for\s+(?:the\s+)?(?:foregoing|above|these|those|stated)\s+reasons)\b", re.I)
_DOCKET_VERB = re.compile(r"(?=\b(?:granting|denying|finding\s+as\s+moot|mooting)\b)", re.I)
_FLAG_FOCUS = {
    "r12": r"dismiss|judgment\s+on\s+the\s+pleadings|12\s*\(\s*[bc]\s*\)",
    "r56": r"summary\s+judgment",
}
SEGMENT_CHARS = 400


def _focus(event: str, r12: int, r56: int) -> tuple[re.Pattern | None, int]:
    """Words naming the motion this ruling is counted for: the Rule 12/56 flags first, else the event's own motion names."""
    terms = [_FLAG_FOCUS[k] for k, on in (("r12", r12), ("r56", r56)) if on]
    if not terms:
        for name in re.findall(r"motion\s+(?:to|for|in)\s+([a-z][a-z ]*?)(?=\s*(?:/|,|\(|$|\band\b))", (event or "").lower()):
            words = name.split()[:3]
            if words and words[0] not in ("miscellaneous", "leave"):
                terms.append(r"\s+".join(map(re.escape, words)))
    terms = list(dict.fromkeys(terms))
    return (re.compile("|".join(terms), re.I) if terms else None), len(terms)


def _verdict(segment: str) -> str:
    m = _VERDICT.search(segment)
    moot = _MOOT.search(segment)
    if moot and (not m or moot.start() < m.end() + 12):
        return "moot"
    if not m:
        return ""
    tail = (m.group(2) or "").lower()
    if "part" in tail:
        return "partial"
    if "moot" in tail:
        return "moot"
    return "granted" if m.group(1).lower().startswith("grant") else "denied"


def _segments(text: str, source: str) -> list[str]:
    if source == "docket":
        return [p for p in _DOCKET_VERB.split(text) if p.strip()]
    return [p[:SEGMENT_CHARS] for p in _DECRETAL.split(text)[1:]]


def _conclusion(text: str) -> list[str]:
    """The concluding paragraph ("Accordingly, ...", "For the foregoing reasons, ..."), else the order's last lines."""
    tail = text[-2500:]
    parts = _CONCLUSION.split(tail)[1:]
    return [p[:SEGMENT_CHARS] for p in parts] or [tail[-SEGMENT_CHARS * 2:]]


def combine(found: list[str], one_motion: bool) -> str:
    vals = set(found)
    if len(vals) > 1:
        vals.discard("moot")
    if not vals:
        return ""
    if len(vals) == 1:
        return vals.pop()
    # Granted on some points and denied on others: one motion decided in part, or several motions decided differently.
    return "partial" if one_motion or "partial" in vals else "mixed"


def _picked(text: str, event: str, r12: int, r56: int, source: str):
    """Yield (segments about the motion this ruling is counted for, one_motion) for each place worth reading:
    the "IT IS ORDERED" paragraphs first, then (for an order) the conclusion."""
    focus, kinds = _focus(event, r12, r56)
    tries = [_segments(text, source)] + ([_conclusion(text)] if source == "order" else [])
    for segs in tries:
        focused = [s for s in segs if focus and focus.search(s)]
        yield (focused or [s for s in segs if _MOTION.search(s)]), bool(focused) and kinds == 1


def classify(text: str | None, event: str = "", r12: int = 0, r56: int = 0, source: str = "order") -> str:
    """The outcome of the motion ruling in `text`, or "" when none can be read.

    source "docket": CM/ECF docket text ("ORDER granting 12 Motion to Dismiss ...").
    source "order": the order's full text, read from its "IT IS ORDERED" paragraphs.
    """
    if not text:
        return ""
    for picked, one_motion in _picked(text, event, r12, r56, source):
        if value := combine([v for s in picked if (v := _verdict(s))], one_motion):
            return value
    return ""


# Docket number of a motion: "granting 12 Motion to Dismiss" in docket text; "(R. Doc. 12)", "(Rec. Doc. 12)",
# "ECF No. 12" or "Doc. 12" beside the motion's name in an order.
_DOCKET_MOTION_NO = re.compile(r"\b(\d{1,4})\s+motion\b", re.I)
_ORDER_DOC_REF = re.compile(r"\b(?:R\.?\s*Doc\.?|Rec\.?\s*Doc\.?|Record\s+Doc(?:ument|\.)?|ECF\s+(?:No\.?|Doc\.?)|Dkt\.?(?:\s*No\.?)?|Doc(?:ument|\.)?)"
                            r"\s*(?:No\.?\s*)?#?\s*(\d{1,4})\b", re.I)


def motion_doc(text: str | None, event: str = "", r12: int = 0, r56: int = 0, source: str = "order") -> str:
    """The docket number of the motion this ruling decides, read from the segment that carried the verdict, or ""."""
    if not text:
        return ""
    for picked, _ in _picked(text, event, r12, r56, source):
        for seg in picked:
            if not _verdict(seg):
                continue
            m = (_DOCKET_MOTION_NO if source == "docket" else _ORDER_DOC_REF).search(seg)
            if m:
                return m.group(1)
    return ""
