"""Official corner numbers for tracks we have driven, so a new log is numbered and sectored from the start.

Numbers come from a published track map (the series', the circuit's or the FIA's; "source" is the map). Corner
positions are metres from the timing (finish) line along the lap: measured on a logged lap where we have one, else on
a surveyed centre line of the layout the series races and scaled to its official length, good to about 50 m, which
the analysis tolerates (it snaps each number to the slow point near it). Corners sharing a sector are timed as one
section. Tracks without a usable outline yet (Misano, Valencia, Lausitzring, Sachsenring, Salzburgring) and ones whose
numbering could not be confirmed (Barcelona, Portimão, Jeddah, Oschersleben, Norisring) are left out: their logs keep
C1, C2... until they are added.
"""
import re

from app import models
from app.results.venues import plain

KNOWN: dict[str, dict] = {
    "Hockenheim GP": {
        "aliases": ("hockenheim", "hockenheimring"),
        "words": ("hockenheim",),
        "length_m": 4574,
        "source": None,  # the GP circuit's 17-turn numbering from published track guides (2026-10-04)
        "corners": [("T1", 280, None), ("T2", 855, "T2-T5"), ("T3", 913, "T2-T5"), ("T4", 955, "T2-T5"),
                    ("T5", 1680, "T2-T5"), ("T6", 2111, None), ("T7", 2556, None), ("T8", 2827, None),
                    ("T9", 2900, None), ("T10", 2990, None), ("T11", 3391, None), ("T12", 3477, None),
                    ("T13", 3791, None), ("T14", 3960, None), ("T15", 4085, None), ("T16", 4189, None),
                    ("T17", 4269, None)],
    },
    # numbers from the FIA circuit map (2021 Dutch Grand Prix, Doc 1); the circuit numbers 6 & 7 and 11 & 12
    # as one corner each (circuitzandvoort.nl/en/corners/). Measured on a 4219 m logged lap.
    "Circuit Zandvoort": {
        "aliases": ("zandvoort", "circuit park zandvoort", "cm.com circuit zandvoort"),
        "words": ("zandvoort",),
        "length_m": 4259,
        "source": "https://circuitzandvoort.nl/en/corners/",
        "corners": [("T1", 373, None), ("T2", 710, None), ("T3", 821, None), ("T4", 1065, None),
                    ("T5", 1267, None), ("T6", 1435, "T6-T7"), ("T7", 1673, "T6-T7"), ("T8", 2025, None),
                    ("T9", 2263, None), ("T10", 2500, None), ("T11", 3095, "T11-T12"), ("T12", 3153, "T11-T12"),
                    ("T13", 3469, None), ("T14", 3745, None)],
    },
    # GT4 European Series circuit map (GP layout with the long straight chicane, 5822 m); measured on our 2026
    # qualifying lap (5743 m logged).
    "Circuit Paul Ricard": {
        "aliases": ("paul ricard", "le castellet", "circuit paul ricard"),
        "words": ("paul ricard", "castellet"),
        "length_m": 5822,
        "source": "https://www.gt4europeanseries.com/images/circuits/CircuitPaulRicard_2021.png",
        "corners": [("T1", 646, "T1-T2"), ("T2", 735, "T1-T2"), ("T3", 1313, None), ("T4", 1383, None),
                    ("T5", 1496, None), ("T6", 1604, None), ("T7", 1809, None), ("T8", 2937, "T8-T9"),
                    ("T9", 3004, "T8-T9"), ("T10", 3843, None), ("T11", 4367, None), ("T12", 4764, None),
                    ("T13", 4913, None), ("T14", 5290, None), ("T15", 5421, None)],
    },
    # GT4 European Series circuit map; measured on our 2026 qualifying lap (5759 m logged).
    "Autodromo Nazionale Monza": {
        "aliases": ("monza",),
        "words": ("monza",),
        "length_m": 5793,
        "source": "https://www.gt4europeanseries.com/images/circuits/track-monza.png",
        "corners": [("T1", 735, "T1-T2"), ("T2", 795, "T1-T2"), ("T3", 1296, None), ("T4", 1951, "T4-T5"),
                    ("T5", 2013, "T4-T5"), ("T6", 2352, None), ("T7", 2670, None), ("T8", 3736, "T8-T10"),
                    ("T9", 3834, "T8-T10"), ("T10", 3936, "T8-T10"), ("T11", 4976, None)],
    },
    # GT4 European Series circuit map (19 turns, 7004 m); positions from a surveyed centre line, measured from the
    # finish line.
    "Circuit de Spa-Francorchamps": {
        "aliases": ("spa", "spa-francorchamps", "spa francorchamps"),
        "words": ("spa", "francorchamps"),
        "length_m": 7004,
        "source": "https://www.gt4europeanseries.com/images/circuits/track-spa.png",
        "corners": [("T1", 392, None), ("T2", 1057, None), ("T3", 1137, None), ("T4", 1287, None),
                    ("T5", 2427, None), ("T6", 2517, None), ("T7", 2668, None), ("T8", 3084, None),
                    ("T9", 3300, None), ("T10", 3842, None), ("T11", 4020, None), ("T12", 4543, None),
                    ("T13", 4677, None), ("T14", 4953, None), ("T15", 5211, None), ("T16", 5957, None),
                    ("T17", 6212, None), ("T18", 6752, "T18-T19"), ("T19", 6812, "T18-T19")],
    },
    # SRO circuit map and 2025 drivers" briefing (GP circuit, 5137 m, 17 turns); positions from a surveyed centre
    # line, measured from the finish line. T15 not placed (not on this outline).
    "Nürburgring GP": {
        "aliases": ("nurburgring", "nürburgring", "nuerburgring"),
        "words": ("nurburgring", "nuerburgring"),
        "length_m": 5137,
        "source": "https://www.gt4europeanseries.com/images/circuits/Map%20Nu%CC%88rburgring.jpeg",
        "corners": [("T1", 646, None), ("T2", 870, None), ("T3", 1090, None), ("T4", 1205, None), ("T5", 1695, None),
                    ("T6", 1860, None), ("T7", 2120, None), ("T8", 2442, None), ("T9", 2843, None),
                    ("T10", 3007, None), ("T11", 3432, None), ("T12", 3656, None), ("T13", 4077, None),
                    ("T14", 4565, "T14-T16"), ("T16", 4627, "T14-T16"), ("T17", 4892, None)],
    },
    # FIA numbering (10 turns, 4318 m) as on the circuit"s track guide; positions from a surveyed centre line.
    "Red Bull Ring": {
        "aliases": ("red bull ring", "spielberg"),
        "words": ("red bull ring", "spielberg"),
        "length_m": 4318,
        "source": "https://commons.wikimedia.org/wiki/File:Spielberg_bare_map_numbers_contextless_2016_onwards.svg",
        "corners": [("T1", 452, None), ("T2", 1063, None), ("T3", 1387, None), ("T4", 2208, None),
                    ("T5", 2468, None), ("T6", 2740, None), ("T7", 3032, None), ("T8", 3222, None),
                    ("T9", 3795, None), ("T10", 3997, None)],
    },
    # FIA circuit map numbering (19 turns, 4909 m) as stated by published track guides; positions from OSM-based
    # outline.
    "Autodromo Enzo e Dino Ferrari": {
        "aliases": ("imola",),
        "words": ("imola",),
        "length_m": 4909,
        "source": "https://www.fia.com/system/files/decision-document/2025_imola_event_-_circuit_map_-_imola_2025.pdf",
        "corners": [("T1", 563, None), ("T2", 696, "T2-T4"), ("T3", 768, "T2-T4"), ("T4", 884, "T2-T4"),
                    ("T5", 1343, "T5-T6"), ("T6", 1425, "T5-T6"), ("T7", 1714, None), ("T8", 2119, None),
                    ("T9", 2333, None), ("T10", 2492, None), ("T11", 2750, None), ("T12", 2836, None),
                    ("T13", 2898, None), ("T14", 3351, "T14-T15"), ("T15", 3412, "T14-T15"), ("T16", 3965, None),
                    ("T17", 4137, None), ("T18", 4279, None), ("T19", 4602, None)],
    },
    # FIA/F1 GP numbering (18 turns, 5891 m, timing on the Wing straight); positions from a surveyed centre line.
    "Silverstone Circuit": {
        "aliases": ("silverstone",),
        "words": ("silverstone",),
        "length_m": 5891,
        "source": "https://www.formula1.com/en/latest/article/explained-how-every-silverstone-corner-got-its-name.idMlxFC2gfN2ApcPmifxN",
        "corners": [("T1", 412, None), ("T2", 652, None), ("T3", 897, None), ("T4", 1051, None), ("T5", 1247, None),
                    ("T6", 2001, None), ("T7", 2182, None), ("T8", 2566, None), ("T9", 3118, None),
                    ("T10", 3623, None), ("T11", 3723, None), ("T12", 3903, None), ("T13", 4015, None),
                    ("T14", 4189, None), ("T15", 5092, None), ("T16", 5524, None), ("T17", 5594, "T17-T18"),
                    ("T18", 5768, "T17-T18")],
    },
    # GT World Challenge Europe briefing numbering (GP circuit, 9 turns, 3916 m); positions from a surveyed centre line.
    "Brands Hatch GP": {
        "aliases": ("brands hatch",),
        "words": ("brands hatch",),
        "length_m": 3916,
        "source": "https://www.gt-world-challenge-europe.com/documents/notice/5918/Briefing+Presentation+Brands+Hatch.pdf",
        "corners": [("T1", 283, None), ("T2", 632, None), ("T3", 871, None), ("T4", 1264, None), ("T5", 2050, None),
                    ("T6", 2359, None), ("T7", 2756, None), ("T8", 3001, None), ("T9", 3450, None)],
    },
    # Circuit"s published numbering (GP circuit, 17 turns, 4411 m); positions from OSM-based outline.
    "Circuit de Nevers Magny-Cours": {
        "aliases": ("magny-cours", "magny cours"),
        "words": ("magny cours", "magny-cours"),
        "length_m": 4411,
        "source": "https://www.circuitmagnycours.com/guide-decouvrez-le-circuit-de-nevers-magny-cours/",
        "corners": [("T1", 212, None), ("T2", 356, None), ("T3", 655, None), ("T4", 1264, None), ("T5", 1640, None),
                    ("T6", 1925, None), ("T7", 2171, "T7-T8"), ("T8", 2234, "T7-T8"), ("T9", 2515, None),
                    ("T10", 2647, None), ("T11", 2788, None), ("T12", 3140, "T12-T13"), ("T13", 3221, "T12-T13"),
                    ("T14", 3441, None), ("T15", 4054, None), ("T16", 4128, "T16-T17"), ("T17", 4191, "T16-T17")],
    },
}


# Names that say a different layout of a circuit we know: its corner numbers would be wrong there.
OTHER_LAYOUT = ("nordschleife", "24h", "kurz", "short", "national", "indy", "club", "sprint", "oval", "kart",
                "motorrad", "moto", "rally")


def _says(low: str, word: str) -> bool:
    """A word in the name: "hockenheim" in "hockenheimring", but "spa" only as a word of its own (not "spain")."""
    return re.search(rf"\b{re.escape(word)}" + ("" if len(word) >= 6 else r"\b"), low) is not None


def known_track(name: str | None) -> tuple[str, dict] | None:
    """The track whose official corners fit a log's or an event's venue name: its key or one of its aliases, else
    a name holding one of its words ("Circuit de Spa-Francorchamps", "Autodromo Nazionale Monza"), unless the name
    says another layout of it ("Nürburgring Nordschleife")."""
    if not name or not name.strip():
        return None
    low = name.strip().lower()
    for key, t in KNOWN.items():
        if low == key.lower() or low in t["aliases"]:
            return key, t
    low = plain(name).replace("_", " ")
    if any(_says(low, w) for w in OTHER_LAYOUT):
        return None
    for key, t in KNOWN.items():
        if any(_says(low, w) for w in t.get("words", ())):
            return key, t
    return None


def fill_corners(track: models.Track) -> None:
    """Give a track with no corners the official ones, when we know them."""
    found = known_track(track.name)
    if found is None or track.corners:
        return
    _, t = found
    track.length_m = track.length_m or t["length_m"]
    track.corners = [models.Corner(code=c, apex_m=m, sector=s) for c, m, s in t["corners"]]
