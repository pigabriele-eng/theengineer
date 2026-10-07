"""One key per circuit, whatever a results site, a logger or a user calls it."""
from __future__ import annotations

import html
import re
import unicodedata

_ALIASES = {
    "paul-ricard": ("paul ricard", "le castellet", "castellet"),
    "spa": ("spa", "francorchamps"),
    "nurburgring": ("nurburgring",),
    "hockenheim": ("hockenheim",),
    "zandvoort": ("zandvoort",),
    "monza": ("monza",),
    "misano": ("misano",),
    "barcelona": ("barcelona", "catalunya", "montmelo"),
    "jeddah": ("jeddah", "corniche"),
    "portimao": ("portimao", "algarve"),
    "imola": ("imola",),
    "red-bull-ring": ("red bull ring", "spielberg"),
    "valencia": ("valencia", "ricardo tormo"),
    "brands-hatch": ("brands hatch",),
    "silverstone": ("silverstone",),
    "magny-cours": ("magny cours", "magny-cours"),
    "lausitzring": ("lausitz",),
    "sachsenring": ("sachsenring",),
    "oschersleben": ("oschersleben",),
    "norisring": ("norisring",),
}


def plain(text: str) -> str:
    text = unicodedata.normalize("NFKD", html.unescape(text or ""))
    return re.sub(r"\s+", " ", "".join(c for c in text if not unicodedata.combining(c))).strip().lower()


def _says(low: str, word: str) -> bool:
    """A word of the name, or the start of one for a long word ("Hockenheimring"): "spa" is not in "Spain"."""
    return re.search(rf"\b{re.escape(word)}" + ("" if len(word) >= 6 else r"\b"), low) is not None


def venue_key(name: str | None) -> str | None:
    """'Circuit Paul Ricard' -> 'paul-ricard', 'N&uuml;rburgring' -> 'nurburgring', 'Hockenheim GP' -> 'hockenheim'."""
    if not name:
        return None
    low = plain(name).replace("_", " ")
    for key, words in _ALIASES.items():
        if any(_says(low, w) for w in words):
            return key
    return re.sub(r"[^a-z0-9]+", "-", low).strip("-") or None
