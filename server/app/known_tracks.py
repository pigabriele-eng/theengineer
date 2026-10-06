"""Official corner numbers for tracks we have driven, so a new log is numbered and sectored from the start.

Corner positions are metres from the start/finish line along the racing line, measured on a logged lap and
checked against the circuit's published track map. Corners sharing a sector are timed as one section.
"""
from app import models

KNOWN: dict[str, dict] = {
    "Hockenheim GP": {
        "aliases": ("hockenheim", "hockenheimring"),
        "length_m": 4574,
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
        "length_m": 4259,
        "corners": [("T1", 373, None), ("T2", 710, None), ("T3", 821, None), ("T4", 1065, None),
                    ("T5", 1267, None), ("T6", 1435, "T6-T7"), ("T7", 1673, "T6-T7"), ("T8", 2025, None),
                    ("T9", 2263, None), ("T10", 2500, None), ("T11", 3095, "T11-T12"), ("T12", 3153, "T11-T12"),
                    ("T13", 3469, None), ("T14", 3745, None)],
    },
}


def known_track(name: str | None) -> tuple[str, dict] | None:
    if not name:
        return None
    low = name.strip().lower()
    for key, t in KNOWN.items():
        if low == key.lower() or low in t["aliases"]:
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
