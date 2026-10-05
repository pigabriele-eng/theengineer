"""Check what the driver said in a debrief against what the logger recorded, and suggest how to drive it.

Each debrief point is read for a claim (understeer, oversteer, traction, lock-ups, tyres...), the corner and
the phase. The data then says whether that corner really shows it, and on how many laps. Balance is the report's
(app.analysis.balance, read lap by lap in car_balance.py): the understeer angle against the car's normal
understeer at the same lateral g, read as the report reads it (from 0.3 degrees a slight understeer or oversteer).
Braking and traction are measured against the car's other corners in the same session.

A trait the data shows on almost every lap is the car (a setup item). One that comes and goes with how the corner
was driven (later braking, more speed to the apex...) is technique, and so is rear movement where the data shows
the front pushing: that is usually the driver reacting to the push.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from app.analysis.balance import Geometry, car_geometry
from app.analysis.insights import (
    CornerSpec,
    Prepared,
    RunInput,
    Section,
    _trend_rows,
    _within,
    corr,
    prepare,
    section_metrics,
)
from app.analysis.setup_advice import NOTABLE, STRENGTH, deg, describe
from app.analysis.stint import find_stops, split_stints
from app.debrief.car_balance import CORNER, SectionBalance, add_balance_channel, section_balance

NEG = re.compile(r"\b(no|not|never|without|non|senza|kein\w*|nicht|ohne)\b[\w' ]{0,20}$", re.I)
CLAIMS: list[tuple[str, re.Pattern]] = [  # first match wins, so the specific ones come first
    ("braking_stability", re.compile(r"unstable (under|on the|in|when|into) brak|moving (around )?under brak|"
                                     r"instabile in (frenata|staccata)|instabil\w* beim brems|unruhig beim brems",
                                     re.I)),
    # "lock" alone is steering lock ("more lock", "opposite lock"), not a wheel locking
    ("lock_up", re.compile(r"\block(ing|ed|s)? ?up\b|\block-?up|\blocking\b|\blocked\b|flat ?spot|bloccag|"
                           r"blocca|blockier", re.I)),
    ("abs", re.compile(r"\babs\b", re.I)),
    ("traction", re.compile(r"traction|wheel ?spin|spinning up|power down|\btc\b|trazion|pattin|slittament|"
                            r"traktion|durchdreh", re.I)),
    ("understeer", re.compile(r"under ?steer|\b(front|car|it|she)\b[\w' ]{0,12}\bpush(es|ing|ed)?\b|\bpushy\b|"
                              r"push(es|ing|ed)? wide\b|wash(es|ing)? (out|wide)|no front|lack of front|"
                              r"front (doesn'?t|does not|won'?t|didn'?t) (turn|bite)|sottosterz|non (gira|entra)|"
                              r"(anteriore|avantreno) non (gira|entra|morde)|untersteu|schiebt", re.I)),
    ("oversteer", re.compile(r"over ?steer|\bloose\b|rear (steps|stepping|comes|coming|snaps) (out|round|around)|"
                             r"\bsnap|nervous rear|rear (is |was )?(unstable|nervous|loose)|opposite lock|"
                             r"counter ?steer|sovrasterz|controsterz|(posteriore|retrotreno) (scappa|nervos|"
                             r"instabil|si muove)|übersteu|heck (kommt|bricht|unruhig)", re.I)),
    ("tyre_drop", re.compile(r"degrad|drop[- ]?off|grip (goes|going|went) away|tyres? (gone|finished)|overheat|"
                             r"\bcal(o|a|ano|ando|ate|ato)\b|gomme (finite|andate)|surriscald|abbau|nachlass|"
                             r"überhitz", re.I)),
    ("tyre_warmup", re.compile(r"cold tyres?|warm[- ]?up|to (come in|switch on)|gomme fredde|riscald|scald|"
                               r"kalte reifen|aufwärm", re.I)),
]
# "no traction" or "poca trazione" is the traction problem itself; it is denied only when traction is called good
TRACTION_NOUN = re.compile(r"traction|trazion|traktion", re.I)
TRACTION_GOOD = re.compile(r"\b(good|great|fine|ok|okay|better|improved|buona|ottima|meglio|migliorat\w*|gut|"
                           r"besser)\b", re.I)
PHASE_WORDS = [
    ("braking", re.compile(r"brak|frenat|staccat|brems", re.I)),
    ("entry", re.compile(r"entry|turn[- ]?in|ingresso|inserimento|rilascio|eingang|einlenk", re.I)),
    ("mid", re.compile(r"\bmid|apex|middle|centro|corda|percorrenza|appoggio|scheitel|mitte", re.I)),
    ("exit", re.compile(r"exit|on the way out|out of the corner|on (the )?(throttle|power)|uscita|ausgang", re.I)),
]
CORNER_IN_TEXT = re.compile(r"\b(?:t ?|turns? |curva |curve |kurve |corner )(\d{1,2})\b", re.I)
# Balance said of a kind of corner rather than one corner ("understeer in slow corners"), by speed band
SPEED_WORDS = [
    ("slow", re.compile(r"\bslow(er)?[- ](speed|corners?|turns?|bends?)|\blow[- ]speed|curve lente|"
                        r"bassa velocit|langsame\w* kurven", re.I)),
    ("fast", re.compile(r"\b(fast|quick|high[- ]speed)(er)?[- ](corners?|turns?|bends?)|\bhigh[- ]speed|"
                        r"curve veloci|alta velocit|schnelle\w* kurven", re.I)),
    ("medium", re.compile(r"\bmedium[- ]speed|curve (medie|di media)|media velocit|mittelschnelle", re.I)),
]
BANDS = {"slow", "medium", "fast"}
BAND_PHASE = {"entry": "on entry", "mid": "mid-corner", "exit": "on exit", "braking": "under braking"}

CLAIM_LABEL = {
    "understeer": "understeer", "oversteer": "oversteer", "traction": "traction / wheelspin",
    "lock_up": "locking wheels", "braking_stability": "unstable under braking", "abs": "ABS",
    "tyre_drop": "tyres dropping off", "tyre_warmup": "slow tyre warm-up",
}
SAID = {  # what the driver said, as it reads in "Said ... at T6 entry"
    "understeer": "understeer", "oversteer": "oversteer", "traction": "poor traction", "lock_up": "locking",
    "braking_stability": "instability", "abs": "a lot of ABS", "tyre_drop": "tyres dropping off",
    "tyre_warmup": "slow tyre warm-up",
}
SAID_NOT = {"traction": "good traction", "braking_stability": "a stable car"}
MORE_OF = {  # "more ... on laps where you brake later"
    "understeer": "understeer", "oversteer": "oversteer", "traction": "wheelspin", "lock_up": "front slip",
    "braking_stability": "rear movement", "abs": "ABS",
}
SUGGEST = {
    ("understeer", "entry"): "Release the brake more progressively as you turn in so the front keeps its load, "
                             "and wait for the front to bite instead of adding steering.",
    ("understeer", "mid"): "Be patient with the throttle and aim for a slightly later apex: a little less speed "
                           "at the apex costs less than a front that is pushing.",
    ("understeer", "exit"): "Unwind the steering earlier and use a straighter exit before going to full throttle.",
    ("oversteer", "entry"): "Finish the heavy braking a touch earlier and release the brake more smoothly so the "
                            "rear stays planted at turn-in.",
    ("oversteer", "mid"): "Hold a light, steady throttle through the middle of the corner to settle the rear.",
    ("oversteer", "exit"): "Squeeze the throttle in more progressively and open the steering before full throttle.",
    ("traction", None): "Squeeze the throttle in more progressively and straighten the car before full throttle; "
                        "TC trimming a little wheelspin is fine, cutting the drive is not.",
    ("lock_up", None): "Build the brake pressure a fraction more progressively and release smoothly; if it "
                       "happens in every heavy stop, look at brake balance.",
    ("braking_stability", None): "Do the heavy braking in a straight line, then trail off smoothly as you turn in.",
    ("abs", None): "Ease the peak pressure slightly so ABS works less; it is lengthening the stop.",
    ("tyre_drop", None): "Look after the tyres in the first laps of the run: smoother exits and less sliding.",
    ("tyre_warmup", None): "Use the out-lap harder: firm braking and acceleration bring the temperature up "
                           "faster than weaving.",
}
TYRE_MEANING = {
    ("tyre_drop", "not seen"): "No clear lap time drop through the stints. Fuel burning off makes every lap a little "
                               "quicker and can hide a small drop: Stint analysis in Tools shows the grip in use "
                               "lap by lap.",
    ("tyre_drop", "contradicted"): "The laps get quicker through the stints: the tyres are not what limits the pace.",
    ("tyre_warmup", "contradicted"): "On pace from the first flying lap: the out-lap brings the tyres in.",
}
FIXED_PHASE = {"traction": "exit", "lock_up": "braking", "braking_stability": "braking", "abs": "braking"}
# claim -> section metric, how it reads, unit, and the least difference between corners that counts
CORNER_METRIC = {
    "traction": ("rear_slip_exit", "rear wheelspin on exit", "%", 1.5),
    "lock_up": ("front_lock", "front wheel slip under braking", "%", 1.5),
    "braking_stability": ("rear_rotation_braking", "rear rotation under braking", "°/s", 0.5),
    "abs": ("abs_share", "share of the braking on ABS", "%", 10.0),
}
TC_METRIC = ("tc", "traction control working", "s", 0.2)  # traction, when the wheel speeds can't show wheelspin
# Driving inputs whose lap-to-lap changes can explain a trait, by phase: metric -> (when higher, when lower)
LINK_WORDS = {
    "brake_point": ("brake later", "brake earlier"),
    "peak_brake": ("brake harder", "brake more gently"),
    "trail_share": ("trail the brake deeper into the turn", "finish braking earlier"),
    "min_speed": ("carry more speed to the apex", "carry less speed to the apex"),
    "throttle_on": ("pick up the throttle later", "pick up the throttle earlier"),
    "full_throttle": ("reach full throttle later", "reach full throttle earlier"),
}
LINKS_BY_PHASE = {
    "braking": ("brake_point", "peak_brake", "trail_share"),
    "entry": ("brake_point", "peak_brake", "trail_share", "min_speed"),
    "mid": ("min_speed", "throttle_on"),
    "exit": ("throttle_on", "full_throttle", "min_speed"),
    None: ("brake_point", "min_speed", "throttle_on"),
}
# Technique trends (insights.TECHNIQUE) that belong to each phase, for the "quick laps do this" advice
TRENDS_BY_PHASE = {
    "braking": {"brake_point", "peak_brake", "trail_share", "grip_braking", "grip_trail", "abs"},
    "entry": {"brake_point", "peak_brake", "trail_share", "grip_braking", "grip_trail", "abs", "understeer_entry"},
    "mid": {"min_speed", "coasting", "grip_mid", "understeer_mid", "steering_activity"},
    "exit": {"throttle_on", "full_throttle", "exit_speed", "grip_exit", "tc", "rear_slip_exit", "understeer_exit",
             "overlap"},
}
PHASE_NAME = {"entry": "entry", "mid": "mid-corner", "exit": "exit", "braking": "braking", CORNER: ""}
Z_CONFIRM, Z_PARTLY = 0.75, 0.5  # in units of how far apart this car's corners usually are
# Balance in degrees from the car's normal: confirmed where the report calls it at least slight (0.3), partly there
# from 0.2
BALANCE_SCALE = STRENGTH[-1][0] / Z_CONFIRM
SHARE_CONFIRM, SHARE_CAR = 0.6, 0.8  # of the laps: most laps, and almost every lap (then it is the car)
MIN_LAPS = 3
AGREEMENT = {"confirmed": "agrees", "partly": "agrees", "not seen": "disagrees", "contradicted": "disagrees",
             "cannot check": "unclear"}
MAX_UNMENTIONED = 3  # balance traits the report calls clear (NOTABLE) on almost every lap that no point mentions
MINUS = "\u2212"  # a typographic minus sign, as the app shows numbers


@dataclass
class Claim:
    kind: str | None
    negated: bool
    phase: str | None


@dataclass
class Reading:
    """One claim's measure at one corner, lap by lap, against the car's other corners."""
    values: np.ndarray  # per clean lap, NaN where there is nothing to read
    typical: float  # the car's other corners (0 for balance: the car's normal)
    scale: float  # how far apart the car's corners usually are
    label: str
    unit: str
    digits: int | None = None  # the median as it is shown: the balance to 0.1°, as the report reads it

    @property
    def ok(self) -> np.ndarray:
        return np.isfinite(self.values)

    @property
    def n(self) -> int:
        return int(self.ok.sum())

    @property
    def value(self) -> float:
        v = float(np.median(self.values[self.ok]))
        return round(v, self.digits) if self.digits is not None else v

    @property
    def z(self) -> float:
        return round((self.value - self.typical) / self.scale, 6)  # 0.3 / 0.4 reads 0.75, not 0.7499...

    def above(self) -> int:
        return int((self.values[self.ok] > self.typical).sum())


def read_claim(text: str, phase: str | None = None) -> Claim:
    kind, negated = None, False
    for name, rx in CLAIMS:
        m = rx.search(text)
        if m:
            kind = name
            if name == "traction" and TRACTION_NOUN.fullmatch(m.group(0)):
                negated = bool(TRACTION_GOOD.search(text))
            else:
                negated = bool(NEG.search(text[:m.start()]))
            break
    if phase is None:
        phase = next((p for p, rx in PHASE_WORDS if rx.search(text)), None)
    return Claim(kind, negated, phase)


def corner_in_text(text: str) -> str | None:
    """The corner number said in a typed point: T6, turn 6, curva 6, Kurve 6."""
    m = CORNER_IN_TEXT.search(text)
    return f"T{int(m[1])}" if m else None


def _codes(label: str) -> list[str]:
    """T2-T4 -> T2, T3, T4; T8/T9 -> T8, T9."""
    m = re.fullmatch(r"([A-Z]+)(\d+)-[A-Z]+(\d+)", label)
    if m:
        return [f"{m[1]}{i}" for i in range(int(m[2]), int(m[3]) + 1)]
    return label.split("/")


def section_for(code: str | None, sections: list[Section]) -> Section | None:
    if not code:
        return None
    code = code.strip().upper()
    return next((s for s in sections if code in _codes(s.code)), None)


# ---------- reading the data ----------

def _robust_sd(x: np.ndarray) -> float:
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if len(x) else 0.0


def _per_lap(ms: list[dict], key: str) -> np.ndarray:
    return np.array([m.get(key) if m.get(key) is not None else np.nan for m in ms], float)


def _corner_reading(metric: tuple[str, str, str, float], sec: Section, per: dict[str, list[dict]]) -> Reading | None:
    """A section metric at this corner against the median of the car's other corners."""
    key, label, unit, floor = metric
    meds = {}
    for code, ms in per.items():
        vals = _per_lap(ms, key)
        if np.isfinite(vals).sum() >= 2:
            meds[code] = float(np.nanmedian(vals))
    if sec.code not in meds or len(meds) < 3:
        return None
    others = np.array([v for c, v in meds.items() if c != sec.code])
    r = Reading(_per_lap(per[sec.code], key), float(np.median(others)), max(_robust_sd(others), floor), label, unit)
    return r if r.n >= MIN_LAPS else None


def _balance(values: np.ndarray) -> Reading:
    """Balance lap by lap, in degrees from the car's normal."""
    return Reading(values, 0.0, BALANCE_SCALE, "balance", "°", 1)


def _balance_reading(by_phase: dict[str, np.ndarray], phase: str | None, sign: int) -> tuple[Reading, str] | None:
    """The balance in this phase (over the whole corner when the phase has too little cornering).

    With no phase said, the phase that shows the most of the claimed trait: a push at turn-in is what "understeer
    at T3" means, even when the rest of the corner is neutral, and a "no understeer at T3" has to hold in every
    phase.
    """
    readings = {ph: _balance(v) for ph, v in by_phase.items()}
    readings = {ph: r for ph, r in readings.items() if r.n >= MIN_LAPS}
    want = {"braking": "entry"}.get(phase or "", phase)
    if want is None:
        phases = [ph for ph in ("entry", "mid", "exit") if ph in readings]
        if phases:
            best = max(phases, key=lambda ph: sign * readings[ph].z)
            return readings[best], best
    for ph in dict.fromkeys((want or CORNER, CORNER)):
        if ph in readings:
            return readings[ph], ph
    return None


def _elsewhere(by_phase: dict[str, np.ndarray], read: str, sign: int) -> tuple[str, Reading, int] | None:
    """Another phase of the same corner that clearly shows the claimed trait, when the phase said doesn't: the
    driver felt it, in a different part of the corner."""
    best = None
    for ph in ("entry", "mid", "exit"):
        if ph == read or ph not in by_phase:
            continue
        r = _balance(by_phase[ph])
        if r.n < MIN_LAPS:
            continue
        with_it = int((r.values[r.ok] * sign > 0).sum())
        if sign * r.z >= Z_CONFIRM and with_it >= SHARE_CONFIRM * r.n and (best is None or sign * r.z > best[0]):
            best = (sign * r.z, ph, r, with_it)
    return best[1:] if best else None


def _verdict(z: float, share: float, negated: bool) -> str:
    """z and share are in the claim's direction: how far the corner stands out that way, and on what share of laps."""
    shows = z >= Z_CONFIRM and share >= SHARE_CONFIRM
    some = z >= Z_PARTLY and share >= 0.5
    if negated:  # "no understeer at T10": holds unless the corner stands out that way
        if shows:
            return "contradicted"
        return "confirmed" if z < Z_PARTLY else "partly"
    if shows:
        return "confirmed"
    if some:
        return "partly"
    if z <= -Z_CONFIRM and share <= 1 - SHARE_CONFIRM:
        return "contradicted"
    return "not seen"


def _link(values: np.ndarray, ms: list[dict], runs: list[str], keys: tuple[str, ...], sign: int) -> str | None:
    """The driving input that goes with more of the trait lap to lap, if any clearly does."""
    best = None
    y = _within(values, runs)
    for key in keys:
        x = _per_lap(ms, key)
        ok = np.isfinite(x) & np.isfinite(values)
        if ok.sum() < 8:
            continue
        c = corr(_within(x, runs)[ok], y[ok])
        if c and c["p"] < 0.05 and abs(c["r"]) >= 0.5 and (best is None or c["p"] < best[1]["p"]):
            best = (key, c)
    if best is None:
        return None
    key, c = best
    return LINK_WORDS[key][0 if sign * c["r"] > 0 else 1]


def _cost(values: np.ndarray, ms: list[dict], runs: list[str], sign: int) -> str:
    times = _per_lap(ms, "time")
    ok = np.isfinite(values)
    c = corr(_within(values, runs)[ok], _within(times, runs)[ok]) if ok.sum() >= 8 else None
    if not c or c["p"] >= 0.05:
        return ""
    if sign * c["r"] > 0:
        return " The laps with more of it are slower here."
    return " The laps with more of it are quicker here: it is the price of attacking the corner."


def _trend_note(trends: list[dict], phase: str | None) -> str:
    keys = TRENDS_BY_PHASE.get(phase or "")
    t = next((t for t in trends if keys is None or t["metric"] in keys), None)
    if t is None:
        return ""
    unit = f" {t['unit']}" if t["unit"] else ""
    return (f" The quick laps here differ most in {t['label'].lower()}: {_fmt(t['quick_laps_value'])} against "
            f"{_fmt(t['median'])}{unit} typical, worth about {t['gain_s']:.2f} s.")


def _fmt(v: float) -> str:
    return f"{v:.0f}" if abs(v) >= 100 else f"{v:.1f}" if abs(v) >= 10 else f"{v:.2f}"


def _num(v: float, unit: str, signed: bool = False) -> str:
    digits = 1 if unit in ("%", "°/s") or abs(v) >= 10 else 2
    sign = ("+" if v > 0 else MINUS if v < 0 else "") if signed else (MINUS if v < 0 else "")
    return f"{sign}{abs(v):.{digits}f}{unit if unit in ('°', '%') else ' ' + unit if unit else ''}"


def _where(corner: str | None, phase: str | None) -> str:
    """" at T6 entry", " under braking for T6", " in slow corners on entry"."""
    if not corner:
        return ""
    if corner in BANDS:
        return f" in {corner} corners" + (f" {BAND_PHASE[phase]}" if phase in BAND_PHASE else "")
    if phase == "braking":
        return f" under braking for {corner}"
    return f" at {corner}" + (f" {PHASE_NAME[phase]}" if phase in ("entry", "mid", "exit") else "")


# ---------- one point ----------

def check_point(text: str, corner: str | None, phase: str | None, prep: Prepared, per: dict[str, list[dict]],
                trends: dict[str, list[dict]], bal: SectionBalance | None = None,
                stints: dict[tuple[str, int], tuple[str, int]] | None = None) -> dict:
    claim = read_claim(text, phase)
    corner = corner or corner_in_text(text)
    sec = section_for(corner, prep.sections)
    balance = claim.kind in ("understeer", "oversteer")
    band = next((b for b, rx in SPEED_WORDS if rx.search(text)), None) if balance and corner is None else None
    out = {"claim": claim.kind, "claim_label": CLAIM_LABEL.get(claim.kind), "negated": claim.negated,
           "phase": claim.phase, "section": sec.code if sec else None, "corner": corner, "speed_band": band,
           "said": _said(claim)}

    def unclear(why: str) -> dict:
        return {**out, "verdict": "cannot check", "agreement": "unclear", "evidence": why, "line": why}

    if claim.kind is None:
        return unclear("Nothing in this point that the logger can check.")
    if claim.kind in ("tyre_drop", "tyre_warmup"):
        return _with_agreement({**out, **_tyres(claim, prep, stints)})
    if corner is None and band is None:
        return unclear("No corner given; name it (for example T6), or say slow or fast corners, to check it "
                       "against the data.")
    if corner is not None and sec is None:
        return unclear(f"{corner} isn't one of the corners in this session's data.")
    phase_out = claim.phase if balance else FIXED_PHASE.get(claim.kind, claim.phase)
    out["phase"] = phase_out
    ms = per[sec.code] if sec else None
    if balance:
        sign = 1 if claim.kind == "understeer" else -1
        by_phase = (bal.bands[band] if band else bal.laps.get(sec.code, {})) if bal else {}
        found = _balance_reading(by_phase, claim.phase, sign) if bal else None
        if found is None:
            return unclear("The balance can't be read in this session: it needs steering and yaw rate channels and "
                           "enough cornering." if bal is None else
                           f"Too little hard cornering {f'at {corner}' if corner else f'in the {band} corners'} on "
                           "enough laps to read the balance.")
        r, read_phase = found
        metric_phase = None if read_phase == CORNER else read_phase
    else:
        r = _corner_reading(CORNER_METRIC[claim.kind], sec, per)
        if r is None and claim.kind == "traction":
            r = _corner_reading(TC_METRIC, sec, per)
        if r is None:
            return unclear("The logger has no channel that shows this here.")
        sign, read_phase, metric_phase = 1, phase_out, phase_out
    z = sign * r.z
    with_it = int(((r.values[r.ok] - r.typical) * sign > 0).sum())
    verdict = _verdict(z, with_it / r.n, claim.negated)
    elsewhere = None
    if balance and claim.phase and not claim.negated and verdict in ("not seen", "contradicted"):
        elsewhere = _elsewhere(by_phase, read_phase, sign)
    link, cost, trend = None, "", ""
    if ms is not None:  # how the trait goes with the driving, lap to lap, at this corner
        runs = [x.run for x in prep.laps]
        link = _link(r.values, ms, runs, LINKS_BY_PHASE.get(metric_phase, LINKS_BY_PHASE[None]), sign)
        cost = _cost(r.values, ms, runs, sign)
        trend = _trend_note(trends.get(sec.code, []), elsewhere[0] if elsewhere else metric_phase)
    meaning, cause, advice = _meaning(claim, verdict, r, with_it, link, metric_phase, bal, cost,
                                      f"the {band} corners" if band else "this corner", elsewhere)
    if band:
        where_data = f"in {band} corners" + (f" {BAND_PHASE[read_phase]}" if read_phase in BAND_PHASE else "")
    else:
        where_data = f"at {sec.code}" + (f" {PHASE_NAME[read_phase]}" if balance and read_phase != CORNER else "")
    if balance and claim.phase and read_phase == CORNER:
        where_data += f" (whole corner: too little cornering {BAND_PHASE[claim.phase]} to read it alone)"
    evidence = _evidence(r, balance, where_data)
    said = out["said"]
    line = (f"Said {said}{_where(band or corner, phase_out)}; data: {evidence}, "
            f"so {_verdict_words(verdict, claim.negated)}.")
    return _with_agreement({**out, "verdict": verdict, "evidence": evidence[0].upper() + evidence[1:] + ".",
                            "line": line, "z": round(z, 2), "laps_with_it": with_it, "laps": r.n,
                            "cause": cause, "meaning": meaning, "suggestion": (advice + trend).strip()})


def _said(claim: Claim) -> str | None:
    """What the driver said, as it reads in "Said ... at T6 entry"."""
    if claim.kind is None:
        return None
    return SAID_NOT.get(claim.kind, f"no {SAID[claim.kind]}") if claim.negated else SAID[claim.kind]


def _with_agreement(point: dict) -> dict:
    return {**point, "agreement": AGREEMENT[point["verdict"]]}


def _verdict_words(verdict: str, negated: bool) -> str:
    if negated:
        return {"confirmed": "it matches", "partly": "it mostly matches",
                "contradicted": "the data says otherwise"}.get(verdict, "the data can't tell")
    return {"confirmed": "it matches", "partly": "it partly matches", "not seen": "the data doesn't back it",
            "contradicted": "the data says the opposite"}[verdict]


def _evidence(r: Reading, balance: bool, where: str) -> str:
    """where: "at T6 entry", "in slow corners on entry"."""
    v = r.value
    if balance:  # in the report's words: slight, clear or strong understeer or oversteer
        d = describe(v)
        up = r.above()
        count = (f"more understeer than normal on {up} of {r.n} laps" if v >= 0 else
                 f"more oversteer than normal on {r.n - up} of {r.n} laps")
        if d["kind"] == "normal" and abs(r.z) >= Z_PARTLY:
            lean = "understeer" if v > 0 else "oversteer"
            return f"balance {where} a touch towards {lean} ({deg(v)}, within the car's normal), {count}"
        if d["kind"] == "normal":  # how many laps stay within it, as the report reads a lap (to 0.1°)
            within = int((np.abs(np.round(r.values[r.ok], 1)) < STRENGTH[-1][0]).sum())
            return f"balance {where} within the car's normal ({deg(v)}) on {within} of {r.n} laps"
        return f"balance {where} {deg(v)} from the car's normal ({d['strength']} {d['kind']}), {count}"
    return (f"{r.label} {where} {_num(v, r.unit)} against {_num(r.typical, r.unit)} in the car's other "
            f"corners, more on {r.above()} of {r.n} laps")


def _meaning(claim: Claim, verdict: str, r: Reading, with_it: int, link: str | None, phase: str | None,
             bal: SectionBalance | None, cost: str, subject: str = "this corner",
             elsewhere: tuple[str, Reading, int] | None = None) -> tuple[str, str | None, str]:
    """What the comparison likely means (and whether it points at the car or the driving), and what to try.

    Returns (meaning, cause, suggestion); cause is "car", "technique" or None when it can't be told apart.
    """
    kind, n = claim.kind, r.n
    here = "here" if subject == "this corner" else f"in {subject}"
    seen = f"{with_it} of {n} laps"
    balance = kind in ("understeer", "oversteer")
    than = "than the car's normal" if balance else "than in the car's other corners"
    suggest = SUGGEST.get((kind, phase if balance else None), "") if phase or not balance else ""
    if claim.negated:
        if verdict == "contradicted":
            return f"The data does show {MORE_OF[kind]} {here}, on {seen}, more {than}.", None, suggest
        if verdict == "partly":
            return f"Mostly: a little more {MORE_OF[kind]} {here} {than}, on {seen}.", None, ""
        return f"The data agrees: no more {MORE_OF[kind]} {here} {than}.", None, ""
    linked = f" It is bigger on laps where you {link}." if link else ""
    if verdict in ("confirmed", "partly"):
        if with_it >= SHARE_CAR * n:
            return (f"Seen on {seen}, so it is the car rather than how one lap was driven: a setup item."
                    f"{linked}{cost}", "car", suggest)
        if link:
            return (f"Seen on {seen}, more on laps where you {link}: it comes from how the corner is driven more "
                    f"than from the car.{cost}", "technique", suggest)
        return f"Seen on {seen}.{cost}", None, suggest
    if elsewhere is not None:  # felt in another part of the corner
        ph, other, k = elsewhere
        return (f"The data shows {kind} {here} {BAND_PHASE[ph]} instead ({deg(other.value)} from the car's normal, "
                f"on {k} of {other.n} laps): what you felt is there, in another part of the corner.",
                "car" if k >= SHARE_CAR * other.n else None, SUGGEST.get((kind, ph), ""))
    against = n - with_it
    if verdict == "contradicted":
        if kind == "oversteer":
            return (f"The front pushes {here} on {against} of {n} laps rather than the rear stepping out: rear "
                    "movement after a push usually comes from lifting or adding steering, so it's the driving "
                    "reacting to the car.", "technique", SUGGEST.get(("understeer", phase), ""))
        if kind == "understeer":
            return (f"The balance {here} is towards oversteer on {against} of {n} laps, so the rear is sliding too: "
                    "a front that feels vague may be both ends letting go. Look at rear grip rather than the front.",
                    "car", SUGGEST.get(("oversteer", phase), ""))
        if kind == "traction":
            return (f"The rear spins less {here} than in the car's other exits on {against} of {n} laps: a slow "
                    "exit here is more likely the line or the throttle timing than traction.", "technique", "")
        return (f"Less {here} than in the car's other stops on {against} of {n} laps: likely one stop (a bump, a "
                "kerb, a late brake) rather than the car.", None, suggest)
    # not seen: the corner is about as the car usually is
    if link and with_it >= 0.3 * n:
        return (f"Only on {seen}, the ones where you {link}: that is the driving on those laps, not the car.",
                "technique", suggest)
    if kind == "understeer" and bal is not None and bal.per_g > 0:
        return (f"{subject[0].upper() + subject[1:]} {'is' if subject == 'this corner' else 'are'} within the car's "
                "normal balance. The car needs more steering as the cornering load rises, everywhere "
                f"({bal.per_g:.1f}° per g, taken off before comparing), which is likely what you feel: a whole-car "
                f"balance item, not {subject}.", "car", "")
    if kind == "oversteer":
        return (f"The rear is no looser {here} {than} on most laps: likely a single moment (one lap, a kerb, a "
                "lift) rather than the car.", None, "")
    return (f"Not more {than}: check whether it was one lap (traffic, a kerb).", None, "")


def stints_of(runs: list[RunInput]) -> dict[tuple[str, int], tuple[str, int]]:
    """(run, lap number) -> (stint, clean laps before it in the stint): tyre age, counted from each pit stop."""
    out = {}
    for run in runs:
        stops = find_stops(run.data) if "speed" in run.data.channels else []
        for i, laps in enumerate(split_stints(run.data.laps, stops)):
            for k, lap in enumerate(x for x in laps if x.clean):
                out[(run.name, lap.number)] = (f"{run.name}#{i}", k)
    return out


def _tyres(claim: Claim, prep: Prepared, stints: dict[tuple[str, int], tuple[str, int]] | None = None) -> dict:
    """Tyre claims are checked on lap times through each stint (a run between pit stops)."""
    rows = []  # (stint, clean laps into it, lap time)
    for x in prep.laps:
        stint, k = (stints or {}).get((x.run, x.number), (x.run, x.index_in_run))
        rows.append((stint, k, x.time))
    rows.sort(key=lambda r: (r[0], r[1]))
    said = _said(claim)

    def result(verdict: str, evidence: str) -> dict:
        meaning = None if claim.negated else TYRE_MEANING.get((claim.kind, verdict))
        return {"verdict": verdict, "evidence": evidence[0].upper() + evidence[1:] + ".",
                "line": f"Said {said}; data: {evidence}, so {_verdict_words(verdict, claim.negated)}.",
                "meaning": meaning, "cause": None,
                "suggestion": SUGGEST[(claim.kind, None)] if verdict in ("confirmed", "partly") else ""}

    if claim.kind == "tyre_warmup":
        # flying laps at the start of each stint slower than the stint's later laps by more than 0.5 %
        slow = []
        for stint in dict.fromkeys(r[0] for r in rows):
            ts = [t for s, _, t in rows if s == stint]
            if len(ts) < 5:
                continue
            ref = float(np.median(ts[2:]))
            slow.append(next((i for i, t in enumerate(ts) if t <= ref * 1.005), len(ts)))
        if not slow:
            why = "No stint with five clean laps to see the tyres come in."
            return {"verdict": "cannot check", "evidence": why, "line": why}
        n = float(np.median(slow))
        verdict = _verdict(1.0 if n >= 2 else 0.5 if n >= 1 else -1.0, 1.0 if n >= 1 else 0.0, claim.negated)
        each = ", ".join(str(k) for k in slow[:-1]) + (" and " if len(slow) > 1 else "") + str(slow[-1])
        return result(verdict, f"flying laps before the pace came in (within 0.5 % of the stint's later laps): "
                               f"{each} in {'this session' if len(slow) == 1 else 'its stints'}")
    late = [(s, k, t) for s, k, t in rows if k >= 2]  # past the warm-up laps
    c = corr(_within(np.array([k for _, k, _ in late], float), [s for s, _, _ in late]),
             _within(np.array([t for _, _, t in late]), [s for s, _, _ in late])) if len(late) >= 8 else None
    if c is None:
        why = "The stints are too short to see the tyres drop off."
        return {"verdict": "cannot check", "evidence": why, "line": why}
    if c["slope"] > 0.05 and c["p"] < 0.05:
        z, share = 1.0, 1.0
    elif c["slope"] > 0.02:
        z, share = 0.5, 1.0
    elif c["slope"] < -0.05 and c["p"] < 0.05:  # quicker lap after lap: the tyres are not what limits it
        z, share = -1.0, 0.0
    else:
        z, share = 0.0, 0.5
    return result(_verdict(z, share, claim.negated),
                  f"after the warm-up laps, lap time changes {_num(c['slope'], 's', True)} per lap within a stint "
                  f"(r {_num(c['r'], '', True)}, {c['n']} laps)")


# ---------- the whole debrief ----------

def _unmentioned(bal: SectionBalance | None, points: list[dict]) -> list[dict]:
    """The clearest balance traits in the data that no point talks about."""
    if bal is None:
        return []
    said = {(p["section"], "entry" if p["phase"] == "braking" else p["phase"])
            for p in points if p.get("claim") in ("understeer", "oversteer")}
    found = []
    for code, by_phase in bal.laps.items():
        for ph in ("entry", "mid", "exit"):
            v = by_phase[ph]
            ok = np.isfinite(v)
            if ok.sum() < max(MIN_LAPS, 5) or (code, ph) in said or (code, None) in said:
                continue
            r = _balance(v)
            kind = "understeer" if r.value > 0 else "oversteer"
            with_it = r.above() if r.value > 0 else r.n - r.above()
            if abs(r.value) >= NOTABLE and with_it >= SHARE_CAR * r.n:
                evidence = _evidence(r, True, f"at {code} {PHASE_NAME[ph]}")
                found.append({"section": code, "phase": ph, "kind": kind, "value": round(r.value, 2),
                              "laps_with_it": with_it, "laps": r.n,
                              "line": evidence[0].upper() + evidence[1:] + "."})
    found.sort(key=lambda f: -abs(f["value"]))
    return found[:MAX_UNMENTIONED]


def _with_abs_share(ms: list[dict]) -> list[dict]:
    """ABS time as a share of the braking: a long stop has more ABS time without the car being any worse."""
    for m in ms:
        braking = m.get("time_braking", 0.0) + m.get("time_trail", 0.0)
        m["abs_share"] = 100 * m["abs"] / braking if m.get("abs") is not None and braking >= 0.3 else None
    return ms


def check_debrief(points: list[dict], runs: list[RunInput], corners: list[CornerSpec] | None = None, *,
                  drop_channels: bool = False, geo: Geometry | None = None) -> dict:
    """points: [{"id", "text", "corner_code", "phase"}]. Returns a verdict per point and how many agree.

    geo: the car's steering ratio and wheelbase for the balance (balance.car_geometry); Hockenheim's when None.
    """
    stints = stints_of(runs)  # before prepare drops the channels
    add_balance_channel(runs, geo or car_geometry(None))
    prep = prepare(runs, corners, drop_channels=drop_channels)
    if prep is None:
        return {"points": [], "error": "No clean laps in this session to check against"}
    per = {s.code: _with_abs_share([section_metrics(x, s, prep.limits, prep.sim) for x in prep.laps])
           for s in prep.sections}
    trends = {code: _trend_rows(prep.laps, ms) for code, ms in per.items()}
    bal = section_balance(prep)
    out = [{"id": p.get("id"), "text": p["text"],
            **check_point(p["text"], p.get("corner_code"), p.get("phase"), prep, per, trends, bal, stints)}
           for p in points]
    counts: dict[str, int] = {}
    agreement = {"agrees": 0, "disagrees": 0, "unclear": 0}
    for r in out:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
        agreement[r["agreement"]] += 1
    return {"numbering": prep.numbering, "sections": [s.to_dict() for s in prep.sections], "laps": len(prep.laps),
            "summary": counts, "agreement": agreement,
            "balance": {"per_g": round(bal.per_g, 2), "unit": bal.unit} if bal else None,
            "unmentioned": _unmentioned(bal, out), "points": out}
