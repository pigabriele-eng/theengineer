"""The quickest laps of a long event, for the event grip and balance reports.

Those reports keep every clean lap of the event on the track line while they read one log after another, and then
work them out together. Measured on the Hockenheim test (116 clean laps) and on it copied four times over (464), the
server's peak grows by about 0.6 MB a lap for grip use and 1 MB a lap for the balance: 242 MB for the test's balance,
563 MB for four times its laps, past the 512 MB the hosted server has. So, like the event report
(routers/reports.py), they work from the quickest MAX_LAPS laps, which keeps both under 300 MB. Each run's laps
are cut back to the quickest of all laps so far as soon as the run is read, so memory never holds more than MAX_LAPS
laps and one run's. A lap dropped then would be dropped at the end too: the slowest time kept only falls as more
laps come in. Events with fewer laps are not touched.
"""
from __future__ import annotations

from app.analysis.insights import LapRecord

MAX_LAPS = 150


def keep_quickest(laps: list[LapRecord], limit: int | None = None) -> list[LapRecord]:
    """The quickest `limit` (MAX_LAPS) laps, in their order; laps as quick as the slowest one kept stay too. The
    same list when there are no more."""
    limit = MAX_LAPS if limit is None else limit
    if len(laps) <= limit:
        return laps
    slowest = sorted(x.time for x in laps)[limit - 1]
    return [x for x in laps if x.time <= slowest]


def lap_cap(used: int, of: int) -> dict | None:
    """What a report says when it left laps out: how many of how many clean laps it used. None when it used all."""
    return {"used": used, "of": of} if used < of else None
