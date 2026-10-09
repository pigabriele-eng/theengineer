"""Setup sheet templates: what can be set on a car, in its own positions and units, and where that comes from.

A template is groups of rows. A row is one adjustment (the rear wing, the anti-roll bars, the bump clicks), set once
(single), per axle (front, rear) or per corner (FL, FR, RL, RR); each of those is one field in the stored values,
named row key + position (arb_front, bump_rl). Every row says what a higher number means (stiffer, softer, more
downforce...), so the suggestions can turn "softer" into a step up or down on any car.

The BMW M4 GT4 EVO (G82) template follows the car research file (reference/bmw-m4-gt4-evo/car.json and car.md,
compiled 2026-10-05): 5-position anti-roll bars front and rear, the three H&R spring options, KW 2-way dampers (bump
and rebound clicks), ride heights against the BoP minimums, camber and toe, the 6-position rear wing, TC (10 steps)
and ABS, cold pressures, fuel and ballast. Where a convention is not public (which end of the wing is most
downforce, which way the bar positions go), the row's note says what this sheet assumes, so it can be checked on
the car. Another car gets its own template in TEMPLATES; "generic" works for any car with plain numbers.
"""
from __future__ import annotations

from dataclasses import dataclass, field

AXLES = ("front", "rear")
CORNERS = ("fl", "fr", "rl", "rr")
POSITION_LABEL = {"front": "front", "rear": "rear", "fl": "FL", "fr": "FR", "rl": "RL", "rr": "RR"}
AXLE_OF = {"front": "front", "rear": "rear", "fl": "front", "fr": "front", "rl": "rear", "rr": "rear"}
OPPOSITE = {"stiffer": "softer", "softer": "stiffer", "more downforce": "less downforce",
            "less downforce": "more downforce", "more intervention": "less intervention",
            "less intervention": "more intervention", "higher": "lower", "lower": "higher",
            "more positive": "more negative", "more negative": "more positive", "more toe-in": "more toe-out",
            "more toe-out": "more toe-in", "more front": "more rear", "more rear": "more front", "more": "less",
            "less": "more"}


@dataclass(frozen=True)
class Limit:
    """A value outside this is flagged on the sheet (never refused): a BoP minimum, a tyre maker's limit."""
    low: float | None = None
    high: float | None = None
    message: str = ""


@dataclass(frozen=True)
class Row:
    key: str
    label: str
    unit: str = ""
    layout: str = "single"  # single, axle (front, rear) or corner (fl, fr, rl, rr)
    kind: str = "number"  # number, position (whole steps from min to max) or choice (one of options)
    min: float | None = None
    max: float | None = None
    step: float = 1.0  # the input's step; also the size of one suggested change for a number
    options: tuple[tuple[int, str], ...] = ()  # choice: (value, label)
    up: str | None = None  # what a higher number means: stiffer, softer, more downforce, ...
    note: str = ""  # where the row comes from and what the sheet assumes
    confidence: str = "published"  # published, estimate or unknown, as in the car research file
    limits: dict[str, Limit] = field(default_factory=dict)  # by position, axle or "" for every field

    @property
    def positions(self) -> tuple[str, ...]:
        return {"single": ("",), "axle": AXLES, "corner": CORNERS}[self.layout]

    def field_key(self, position: str) -> str:
        return f"{self.key}_{position}" if position else self.key

    def field_label(self, position: str) -> str:
        return f"{self.label} {POSITION_LABEL[position]}" if position else self.label

    def limit_for(self, position: str) -> Limit | None:
        return self.limits.get(position) or self.limits.get(AXLE_OF.get(position, "")) or self.limits.get("")

    def to_dict(self) -> dict:
        return {
            "key": self.key, "label": self.label, "unit": self.unit, "layout": self.layout, "kind": self.kind,
            "min": self.min, "max": self.max, "step": self.step,
            "options": [{"value": v, "label": label} for v, label in self.options],
            "up": self.up, "note": self.note, "confidence": self.confidence,
            "fields": [{"key": self.field_key(p), "at": p or None} for p in self.positions],
        }


@dataclass(frozen=True)
class Template:
    key: str
    name: str
    groups: tuple[tuple[str, tuple[Row, ...]], ...]
    vehicle_preset: str | None = None  # the vehicle model preset this car starts from (vehicle/presets.py)
    match: tuple[str, ...] = ()  # words in a car's name that pick this template

    @property
    def rows(self) -> dict[str, Row]:
        return {r.key: r for _, rows in self.groups for r in rows}

    def fields(self) -> dict[str, tuple[Row, str]]:
        """Every stored field: key -> (its row, its position)."""
        return {r.field_key(p): (r, p) for r in self.rows.values() for p in r.positions}

    def to_dict(self) -> dict:
        return {"key": self.key, "name": self.name, "vehicle_preset": self.vehicle_preset,
                "groups": [{"name": name, "rows": [r.to_dict() for r in rows]} for name, rows in self.groups]}


SIM_ONLY = "the iRacing manual (a sim model, not BMW data)"

BMW_M4_GT4_EVO = Template(
    key="bmw-m4-gt4-evo",
    name="BMW M4 GT4 EVO (G82)",
    vehicle_preset="bmw-m4-gt4-evo",
    match=("m4 gt4", "g82"),
    groups=(
        ("Aero", (
            Row("wing", "Rear wing", "position", kind="position", min=1, max=6, up="more downforce",
                note="6 settings (dealer listing, a secondary source). Which end gives the most downforce is not "
                     "public: this sheet takes 6 as the most. Check it on the car."),
        )),
        ("Anti-roll bars", (
            Row("arb", "Anti-roll bar", "position", layout="axle", kind="position", min=1, max=5, up="stiffer",
                note="5 positions front and rear (BMW). The rates are not public. 1 = softest, as in "
                     f"{SIM_ONLY}; check it on the car."),
        )),
        ("Springs", (
            Row("spring", "Spring", layout="axle", kind="choice", options=((1, "Soft"), (2, "Medium"), (3, "Stiff")),
                up="stiffer", note="H&R springs in three rates (BMW). The rates themselves are not public."),
            Row("spring_rate", "Spring rate", "N/mm", layout="axle", min=0, step=10, up="stiffer",
                confidence="unknown",
                note="The rate stamped on the spring, if you know it. The vehicle model uses it in place of its "
                     "estimate."),
        )),
        ("Dampers (KW 2-way)", (
            Row("bump", "Bump", "clicks", layout="corner", min=0, max=18, up="softer",
                note="Clicks open from fully closed, so more clicks is softer. The click range is not public; "
                     f"{SIM_ONLY} has 19 positions."),
            Row("rebound", "Rebound", "clicks", layout="corner", min=0, max=18, up="softer",
                note="Clicks open from fully closed, so more clicks is softer."),
        )),
        ("Ride height", (
            Row("ride_height", "Ride height", "mm", layout="axle", step=1, up="higher",
                note="At the homologated reference points, without driver and fuel. BoP minimum on the 2024-25 "
                     "sheets: 138.9 + 16.1 = 155.0 mm front, 149.5 + 10.5 = 160.0 mm rear.",
                limits={"front": Limit(low=155.0, message="below the BoP minimum of 155.0 mm (2024-25 sheets)"),
                        "rear": Limit(low=160.0, message="below the BoP minimum of 160.0 mm (2024-25 sheets)")}),
        )),
        ("Alignment", (
            Row("camber", "Camber", "°", layout="corner", step=0.1, up="more positive",
                note="Static, negative is top in. Set with shims. Pirelli's maximum static camber for GT4 "
                     "(older P_Books): -3.5° front, -3.0° rear.",
                limits={"front": Limit(low=-3.5, message="more negative than Pirelli's -3.5° maximum for the front"),
                        "rear": Limit(low=-3.0, message="more negative than Pirelli's -3.0° maximum for the rear")}),
            Row("toe", "Toe", "mm", layout="corner", step=0.5, up="more toe-in",
                note="Per wheel, + toe-in, - toe-out. Set with shims at the rear. The ranges are not public."),
        )),
        ("Brakes and electronics", (
            Row("brake_balance", "Brake balance", "% front", step=0.5, up="more front",
                note="Manual, on the AP Racing pedal box. The range is not public."),
            Row("tc", "TC", "position", kind="position", min=1, max=10, up="more intervention",
                note="10 steps (BMW). Higher = earlier and more intervention, on the EVO and the earlier car alike "
                     "(Gabriele, 2026-10-09). The EVO adds a TC override button for kerbs: in the logs, one press "
                     "switches TC off for about 10 s."),
            Row("abs", "ABS", "position", kind="position", min=0, up="more intervention", confidence="unknown",
                note="Adjustable, but the steps are not public. This sheet takes a higher number as more "
                     "intervention: check it on the car."),
        )),
        ("Tyres", (
            Row("pressure_cold", "Cold pressure", "bar", layout="corner", min=0, step=0.05, up="higher",
                note="Gauge, set cold. Pirelli's minimum inflation pressure is 1.4 bar in the older GT4 P_Books; "
                     "the 2025 P_Book is issued to teams. The pressure calculator works out cold for a hot target.",
                limits={"": Limit(low=1.4, message="below Pirelli's 1.4 bar minimum (older GT4 P_Books)")}),
        )),
        ("Fuel and ballast", (
            Row("fuel", "Fuel", "L", min=0, max=120, step=1, up="more",
                note="At the start of the run. ATL cell of about 120 L.",
                limits={"": Limit(high=120.0, message="more than the cell holds (about 120 L)")}),
            Row("ballast", "Ballast", "kg", min=0, step=5, up="more",
                note="BoP and success ballast on top of the 1480 kg SRO minimum (without driver and fuel)."),
        )),
    ),
)

GENERIC = Template(
    key="generic",
    name="Any car (plain numbers)",
    groups=(
        ("Aero", (Row("wing", "Rear wing", "position", up="more downforce",
                      note="Higher = more downforce on this sheet."),)),
        ("Anti-roll bars", (Row("arb", "Anti-roll bar", "position", layout="axle", up="stiffer",
                                note="Higher = stiffer on this sheet."),)),
        ("Springs", (Row("spring_rate", "Spring rate", "N/mm", layout="axle", min=0, step=10, up="stiffer"),)),
        ("Dampers", (
            Row("bump", "Bump", "clicks", layout="corner", min=0, up="softer",
                note="Clicks open from fully closed: more clicks is softer."),
            Row("rebound", "Rebound", "clicks", layout="corner", min=0, up="softer",
                note="Clicks open from fully closed: more clicks is softer."),
        )),
        ("Ride height", (Row("ride_height", "Ride height", "mm", layout="axle", up="higher"),)),
        ("Alignment", (
            Row("camber", "Camber", "°", layout="corner", step=0.1, up="more positive"),
            Row("toe", "Toe", "mm", layout="corner", step=0.5, up="more toe-in", note="Per wheel, + toe-in."),
        )),
        ("Brakes and electronics", (
            Row("brake_balance", "Brake balance", "% front", step=0.5, up="more front"),
            Row("tc", "TC", "position", kind="position", min=0, up="more intervention"),
            Row("abs", "ABS", "position", kind="position", min=0, up="more intervention"),
        )),
        ("Tyres", (Row("pressure_cold", "Cold pressure", "bar", layout="corner", min=0, step=0.05, up="higher"),)),
        ("Fuel and ballast", (
            Row("fuel", "Fuel", "L", min=0, up="more"),
            Row("ballast", "Ballast", "kg", min=0, step=5, up="more"),
        )),
    ),
)

TEMPLATES: dict[str, Template] = {t.key: t for t in (BMW_M4_GT4_EVO, GENERIC)}
DEFAULT_TEMPLATE = BMW_M4_GT4_EVO.key  # the car this app is run with


def template_for_car(car_name: str | None) -> str:
    """The template a car's name points to, else the default."""
    name = (car_name or "").lower()
    return next((t.key for t in TEMPLATES.values() if any(m in name for m in t.match)), DEFAULT_TEMPLATE)


class InvalidSetup(ValueError):
    pass


def clean_values(template: Template, values: dict) -> dict[str, float | int]:
    """The values as stored: known fields only, numbers only (a blank is left out), whole steps for positions
    and options. Raises InvalidSetup naming the field."""
    fields = template.fields()
    out: dict[str, float | int] = {}
    for key, v in values.items():
        if key not in fields:
            raise InvalidSetup(f"'{key}' is not on the {template.name} sheet")
        if v is None or v == "":
            continue
        row, pos = fields[key]
        if isinstance(v, bool) or not isinstance(v, int | float):
            raise InvalidSetup(f"{row.field_label(pos)} must be a number")
        if v != v or v in (float("inf"), float("-inf")):
            raise InvalidSetup(f"{row.field_label(pos)} must be a number")
        if row.kind in ("position", "choice"):
            if v != int(v):
                raise InvalidSetup(f"{row.field_label(pos)} must be a whole position")
            v = int(v)
            if row.kind == "choice" and v not in {o for o, _ in row.options}:
                raise InvalidSetup(f"{row.field_label(pos)} must be one of "
                                   + ", ".join(f"{o} ({label})" for o, label in row.options))
        out[key] = v
    return out


def warnings(template: Template, values: dict) -> list[dict]:
    """Values outside the car's positions or its limits (BoP, tyre maker): flagged, still stored."""
    out = []
    for key, (row, pos) in template.fields().items():
        v = values.get(key)
        if v is None:
            continue
        label = row.field_label(pos)
        if row.kind == "position" and ((row.min is not None and v < row.min) or (row.max is not None and v > row.max)):
            span = f"{row.min:g}-{row.max:g}" if row.max is not None else f"from {row.min:g}"
            out.append({"key": key, "text": f"{label} {v:g} is outside the car's positions ({span})"})
            continue
        lim = row.limit_for(pos)
        if lim and ((lim.low is not None and v < lim.low) or (lim.high is not None and v > lim.high)):
            out.append({"key": key, "text": f"{label} {v:g} {row.unit}: {lim.message}".replace("  ", " ")})
    return out


def format_value(row: Row, v: float | int | None) -> str:
    if v is None:
        return "not set"
    if row.kind == "choice":
        return next((label for o, label in row.options if o == v), f"{v:g}")
    return f"{v:g}"


def diff(template: Template, before: dict, after: dict) -> list[dict]:
    """The fields that differ between two setups on one template, in sheet order."""
    out = []
    for key, (row, pos) in template.fields().items():
        a, b = before.get(key), after.get(key)
        if a == b:
            continue
        delta = round(b - a, 4) if a is not None and b is not None else None
        out.append({"key": key, "row": row.key, "at": pos or None, "label": row.field_label(pos), "unit": row.unit,
                    "from": a, "to": b, "delta": delta,
                    "text": f"{row.field_label(pos)} {format_value(row, a)} → {format_value(row, b)}"
                            + (f" {row.unit}" if row.unit and row.kind == "number" else "")})
    return out
