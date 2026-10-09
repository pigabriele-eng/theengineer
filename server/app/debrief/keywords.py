"""Sort a debrief transcript into report points by keywords: the free stand-in for structure.py (Claude).

Used when ANTHROPIC_API_KEY isn't set. Each sentence that talks about the car, the tyres, the brakes or a corner
becomes one point in the section its words point to, with the corner ("turn 5", "T5", "curva 5", a corner name of
the track) and the phase ("under braking", "at the apex", "uscita") when it says them. Sentences with none of these
words (small talk) are left out. English, Italian and German. Returns what structure.structure() returns.
"""
from __future__ import annotations

import re
from collections import Counter

from app.debrief.structure import Context
from app.debrief.transcribe import Transcript

# Section -> word stems (matched at the start of a word, lower case). Checked in this order: a sentence goes to the
# first section any of its words point to ("understeer under braking" is balance, "lock-up on the brakes" brakes).
SECTION_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("priorities", ("priority", "most important", "main thing", "biggest problem", "priorità", "la cosa più importante",
                    "priorität", "das wichtigste", "am wichtigsten")),
    ("balance", ("understeer", "oversteer", "under-steer", "over-steer", "push", "loose", "snap", "rotat", "balance",
                 "stable", "unstable", "nervous", "rear steps out", "sottoster", "sovraster", "bilanciament",
                 "instabil", "nervos", "scappa il posteriore", "untersteuer", "übersteuer", "uebersteuer", "schiebt",
                 "nervös", "heck kommt")),
    ("brakes", ("brake", "braking", "lock", "abs", "pedal", "bias", "fren", "bloccagg", "bloccava", "pedale",
                "ripartizione", "brems", "blockier", "pedal")),
    ("traction", ("traction", "wheelspin", "wheel spin", "spin", "power", "throttle", "trazione", "pattin",
                  "potenza", "acceleratore", "traktion", "durchdreh", "leistung")),
    ("tyres", ("tyre", "tire", "grip", "overheat", "rears", "fronts", "surriscald", "überhitz",
               "pressure", "graining", "degradation", "deg ", "warm up", "warm-up", "blister",
               "gomm", "pneumatic", "pression", "aderenza", "degrado", "reifen", "druck", "haftung", "abbau")),
    ("electronics", ("tc ", "tc.", "traction control", "engine map", "map ", "gearshift", "gear shift", "downshift",
                     "upshift", "dash", "alarm", "controllo di trazione", "mappa", "cambiata", "cruscotto",
                     "traktionskontrolle", "mappe", "schaltung", "display")),
    ("ride", ("kerb", "curb", "bump", "bottom", "ride", "porpois", "platform", "cordol", "buca", "bottom", "dosso",
              "randstein", "bodenwelle", "aufsetz")),
    ("setup", ("softer", "stiffer", "more wing", "less wing", "anti-roll", "arb", "camber", "toe", "ride height",
               "rebound", "damper", "spring", "click", "setup", "set-up", "morbid", "rigid", "ala ", "barra",
               "campanatura", "convergenza", "ammortizz", "molla", "assetto", "weicher", "härter", "flügel", "stabi",
               "sturz", "dämpfer", "feder", "abstimmung")),
    ("issues", ("problem", "issue", "broken", "damage", "noise", "vibrat", "warning", "traffic", "track limit",
                "yellow", "flag", "safety car", "problema", "rotto", "danno", "rumore", "vibrazion", "traffico",
                "bandiera", "kaputt", "schaden", "geräusch", "verkehr", "flagge")),
]

PHASE_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("braking", ("braking", "on the brakes", "under brakes", "frenata", "staccata", "in frenata", "anbrems",
                 "beim bremsen", "bremsphase")),
    ("entry", ("entry", "turn-in", "turn in", "turning in", "ingresso", "inserimento", "eingang", "einlenk")),
    ("mid", ("mid-corner", "mid corner", "apex", "middle of the corner", "centro curva", "percorrenza", "corda",
             "scheitel", "kurvenmitte")),
    ("exit", ("exit", "on the way out", "power on", "uscita", "ausgang", "kurvenausgang", "herausbeschleunig")),
]

NUMBERS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen twenty".split())}
NUMBERS |= {w: i for i, w in enumerate(
    "zero uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici quattordici quindici sedici "
    "diciassette diciotto diciannove venti".split())}
NUMBERS |= {w: i for i, w in enumerate(
    "null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn "
    "siebzehn achtzehn neunzehn zwanzig".split())}
CORNER = re.compile(r"\b(?:turn|corner|curva|kurve|t)\s*(\d{1,2}|[a-zäöüß]+)\b", re.IGNORECASE)
SENTENCE = re.compile(r"(?<=[.!?;])\s+")


def _has(text: str, stems: tuple[str, ...]) -> bool:
    padded = f" {text} "
    return any(f" {s}" in padded or f"-{s}" in padded for s in stems)


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[,.!?;:()\"]", " ", text.lower()).split())


def section_of(text: str) -> str | None:
    t = _norm(text)
    return next((name for name, stems in SECTION_WORDS if _has(t, stems)), None)


def phase_of(text: str) -> str | None:
    t = _norm(text)
    return next((name for name, stems in PHASE_WORDS if _has(t, stems)), None)


def corner_of(text: str, corners: list[tuple[str, str | None]]) -> str | None:
    """The corner a sentence names: the track's corner name, else a turn number ("turn 5", "T5", "curva cinque")."""
    low = text.lower()
    for code, name in corners:
        if name and re.search(rf"\b{re.escape(name.lower())}\b", low):
            return code
    for m in CORNER.finditer(text):
        word = m.group(1).lower()
        n = int(word) if word.isdigit() else NUMBERS.get(word)
        if n:
            return f"T{n}"
    return None


def structure(transcript: Transcript, ctx: Context) -> dict:
    """Points by keyword, the same shape as structure.structure(): {"summary", "speakers", "points"}."""
    points = []
    for seg in transcript.segments:
        for sentence in SENTENCE.split(seg.text.strip()):
            sentence = sentence.strip()
            if len(sentence) < 3:
                continue
            corner = corner_of(sentence, ctx.corners)
            section = section_of(sentence) or ("corners" if corner else None)
            if section is None:
                continue
            points.append({"section": section, "text": sentence[0].upper() + sentence[1:], "speaker": seg.speaker,
                           "corner": corner, "phase": phase_of(sentence), "audio_start_s": seg.start})
    speakers = sorted({s.speaker for s in transcript.segments})
    role = "driver" if ctx.mode == "individual" else "other"
    return {"summary": _summary(points), "points": points,
            "speakers": [{"label": s, "role": role, "name": None} for s in speakers]}


NAMES = {"balance": "car balance", "corners": "corners", "tyres": "tyres", "brakes": "brakes",
         "electronics": "electronics", "traction": "traction", "ride": "ride and kerbs", "setup": "setup changes",
         "issues": "issues", "priorities": "priorities"}


def _summary(points: list[dict]) -> str:
    if not points:
        return "Nothing about the car was picked out of this debrief."
    counts = Counter(p["section"] for p in points)
    topics = ", ".join(f"{NAMES[s]} ({n})" for s, n in counts.most_common(3))
    first = next((p for p in points if p["section"] in ("priorities", "balance")), points[0])
    return f"Sorted by keywords. Most said about {topics}. {first['text'].rstrip('.')}."
