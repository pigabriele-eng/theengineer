"""Setup changes to try, ranked in one list, from what the driver said and what the logger shows.

The driver side reads the session's debrief points (tagged with corner and phase) as Observations: one thing the
car does (understeer mid-corner in T6, wheelspin out of T2-T5, a nervous rear under braking) with how much it
matters. Each lever on the car's sheet (a bar one position softer, two clicks of rear rebound, half a percent of
brake balance) says which symptoms it helps and which it makes worse; a lever's score is the sum over the
observations, weighted by the corner speed it works at (aero in fast corners, springs and bars in slow ones) and by
how quick it is to change in the garage.

The data side is the balance report's analysis of the run (app.setup.data): its ranked setup changes score the
levers they map onto, and what it measures checks each driver remark and backs each lever. A change both sides
back counts more; one they disagree on counts less and says why. Other logger data plugs in through
register_data_source, or a caller passes its own observations. The best changes come with the evidence behind
them, what to expect (the vehicle model's numbers for the bars) and what to watch.

The lever table is the usual setup-sheet logic for a front-engined GT car: roll stiffness distribution for
steady-state balance, damping for the transients (more damping on an axle gives it more of the transient load
transfer), rake and wing for the aero balance, brake balance and ABS for the stops, TC and the rear for traction.
It ranks what to try first; it does not replace the engineer's judgement or the car's own setup guide.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

from sqlalchemy.orm import Session

from app import models
from app.debrief.check import _codes, corner_in_text, read_claim
from app.setup.templates import OPPOSITE, Row, Template, format_value
from app.vehicle.model import Change, Vehicle, what_if

log = logging.getLogger(__name__)

KINDS = ("understeer", "oversteer", "traction", "braking_stability", "lock_up", "ride")
KIND_LABEL = {"understeer": "understeer", "oversteer": "oversteer", "traction": "traction / wheelspin",
              "braking_stability": "unstable under braking", "lock_up": "locking wheels",
              "ride": "bottoming or kerbs"}
PHASE_LABEL = {"braking": "under braking", "entry": "on entry", "mid": "mid-corner", "exit": "on exit"}
SPEEDS = ("slow", "medium", "fast")


@dataclass
class Observation:
    """One thing the car does that a setup change could address.

    kind: understeer, oversteer, traction, braking_stability, lock_up or ride.
    phase: braking, entry, mid or exit (None: not said; balance then counts as mid-corner).
    corner: the official corner label as the analysis gives it ("T6", "T8/T9", "T2-T5"), or None.
    speed: slow (apex under 110 km/h), medium or fast (160 and over); None works it out from the corner.
    weight: how much it should count. 1.0 is one clear remark from the driver; the data side can scale it with
        the lap time at stake (about 1.0 per 0.1 s a lap).
    source: "driver" or "data". text: what was said or measured, shown as the reason.
    time_s: lap time at stake, when known. ref: where it came from, e.g. {"debrief_point_id": 12}.
    check: what the run's data says about a driver remark (app.setup.data.check), when it measures it.
    """
    kind: str
    phase: str | None = None
    corner: str | None = None
    speed: str | None = None
    weight: float = 1.0
    source: str = "driver"
    text: str = ""
    time_s: float | None = None
    ref: dict = field(default_factory=dict)
    check: dict | None = None

    @property
    def symptom(self) -> str:
        if self.kind == "oversteer" and self.phase == "braking":
            return "braking_stability"
        if self.kind in ("understeer", "oversteer"):
            phase = {"braking": "entry", None: "mid"}.get(self.phase, self.phase)
            return f"{self.kind}_{phase}"
        return self.kind

    def describe(self) -> str:
        words = [KIND_LABEL.get(self.kind, self.kind)]
        if self.phase in PHASE_LABEL and self.kind in ("understeer", "oversteer"):
            words.append(PHASE_LABEL[self.phase])
        if self.corner:
            words.append(f"at {self.corner}")
        elif self.speed:
            words.append(f"in {self.speed} corners")
        return " ".join(words)


# ---------- the data side ----------

DataSource = Callable[[Session, models.RunSession], list[Observation]]
_data_sources: list[DataSource] = []


def register_data_source(fn: DataSource) -> DataSource:
    """Add a source of logger-data observations for a session; usable as a decorator. Each source gets the
    database session and the run, and returns Observations with source="data". It should read at most one log,
    under app.heavy.lock (after checking its own cache, so a hit doesn't wait), or read a summary it has cached."""
    if fn not in _data_sources:
        _data_sources.append(fn)
    return fn


def data_observations(db: Session, s: models.RunSession) -> tuple[list[Observation], list[str]]:
    out, notes = [], []
    for fn in _data_sources:
        try:
            out += [o for o in fn(db, s) if o.kind in KINDS]
        except Exception as e:  # a failing data source must not take the driver's side down with it
            log.exception("Setup data source %s failed", getattr(fn, "__name__", fn))
            notes.append(f"Logger data left out: {e}")
    return out, notes


# ---------- the driver side ----------

RIDE = re.compile(r"bottom(s|ing|ed)? ?(out)?|touch(es|ing)? the (ground|floor)|kerbs?|curbs?|bump(s|y)|cordol|"
                  r"buche|tocca|aufsetz|randstein|bodenwell", re.I)
FAST = re.compile(r"\b(fast|high[- ]speed|quick) (corner|turn|bend|section)s?|curve veloci|alta velocit|"
                  r"schnelle(n)? kurve", re.I)
SLOW = re.compile(r"\b(slow|low[- ]speed|tight) (corner|turn|bend|section)s?|hairpin|curve lente|tornant|"
                  r"bassa velocit|langsame(n)? kurve|haarnadel", re.I)


def _speed_of(corner: str | None, corners: list[dict]) -> str | None:
    if not corner:
        return None
    code = corner.strip().upper()
    hit = next((c for c in corners if code == c["code"].upper() or code in _codes(c["code"])), None)
    return hit.get("speed") if hit else None


def driver_observations(points: list[models.DebriefPoint], corners: list[dict] | None = None
                        ) -> tuple[list[Observation], list[dict]]:
    """Observations from debrief points, and the points that were not used (with why).

    corners: the session's corners with their speed range ([{"code", "speed"}], from the run summary), so a remark
    about T6 counts as a slow-corner one.
    """
    used, skipped = [], []
    for p in points:
        claim = read_claim(p.text, p.phase.value if p.phase else None)
        kind = claim.kind
        if kind == "abs":
            kind = "lock_up"
        if kind not in KINDS and RIDE.search(p.text):
            kind = "ride"
        if kind not in KINDS:
            skipped.append({"id": p.id, "text": p.text, "why": "not about balance, traction, braking or ride"})
            continue
        if claim.negated:
            skipped.append({"id": p.id, "text": p.text, "why": "says the car does not do it"})
            continue
        phase = {"traction": "exit", "lock_up": "braking", "braking_stability": "braking"}.get(kind, claim.phase)
        corner = p.corner_code or corner_in_text(p.text)  # "turn 4" in a typed point without a corner tag
        speed = _speed_of(corner, corners or [])
        if speed is None and not corner:
            speed = "fast" if FAST.search(p.text) else "slow" if SLOW.search(p.text) else None
        used.append(Observation(kind=kind, phase=phase, corner=corner, speed=speed,
                                weight=1.5 if p.section == "priorities" else 1.0, source="driver", text=p.text,
                                ref={"debrief_point_id": p.id, "debrief_id": p.debrief_id}))
    return _cap_repeats(used), skipped


def _cap_repeats(obs: list[Observation], cap: float = 1.5) -> list[Observation]:
    """The same symptom at the same corner said again counts, but no more than cap in all (one driver saying it
    three times is not three drivers)."""
    total: dict[tuple, float] = {}
    for o in obs:
        key = (o.source, o.symptom, o.corner, o.speed)
        o.weight = max(0.0, min(o.weight, cap - total.get(key, 0.0)))
        total[key] = total.get(key, 0.0) + o.weight
    return [o for o in obs if o.weight > 0]


# ---------- levers ----------

@dataclass(frozen=True)
class Target:
    row: str
    want: str  # softer, stiffer, more downforce, higher, more negative, ... (see templates.OPPOSITE)
    amount: float = 1.0  # steps for a position or option; units for a number; a fraction when percent
    positions: tuple[str, ...] = ()  # () = all of the row's positions
    percent: bool = False
    phrase: str = ""  # how to say the change when the sheet has no value yet ("0.5 % further forward")


@dataclass(frozen=True)
class Lever:
    key: str
    title: str
    options: tuple[tuple[Target, ...], ...]  # alternatives, first that fits the sheet and its limits
    effects: dict[str, float]  # symptom -> how much it helps (+) or makes it worse (-), about -2..2
    kind: str = "mechanical"  # mechanical, aero, damper, alignment, brakes, electronics
    effort: float = 1.0  # quick to change = 1.0; springs off the car = 0.5
    expected: str = ""
    cost: str = ""
    model: str | None = None  # the vehicle model field it maps to (anti-roll bar settings)


def _t(*targets: Target) -> tuple[tuple[Target, ...], ...]:
    return (targets,)


FRONT, REAR = ("front",), ("rear",)
FRONTS, REARS = ("fl", "fr"), ("rl", "rr")

LEVERS: tuple[Lever, ...] = (
    Lever("arb_front_softer", "Front anti-roll bar softer", _t(Target("arb", "softer", 1, FRONT)),
          {"understeer_mid": 2, "understeer_exit": 1.5, "understeer_entry": 1, "oversteer_mid": -1.5,
           "oversteer_exit": -1, "oversteer_entry": -0.5},
          expected="Less roll stiffness at the front, so the front tyres share the cornering load better: more "
                   "front grip in steady cornering, less understeer mid-corner and on exit.",
          model="arb_front_setting"),
    Lever("arb_front_stiffer", "Front anti-roll bar stiffer", _t(Target("arb", "stiffer", 1, FRONT)),
          {"oversteer_mid": 2, "oversteer_exit": 1, "oversteer_entry": 1, "understeer_mid": -1.5,
           "understeer_exit": -1, "understeer_entry": -0.5},
          expected="More of the roll stiffness at the front: the rear gains grip against the front, which calms "
                   "mid-corner and exit oversteer.", model="arb_front_setting"),
    Lever("arb_rear_stiffer", "Rear anti-roll bar stiffer", _t(Target("arb", "stiffer", 1, REAR)),
          {"understeer_mid": 2, "understeer_exit": 1, "understeer_entry": 1, "oversteer_mid": -1.5,
           "oversteer_exit": -2, "traction": -1.5},
          expected="More of the roll stiffness at the rear: the car rotates more mid-corner.",
          cost="Costs some traction on exit, as the inside rear unloads more.", model="arb_rear_setting"),
    Lever("arb_rear_softer", "Rear anti-roll bar softer", _t(Target("arb", "softer", 1, REAR)),
          {"oversteer_mid": 2, "oversteer_exit": 2, "traction": 1.5, "oversteer_entry": 0.5, "understeer_mid": -1.5,
           "understeer_exit": -1},
          expected="Less roll stiffness at the rear: the rear tyres share the load better, so more rear grip "
                   "mid-corner and better traction on exit.", model="arb_rear_setting"),
    Lever("wing_more", "Rear wing up (more downforce)", _t(Target("wing", "more downforce", 1)),
          {"oversteer_mid": 2, "oversteer_exit": 1.5, "oversteer_entry": 1.5, "braking_stability": 1,
           "understeer_mid": -1.5, "understeer_entry": -1, "understeer_exit": -1},
          kind="aero", expected="More rear downforce: a more planted rear in fast corners and when braking from "
                                "high speed.", cost="More drag: slower on the straights."),
    Lever("wing_less", "Rear wing down (less downforce)", _t(Target("wing", "less downforce", 1)),
          {"understeer_mid": 2, "understeer_entry": 1.5, "understeer_exit": 1.5, "oversteer_mid": -1.5,
           "oversteer_exit": -1.5, "oversteer_entry": -1.5, "braking_stability": -0.5},
          kind="aero", expected="Less rear downforce moves the balance forward in fast corners, and the car is "
                                "quicker on the straights.", cost="A lighter rear in fast corners."),
    Lever("rake_more", "More rake", (
        (Target("ride_height", "higher", 2, REAR),), (Target("ride_height", "lower", 2, FRONT),)),
          {"understeer_mid": 1.5, "understeer_entry": 1, "understeer_exit": 1, "oversteer_mid": -1,
           "oversteer_exit": -1, "oversteer_entry": -1},
          kind="aero", effort=0.6, expected="More rake moves the aero balance forward: less understeer in fast "
                                            "corners.",
          cost="Measure the ride heights against the BoP minimums after the change."),
    Lever("rake_less", "Less rake", (
        (Target("ride_height", "lower", 2, REAR),), (Target("ride_height", "higher", 2, FRONT),)),
          {"oversteer_mid": 1.5, "oversteer_entry": 1, "oversteer_exit": 1, "understeer_mid": -1,
           "understeer_entry": -1, "understeer_exit": -1},
          kind="aero", effort=0.6, expected="Less rake moves the aero balance rearward: a steadier rear in fast "
                                            "corners.",
          cost="Measure the ride heights against the BoP minimums after the change."),
    Lever("bump_front_softer", "Front bump softer", _t(Target("bump", "softer", 2, FRONTS)),
          {"understeer_entry": 1.5, "ride": 1, "oversteer_entry": -1},
          kind="damper", effort=0.8, expected="The front takes load more gently as the car dives and rolls into the "
                                              "corner: less entry understeer, and the front rides kerbs better."),
    Lever("bump_front_stiffer", "Front bump stiffer", _t(Target("bump", "stiffer", 2, FRONTS)),
          {"oversteer_entry": 1.5, "braking_stability": 0.5, "understeer_entry": -1, "ride": -1},
          kind="damper", effort=0.8, expected="Slows the dive and roll at the front on entry, so the front takes more "
                                              "of the transfer: a calmer rear at turn-in.",
          cost="Harsher over kerbs."),
    Lever("rebound_rear_stiffer", "Rear rebound stiffer", _t(Target("rebound", "stiffer", 2, REARS)),
          {"understeer_entry": 1.5, "oversteer_entry": -1.5, "braking_stability": -1},
          kind="damper", effort=0.8, expected="The rear rises more slowly as the car pitches forward and rolls: it "
                                              "rotates more on entry."),
    Lever("rebound_rear_softer", "Rear rebound softer", _t(Target("rebound", "softer", 2, REARS)),
          {"oversteer_entry": 1.5, "braking_stability": 1.5, "understeer_entry": -1},
          kind="damper", effort=0.8, expected="The rear extends more freely under braking and at turn-in, keeping "
                                              "load on the rear tyres: a steadier rear into the corner."),
    Lever("bump_rear_softer", "Rear bump softer", _t(Target("bump", "softer", 2, REARS)),
          {"traction": 1.5, "oversteer_exit": 1, "ride": 1, "understeer_exit": -0.5},
          kind="damper", effort=0.8, expected="The rear squats more gently on the throttle and follows bumps "
                                              "better: better traction on exit."),
    Lever("rebound_front_softer", "Front rebound softer", _t(Target("rebound", "softer", 2, FRONTS)),
          {"understeer_exit": 1, "oversteer_exit": -0.5},
          kind="damper", effort=0.8, expected="The front rises more freely on the throttle while the front tyres "
                                              "keep their load: less exit understeer."),
    Lever("brake_balance_front", "Brake balance forward",
          _t(Target("brake_balance", "more front", 0.5, phrase="0.5 % further forward")),
          {"braking_stability": 2, "oversteer_entry": 0.5, "lock_up": -1, "understeer_entry": -1},
          kind="brakes", expected="More of the braking on the front: a steadier rear under braking and into the "
                                  "corner.", cost="The fronts lock earlier and the car pushes more on the brakes."),
    Lever("brake_balance_rear", "Brake balance rearward",
          _t(Target("brake_balance", "more rear", 0.5, phrase="0.5 % further rearward")),
          {"lock_up": 2, "understeer_entry": 1, "braking_stability": -1.5},
          kind="brakes", expected="Less of the braking on the front: fewer front lock-ups and more rotation on the "
                                  "brakes.", cost="The rear gets lighter under braking."),
    Lever("abs_more", "ABS one step more", _t(Target("abs", "more intervention", 1)),
          {"lock_up": 1.5, "braking_stability": 1},
          kind="electronics", expected="ABS steps in earlier: fewer lock-ups and a steadier car on the brakes.",
          cost="If it regulates too early, the stops get longer."),
    Lever("tc_more", "TC one step more", _t(Target("tc", "more intervention", 1)),
          {"traction": 1.5, "oversteer_exit": 0.5},
          kind="electronics", expected="TC trims wheelspin earlier on exit.",
          cost="Too much TC cuts the drive out of slow corners: check how long it works in the data."),
    Lever("toe_rear_in", "More rear toe-in", _t(Target("toe", "more toe-in", 0.5, REARS)),
          {"oversteer_entry": 1, "oversteer_exit": 1, "traction": 0.5, "braking_stability": 1,
           "understeer_mid": -1},
          kind="alignment", effort=0.6, expected="Steadies the rear on entry, under braking and on the throttle.",
          cost="More understeer mid-corner, and some drag and rear tyre temperature."),
    Lever("toe_front_out", "More front toe-out", _t(Target("toe", "more toe-out", 0.5, FRONTS)),
          {"understeer_entry": 1},
          kind="alignment", effort=0.6, expected="A sharper response at turn-in.",
          cost="Less straight-line stability and more front tyre temperature."),
    Lever("camber_front_more", "More front negative camber", _t(Target("camber", "more negative", 0.2, FRONTS)),
          {"understeer_mid": 1, "understeer_entry": 0.5},
          kind="alignment", effort=0.6, expected="More front grip in long corners, if the front tyres run hot on the "
                                                 "inside less than on the outside.",
          cost="Check the pyrometer spread first (Tyre temperatures tool); it costs some braking grip."),
    Lever("camber_rear_more", "More rear negative camber", _t(Target("camber", "more negative", 0.2, REARS)),
          {"oversteer_mid": 1, "traction": -0.5},
          kind="alignment", effort=0.6, expected="More rear grip mid-corner, if the rear tyres run cool on the inside.",
          cost="Less traction in a straight line; check the pyrometer spread first."),
    Lever("spring_front_softer", "Softer front springs", (
        (Target("spring", "softer", 1, FRONT),), (Target("spring_rate", "softer", 0.1, FRONT, percent=True),)),
          {"understeer_mid": 1, "understeer_entry": 0.5, "ride": 1, "oversteer_mid": -1},
          effort=0.5, expected="The front works better over bumps and in roll: more front grip in slow corners.",
          cost="A bigger job (springs off the car), and the front sits lower at speed."),
    Lever("spring_front_stiffer", "Stiffer front springs", (
        (Target("spring", "stiffer", 1, FRONT),), (Target("spring_rate", "stiffer", 0.1, FRONT, percent=True),)),
          {"oversteer_mid": 1, "understeer_mid": -1, "ride": -1},
          effort=0.5, expected="More of the roll stiffness at the front and a steadier aero platform.",
          cost="A bigger job (springs off the car); harsher over kerbs."),
    Lever("spring_rear_softer", "Softer rear springs", (
        (Target("spring", "softer", 1, REAR),), (Target("spring_rate", "softer", 0.1, REAR, percent=True),)),
          {"traction": 1.5, "oversteer_mid": 1, "oversteer_exit": 1, "ride": 0.5, "understeer_mid": -1},
          effort=0.5, expected="A softer rear puts the power down better and gives more rear grip.",
          cost="A bigger job (springs off the car); more squat changes the rake on the throttle."),
    Lever("spring_rear_stiffer", "Stiffer rear springs", (
        (Target("spring", "stiffer", 1, REAR),), (Target("spring_rate", "stiffer", 0.1, REAR, percent=True),)),
          {"understeer_mid": 1, "oversteer_mid": -1, "traction": -1},
          effort=0.5, expected="More of the roll stiffness at the rear: the car rotates more.",
          cost="A bigger job (springs off the car), and less traction."),
    Lever("ride_height_up", "Ride height up", _t(Target("ride_height", "higher", 2)),
          {"ride": 1.5},
          effort=0.6, expected="More clearance over kerbs and bumps.",
          cost="Raises the centre of gravity and changes the aero."),
)

# The balance report's recommendation keys (app.analysis.setup_advice) and the levers that make the same change,
# the first one the sheet can take
ADVICE_LEVERS: dict[str, tuple[str, ...]] = {
    "rear_bar_softer": ("arb_rear_softer",),
    "rear_bar_stiffer": ("arb_rear_stiffer",),
    "front_bar_softer": ("arb_front_softer",),
    "rear_bump_softer": ("bump_rear_softer",),
    "rear_wing": ("wing_more",),
    "aero_rear": ("wing_more", "rake_less"),
    "aero_front": ("wing_less", "rake_more"),
    "brake_bias_rear": ("brake_balance_rear",),
    "brake_bias_front": ("brake_balance_front",),
    "front_grip_slow": ("camber_front_more", "toe_front_out"),
}
# Levers that move one balance either way: the roll stiffness (and so the load transfer) to the front or the rear,
# the aero balance forward or rearward, the brake balance, one damper setting. Two levers on the same axis with
# opposite signs work against each other: a softer front bar undoes a softer rear bar.
DIRECTION: dict[str, tuple[str, int]] = {
    **{k: ("roll", 1) for k in ("arb_front_stiffer", "arb_rear_softer", "spring_front_stiffer", "spring_rear_softer")},
    **{k: ("roll", -1) for k in ("arb_front_softer", "arb_rear_stiffer", "spring_front_softer", "spring_rear_stiffer")},
    "wing_less": ("aero", 1), "rake_more": ("aero", 1), "wing_more": ("aero", -1), "rake_less": ("aero", -1),
    "brake_balance_front": ("brakes", 1), "brake_balance_rear": ("brakes", -1),
    "bump_front_stiffer": ("bump_front", 1), "bump_front_softer": ("bump_front", -1),
    "rebound_rear_stiffer": ("rebound_rear", 1), "rebound_rear_softer": ("rebound_rear", -1),
}
AXIS = {"roll": "moves the roll stiffness the other way", "aero": "moves the aero balance the other way",
        "brakes": "moves the brake balance the other way"}


def against(a: str, b: str) -> bool:
    """The two levers work against each other."""
    da, db = DIRECTION.get(a), DIRECTION.get(b)
    return da is not None and db is not None and da[0] == db[0] and da[1] != db[1]


# How much a lever does at each corner speed: aero needs speed, bars and springs matter most in slow corners.
SPEED_FACTOR = {"aero": {"slow": 0.1, "medium": 0.5, "fast": 1.0, None: 0.5},
                "mechanical": {"slow": 1.0, "medium": 1.0, "fast": 0.7, None: 1.0}}
MIN_HELP = 0.75  # a lever must answer at least this much (one clear remark with a strong effect) to be listed
SHOWN = 0.4  # an observation is named as a reason (or a risk) when it counts at least this much for the lever
BOTH_SOURCES = 1.25  # driver and data agree
DISPUTED = 0.6  # driver and data point different ways: what both agree on goes first
ADVICE_SCORE, ADVICE_DECAY = 2.5, 0.8  # the balance report's first change, and each later one by this much less


def _sign(row: Row, want: str) -> int | None:
    if row.up == want:
        return 1
    if row.up is not None and OPPOSITE.get(want) == row.up:
        return -1
    return None


def _apply(template: Template, values: dict, targets: tuple[Target, ...]) -> list[dict] | None:
    """The field changes for one way of making the lever's change, or None when the sheet can't take it (no such
    row, or a step past the car's positions or its limits)."""
    changes = []
    for t in targets:
        row = template.rows.get(t.row)
        sign = _sign(row, t.want) if row else None
        if row is None or sign is None:
            return None
        for p in t.positions or row.positions:
            if p not in row.positions:
                return None
            key = row.field_key(p)
            cur = values.get(key)
            new = None
            if cur is not None:
                new = cur * (1 + sign * t.amount) if t.percent else cur + sign * t.amount
                new = round(new, 3)
                if row.kind == "choice" and new not in {o for o, _ in row.options}:
                    return None
                if (row.min is not None and new < row.min) or (row.max is not None and new > row.max):
                    return None
                lim = row.limit_for(p)  # never further past a BoP minimum or a tyre maker's limit
                if lim and ((lim.low is not None and new < lim.low and new < cur) or
                            (lim.high is not None and new > lim.high and new > cur)):
                    return None
            changes.append({"key": key, "label": row.field_label(p), "unit": row.unit, "from": cur, "to": new,
                            "text": _change_text(row, p, cur, new, t)})
    return changes


def _change_text(row: Row, p: str, cur, new, t: Target) -> str:
    label = row.field_label(p)
    unit = f" {row.unit}" if row.kind == "number" and row.unit else ""
    if cur is not None:
        return f"{label} {format_value(row, cur)} → {format_value(row, new)}{unit}"
    if t.phrase:
        return f"{label}: {t.phrase}"
    if t.percent:
        return f"{label}: {t.amount * 100:.0f} % {t.want}"
    steps = {"position": "position", "choice": "option"}.get(row.kind)
    if steps:
        size = "one " + steps if t.amount == 1 else f"{t.amount:g} {steps}s"
    else:
        size = f"{t.amount:g}{'' if row.unit in ('°', '%') else ' '}{row.unit}".strip()
    return f"{label}: {size} {t.want}"


def _where(obs: list[Observation]) -> str:
    """'understeer mid-corner at T6, T8/T9 (driver, 2 points)'."""
    groups: dict[tuple, list[Observation]] = {}
    for o in obs:
        groups.setdefault((o.kind, o.phase if o.kind in ("understeer", "oversteer") else None), []).append(o)
    parts = []
    for (kind, phase), os_ in groups.items():
        what = KIND_LABEL.get(kind, kind) + (f" {PHASE_LABEL[phase]}" if phase in PHASE_LABEL else "")
        corners = list(dict.fromkeys(o.corner for o in os_ if o.corner))
        speeds = list(dict.fromkeys(o.speed for o in os_ if not o.corner and o.speed))
        where = f" at {', '.join(corners)}" if corners else ""
        if speeds:
            where += f"{' and' if where else ''} in {' and '.join(speeds)} corners"
        sources = []
        for src in ("driver", "data"):
            n = sum(1 for o in os_ if o.source == src)
            if n:
                stake = sum(o.time_s or 0 for o in os_ if o.source == src)
                sources.append(f"{src}" + (f", {n} points" if src == "driver" and n > 1 else "")
                               + (f", {stake:.2f} s" if src == "data" and stake else ""))
        parts.append(f"{what}{where} ({'; '.join(sources)})")
    return "; ".join(parts)


def _model_effect(lever: Lever, vehicle: Vehicle | None, changes: list[dict], template: Template) -> str | None:
    """The vehicle model's shift in the front share of lateral load transfer for a bar change."""
    if lever.model is None or vehicle is None or not changes:
        return None
    axle = "front" if "front" in lever.model else "rear"
    rates = getattr(vehicle, f"arb_{axle}_settings_n_per_mm")
    cur = changes[0]["from"]
    note = ""
    if cur is None:
        cur = getattr(vehicle, f"arb_{axle}_setting")
        note = " (from the preset's middle position, as the sheet has none)"
    if not rates or cur is None:
        return None
    row = template.rows["arb"]
    sign = _sign(row, lever.options[0][0].want)
    new = int(cur) + (sign or 0)
    if not 1 <= new <= len(rates):
        return None
    try:
        base = Vehicle.model_validate({**vehicle.model_dump(), f"arb_{axle}_setting": int(cur)})
        r = what_if(base, [Change(field=lever.model, set=new)])
    except ValueError:
        return None
    x = r["baseline"]["lateral_load_transfer_front_share"] * 100
    y = r["changed"]["lateral_load_transfer_front_share"] * 100
    return (f"Vehicle model, with its estimated bar rates{note}: front share of the lateral load transfer "
            f"{x:.1f} % → {y:.1f} %.")


def _applicable(template: Template, values: dict) -> dict[str, list[dict]]:
    """Each lever's field changes on this sheet, for the levers the sheet can take."""
    out = {}
    for lever in LEVERS:
        changes = next((c for c in (_apply(template, values, opt) for opt in lever.options) if c is not None), None)
        if changes is not None:
            out[lever.key] = changes
    return out


def _contribution(lever: Lever, o: Observation) -> float:
    return o.weight * lever.effects.get(o.symptom, 0.0) * SPEED_FACTOR.get(lever.kind, {}).get(o.speed, 1.0)


def suggest(template: Template, values: dict, observations: list[Observation], vehicle: Vehicle | None = None,
            limit: int = 8, advice: list[dict] | None = None, measured: list[Observation] | None = None) -> dict:
    """Ranked setup changes on this car's sheet with these values, from both sides.

    observations: the driver's remarks (each with its check against the data) and any data source's observations;
        they score the levers.
    advice: the balance report's recommendations, best first. Each maps onto a lever (ADVICE_LEVERS) and scores it
        by its rank.
    measured: what the run's data shows (app.setup.data.measured). It scores nothing by itself; a lever it backs
        counts as backed by the data.
    Returns {"suggestions": [...], "notes": [...]}.
    """
    applicable = _applicable(template, values)
    advice, measured = advice or [], measured or []
    notes = []
    by_lever: dict[str, tuple[int, dict]] = {}
    for i, rec in enumerate(advice):
        key = next((k for k in ADVICE_LEVERS.get(rec["key"], ()) if k in applicable), None)
        if key is None:
            notes.append(f"The balance report also suggests: {rec['title']}. The sheet can't take it as it stands "
                         "(no such setting on this car, or it is at its end).")
        elif key not in by_lever:
            by_lever[key] = (i, rec)
    titles = {lv.key: lv.title for lv in LEVERS}
    driver_backed = {lv.key for lv in LEVERS if lv.key in applicable and sum(
        max(_contribution(lv, o), 0.0) for o in observations if o.source == "driver") >= MIN_HELP}

    out = []
    for lever in LEVERS:
        changes = applicable.get(lever.key)
        if changes is None:
            continue
        helps, hurts, score, helped = [], [], 0.0, 0.0
        for o in observations:
            c = _contribution(lever, o)
            score += c
            helped += max(c, 0.0)
            if c >= SHOWN:
                helps.append(o)
            elif c <= -SHOWN:
                hurts.append(o)
        hit = by_lever.get(lever.key)
        if hit is None and (helped < MIN_HELP or score <= 0):
            continue
        if hit is None:
            score *= lever.effort
        else:  # the report has weighed its change, side effects too: remarks against it are shown, not summed
            score = helped * lever.effort + ADVICE_SCORE * ADVICE_DECAY ** hit[0]
        driver = [o for o in helps if o.source == "driver"]
        shows = [m for m in measured if _contribution(lever, m) >= SHOWN]
        confirmed = [o for o in driver if (o.check or {}).get("verdict") == "agree"]
        data_backed = bool(hit or shows or confirmed or any(o.source == "data" for o in helps))

        disagree = [f"The driver said {o.describe()}, but the data reads {o.check['reads']} "
                    f"({o.check['where']})." for o in driver if (o.check or {}).get("verdict") == "disagree"]
        for key, (_, rec) in by_lever.items():
            if against(lever.key, key):
                disagree.append(f"The balance report {AXIS.get(DIRECTION[key][0], 'goes the other way')}: "
                                f"{rec['title']}.")
        named = []  # the driver's remarks named as the disagreement, so not again under watch
        if hit is not None and any(against(lever.key, k) for k in driver_backed):
            named = [o for o in hurts if o.source == "driver"]
            disagree.append("The driver's feedback points the other way: " + (
                _where(named) if named else next(titles[k] for k in driver_backed if against(lever.key, k))) + ".")
        if disagree:
            agreement = "disagree"
            score *= DISPUTED
        elif driver and data_backed:
            agreement = "both"
            score *= BOTH_SOURCES
        else:
            agreement = "driver" if driver else "data"
        score = max(score, 0.05)

        watch = []
        if hit is not None and hit[1].get("watch"):
            watch.append(hit[1]["watch"])
        rest = [o for o in hurts if o not in named]
        if rest:
            watch.append(f"It can make this worse: {_where(rest)}.")
        if lever.cost:
            watch.append(lever.cost)
        out.append({
            "lever": lever.key, "title": lever.title, "kind": lever.kind, "changes": changes,
            "reason": _where(helps), "data_shows": _where(shows) if shows else None,
            "confirmed": [o.check["text"] for o in confirmed],
            "report": {"rank": hit[0] + 1, **{k: hit[1].get(k) for k in ("key", "title", "why", "expect")}}
            if hit is not None else None,
            "expected": hit[1]["expect"] if hit is not None else lever.expected,
            "model": _model_effect(lever, vehicle, changes, template), "watch": " ".join(watch),
            "agreement": agreement, "disagree": disagree,
            "sources": [x for x, on in (("driver", bool(driver)), ("data", data_backed)) if on],
            "score": round(score, 2), "addresses": [o.ref for o in helps if o.ref]})
    out.sort(key=lambda x: -x["score"])
    for i, x in enumerate(out[:limit]):
        x["rank"] = i + 1
    return {"suggestions": out[:limit], "notes": notes}


def observation_dict(o: Observation) -> dict:
    return {**asdict(o), "symptom": o.symptom, "label": o.describe()}
