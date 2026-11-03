"""Resolve a quoted anchor to one place in one paragraph, or say precisely why not.

The folding table, the paragraph-scoped search and the structured failure follow RedlineBench's
redline_engine/anchoring.py and references/anchors.md (https://github.com/crosbylegal/redline-bench,
commit b29d1113af5d98e2d577f4f17673ebb72834f107, MIT License, Copyright (c) 2026 Crosby Legal; see
LICENSE-redline-bench). Changes: offsets are mapped back to the raw text so the edit lands on the
original runs; soft hyphens and zero-width characters are dropped; a leading list number is
ignored when the quote only matches without it; a failure lists the closest paragraphs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from .model import Unit

FOLD = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
    " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "\t": " ",
}
DROP = {"­", "​", "‌", "‍", "⁠", "﻿"}
NUMBER_PREFIX = re.compile(
    r"^\s*(?:(?:section|article|clause|schedule|exhibit|annex)\s+)?"
    r"(?:\(?[0-9]{1,3}[a-z]?\)?(?:\.[0-9]{1,3})*\.?|\([a-z]{1,4}\)|[a-z]{1,4}[.)]|[ivxlc]{1,6}[.)])\s+",
    re.IGNORECASE,
)


def fold(text: str, casefold: bool = False) -> tuple[str, list[int]]:
    """Text normalized for matching, and for each folded character the raw index it came from."""
    out: list[str] = []
    index: list[int] = []
    space = False
    for i, ch in enumerate(text):
        if ch in DROP:
            continue
        ch = FOLD.get(ch, ch)
        if ch.isspace():
            if space:
                continue
            ch, space = " ", True
        else:
            space = False
            if casefold:
                lower = ch.lower()
                ch = lower if len(lower) == 1 else ch
        out.append(ch)
        index.append(i)
    return "".join(out), index


@dataclass
class Located:
    unit: Unit
    start: int  # raw offsets into unit.text
    end: int
    notes: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return self.unit.text[self.start:self.end]


class AnchorFailure(Exception):
    def __init__(self, reason: str, message: str, candidates: list[dict] | None = None):
        super().__init__(message)
        self.reason = reason
        self.candidates = candidates or []

    def as_dict(self) -> dict:
        found = {"reason": self.reason, "message": str(self)}
        if self.candidates:
            found["candidates"] = self.candidates
        return found


def occurrences(unit: Unit, needle: str, casefold: bool) -> list[tuple[int, int]]:
    hay, index = fold(unit.text, casefold)
    found = []
    start = hay.find(needle)
    while start != -1 and needle:
        end = start + len(needle)
        found.append((index[start], index[end - 1] + 1))
        start = hay.find(needle, end)
    return found


def snippet(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def closest(units: list[Unit], quote: str, limit: int = 3) -> list[dict]:
    """The paragraphs whose text is most like the quote, with the most similar stretch of each."""
    needle, _ = fold(quote.strip(), casefold=True)
    if not needle:
        return []
    scored = []
    for unit in units:
        hay, index = fold(unit.text, casefold=True)
        if len(hay) < 3:
            continue
        matcher = SequenceMatcher(None, needle, hay, autojunk=False)
        block = matcher.find_longest_match(0, len(needle), 0, len(hay))
        if block.size < min(6, len(needle)):
            continue
        start = max(0, block.b - block.a)
        end = min(len(hay), start + len(needle))
        ratio = SequenceMatcher(None, needle, hay[start:end], autojunk=False).ratio()
        if ratio >= 0.45:
            raw = unit.text[index[start]: index[end - 1] + 1]
            scored.append((ratio, unit.id, raw))
    scored.sort(key=lambda item: -item[0])
    return [{"paragraph": pid, "text": snippet(raw), "similarity": round(r, 2)} for r, pid, raw in scored[:limit]]


def locate(units: list[Unit], quote: str, paragraph: str | None = None, near: str | None = None,
           occurrence: int | None = None) -> Located:
    """One place for the quote, or an AnchorFailure naming the reason and the closest candidates."""
    if not quote or not quote.strip():
        raise AnchorFailure("empty_quote", "quote is empty")
    pool = units
    if paragraph:
        pool = [u for u in units if u.id == paragraph or u.id.startswith(f"{paragraph}.")]
        if not pool:
            raise AnchorFailure("paragraph_not_found", f"there is no paragraph {paragraph}: use an id from read")

    attempts: list[tuple[str, bool, str | None]] = []
    folded, _ = fold(quote.strip())
    attempts.append((folded, False, None))
    attempts.append((fold(quote.strip(), True)[0], True, "matched ignoring case"))
    stripped = NUMBER_PREFIX.sub("", quote.strip(), count=1)
    if stripped and stripped != quote.strip() and len(stripped) >= 4:
        note = f"ignored the list number {quote.strip()[: len(quote.strip()) - len(stripped)].strip()!r}"
        attempts.append((fold(stripped)[0], False, note))
        attempts.append((fold(stripped, True)[0], True, note + ", matched ignoring case"))

    for needle, casefold, note in attempts:
        matches = [(u, s, e) for u in pool for s, e in occurrences(u, needle, casefold)]
        if not matches:
            continue
        notes = [note] if note else []
        if near and len(matches) > 1:
            near_folded = fold(near.strip(), True)[0]
            ranked = []
            for u, s, e in matches:
                hay, index = fold(u.text, True)
                positions = [index[m.start()] for m in re.finditer(re.escape(near_folded), hay)] if near_folded else []
                if positions:
                    ranked.append((min(abs(p - s) for p in positions), u, s, e))
            if ranked:
                ranked.sort(key=lambda item: item[0])
                best = [item for item in ranked if item[0] == ranked[0][0]]
                if len(best) == 1:
                    _, u, s, e = best[0]
                    return Located(u, s, e, notes)
                matches = [(u, s, e) for _, u, s, e in best]
        if occurrence:
            if occurrence > len(matches):
                raise AnchorFailure(
                    "occurrence_out_of_range",
                    f"the quote matches {len(matches)} time(s); occurrence {occurrence} doesn't exist",
                    [{"paragraph": u.id, "text": snippet(u.text[max(0, s - 40): e + 40])} for u, s, e in matches[:5]],
                )
            u, s, e = matches[occurrence - 1]
            return Located(u, s, e, notes)
        if len(matches) > 1:
            raise AnchorFailure(
                "ambiguous",
                f"the quote matches {len(matches)} places: add paragraph, near or occurrence",
                [{"paragraph": u.id, "text": snippet(u.text[max(0, s - 40): e + 40])} for u, s, e in matches[:5]],
            )
        u, s, e = matches[0]
        return Located(u, s, e, notes)

    where = f"paragraph {paragraph}" if paragraph else "the document"
    raise AnchorFailure(
        "not_found",
        f"the quote isn't in {where} (after forgiving whitespace, quotes, dashes and case): copy it from the "
        "current text in read; it may already include an earlier edit",
        closest(units, quote),
    )
