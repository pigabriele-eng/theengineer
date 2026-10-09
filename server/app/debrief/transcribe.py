"""Speech to text for voice debriefs, with speakers told apart (Deepgram).

Racing vocabulary and the track's corner names are passed as key terms so words like
"understeer", "TC" or "Grundig" come out right.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import httpx

DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"

# Terms that general speech models often mishear in a debrief. Corner names are added per session.
RACING_TERMS = [
    "understeer", "oversteer", "snap oversteer", "turn-in", "apex", "kerb", "trail braking", "lock-up",
    "ABS", "TC", "traction control", "brake bias", "diff", "anti-roll bar", "ride height", "rebound", "bump",
    "camber", "toe", "tyre pressures", "degradation", "graining", "out-lap", "push lap", "downshift", "upshift",
]

# Deepgram language codes; "multi" lets one recording switch between languages.
LANGUAGES = {"en": "en", "it": "it", "de": "de", "multi": "multi"}


class NotConfigured(RuntimeError):
    pass


@dataclass
class Segment:
    speaker: str
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    segments: list[Segment] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(f"{s.speaker}: {s.text}" for s in self.segments)


def transcribe(path: Path, language: str = "en", key_terms: list[str] | None = None) -> Transcript:
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        raise NotConfigured("This recording wasn't written down while it was recorded, and speech to text for "
                            "recordings isn't set up yet (DEEPGRAM_API_KEY is missing on the server)")
    params: list[tuple[str, str | bool]] = [
        ("model", "nova-3"), ("language", LANGUAGES.get(language, "multi")),
        ("smart_format", "true"), ("diarize", "true"), ("utterances", "true"),
    ]
    params += [("keyterm", t) for t in dict.fromkeys([*RACING_TERMS, *(key_terms or [])])]
    with path.open("rb") as audio:
        r = httpx.post(DEEPGRAM_URL, params=params, content=audio.read(), timeout=600,
                       headers={"Authorization": f"Token {key}", "Content-Type": "application/octet-stream"})
    if r.status_code >= 400:
        raise RuntimeError(f"Speech to text failed ({r.status_code}): {r.text[:300]}")
    return parse_deepgram(r.json())


def parse_deepgram(body: dict) -> Transcript:
    utterances = body.get("results", {}).get("utterances") or []
    return Transcript([
        Segment(speaker=f"S{u.get('speaker', 0)}", start=round(u["start"], 2), end=round(u["end"], 2),
                text=u["transcript"].strip())
        for u in utterances if u.get("transcript", "").strip()
    ])
