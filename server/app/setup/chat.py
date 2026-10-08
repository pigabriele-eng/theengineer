"""The setup tool: one setup change at a time, and a conversation about it.

The engineer says what the car does (understeer mid-corner, wheelspin out of T2...), or the tool takes it from a
run's debrief and data (app.routers.setups._suggestions). The tool proposes the change that best answers it, with
why, what to expect and what to watch. The engineer answers, by tapping or typing: "we're already at the minimum ride
height", "already on the softest spring", "tried it, no better", "something else". The tool notes the limit or the
result, never proposes that change again for this event, and offers the next change that answers the same problem
(another lever, or the same one made another way: more rake from the rear when the front is at its BoP minimum).

Everything here is plain rules over the lever table in app.setup.suggest; no paid service reads the replies. A
conversation's state is a JSON dict (stored per event in setup_chats): the car variant, the run it reads, the
problems, the limits, what was tried and how it went, what was skipped, and the messages.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime

from app.debrief.check import corner_in_text, read_claim
from app.setup.suggest import (
    FAST,
    FRONTS,
    KINDS,
    LEVERS,
    REARS,
    SLOW,
    Lever,
    Observation,
    Target,
    _apply,
    _contribution,
)
from app.setup.templates import AXLE_OF, BMW_M4_GT4_EVO, OPPOSITE, Template

VARIANTS = {"evo": "M4 GT4 Evo (G82)", "non_evo": "M4 GT4 (G82, before Evo)"}

# The adjustments the car has (Gabriele, 2026-10-08): springs, 2-way dampers, camber and toe, ride height against
# the BoP minimums, rear wing, tyre pressures, brake balance and the bars. TC and ABS are driving aids, not setup.
EXTRA_LEVERS: tuple[Lever, ...] = (
    Lever("pressure_front_lower", "Front cold pressures lower",
          ((Target("pressure_cold", "lower", 0.05, FRONTS),),),
          {"understeer_mid": 0.75, "understeer_entry": 0.5, "understeer_exit": 0.5, "oversteer_mid": -0.5},
          kind="mechanical", effort=0.9,
          expected="If the front hot pressures run over the target, bringing them down gives the front tyres more "
                   "contact patch: a little more front grip.",
          cost="Only while the hot pressures stay at or over Pirelli's target, and never under the minimum."),
    Lever("pressure_rear_lower", "Rear cold pressures lower",
          ((Target("pressure_cold", "lower", 0.05, REARS),),),
          {"oversteer_mid": 0.75, "oversteer_exit": 0.75, "traction": 0.75, "understeer_mid": -0.5},
          kind="mechanical", effort=0.9,
          expected="If the rear hot pressures run over the target, bringing them down gives the rear more grip and "
                   "traction.",
          cost="Only while the hot pressures stay at or over Pirelli's target, and never under the minimum."),
)
SKIP_KINDS = ("electronics",)
CHAT_LEVERS: tuple[Lever, ...] = tuple(lv for lv in (*LEVERS, *EXTRA_LEVERS) if lv.kind not in SKIP_KINDS)
BY_KEY = {lv.key: lv for lv in CHAT_LEVERS}
MINUS = "\u2212"
MIN_SCORE = 0.4  # a lever must answer the problem at least this much to be offered

PROBLEMS: tuple[dict, ...] = (
    {"kind": "understeer", "phase": "entry", "label": "Understeer on entry"},
    {"kind": "understeer", "phase": "mid", "label": "Understeer mid-corner"},
    {"kind": "understeer", "phase": "exit", "label": "Understeer on exit"},
    {"kind": "oversteer", "phase": "entry", "label": "Oversteer on entry"},
    {"kind": "oversteer", "phase": "mid", "label": "Oversteer mid-corner"},
    {"kind": "oversteer", "phase": "exit", "label": "Oversteer on exit"},
    {"kind": "braking_stability", "phase": "braking", "label": "Unstable under braking"},
    {"kind": "lock_up", "phase": "braking", "label": "Locking the fronts"},
    {"kind": "traction", "phase": "exit", "label": "Wheelspin on exit"},
    {"kind": "ride", "phase": None, "label": "Bottoming or kerbs"},
)

# ---------- limits ----------

# One limit: a row of the sheet that can't go further one way, on one axle or both (axle None).
# Rows that are the same adjustment for a limit: a spring choice and its rate, bump and rebound under "dampers".
SAME_ROW = {"spring_rate": "spring"}
WANT_WORDS = {
    ("ride_height", "lower"): "at the BoP minimum ride height",
    ("ride_height", "higher"): "at its highest ride height",
    ("spring", "softer"): "on the softest springs", ("spring", "stiffer"): "on the stiffest springs",
    ("arb", "softer"): "anti-roll bar on its softest position",
    ("arb", "stiffer"): "anti-roll bar on its stiffest position",
    ("wing", "more downforce"): "rear wing at maximum downforce",
    ("wing", "less downforce"): "rear wing at minimum downforce",
    ("bump", "softer"): "bump fully soft", ("bump", "stiffer"): "bump fully stiff",
    ("rebound", "softer"): "rebound fully soft", ("rebound", "stiffer"): "rebound fully stiff",
    ("camber", "more negative"): "camber at the limit", ("camber", "more positive"): "camber at its least",
    ("toe", "more toe-in"): "toe-in as far as it goes", ("toe", "more toe-out"): "toe-out as far as it goes",
    ("brake_balance", "more front"): "brake balance as far forward as it goes",
    ("brake_balance", "more rear"): "brake balance as far back as it goes",
    ("pressure_cold", "lower"): "cold pressures at the minimum",
    ("pressure_cold", "higher"): "cold pressures at the most",
}


def limit_label(limit: dict) -> str:
    """'Front anti-roll bar on its softest position', 'Rear wing at maximum downforce'."""
    words = WANT_WORDS.get((limit["row"], limit["want"]), f"{limit['row']} can't go {limit['want']}")
    if limit["row"] in ("wing", "brake_balance"):
        return _uc(words)
    where = {"front": "Front", "rear": "Rear"}.get(limit.get("axle") or "", "Front and rear")
    return f"{where} {words}"


ALREADY = {
    ("camber", "more negative"): "{Axle}camber already at the limit",
    ("bump", "softer"): "{Axle}bump already fully soft", ("bump", "stiffer"): "{Axle}bump already fully stiff",
    ("rebound", "softer"): "{Axle}rebound already fully soft",
    ("rebound", "stiffer"): "{Axle}rebound already fully stiff",
    ("toe", "more toe-in"): "{Axle}toe-in already at the most",
    ("toe", "more toe-out"): "{Axle}toe-out already at the most",
    ("ride_height", "lower"): "Already at minimum {axle}ride height",
    ("spring", "softer"): "Already on the softest {axle}springs",
    ("spring", "stiffer"): "Already on the stiffest {axle}springs",
    ("arb", "softer"): "Already on the softest {axle}bar",
    ("arb", "stiffer"): "Already on the stiffest {axle}bar",
    ("wing", "more downforce"): "Wing already at maximum",
    ("wing", "less downforce"): "Wing already at minimum",
    ("pressure_cold", "lower"): "Already at minimum {axle}pressures",
    ("brake_balance", "more front"): "Brake balance already fully forward",
    ("brake_balance", "more rear"): "Brake balance already fully back",
}


def already_label(limit: dict) -> str:
    """The one-tap answer that states the limit: 'Already on the softest rear bar'."""
    axle = f"{limit['axle']} " if limit.get("axle") else ""
    text = ALREADY.get((limit["row"], limit["want"]))
    if text is None:
        return f"Already at the limit: {_lc(limit_label(limit))}"
    return _uc(text.format(axle=axle, Axle=_uc(axle)))


def _uc(s: str) -> str:
    return s[:1].upper() + s[1:]


def _lc(s: str) -> str:
    return s[:1].lower() + s[1:]


def _blocked(limits: list[dict], row: str, axle: str | None, want: str) -> bool:
    row = SAME_ROW.get(row, row)
    return any(lim["row"] == row and lim["want"] == want and (lim.get("axle") is None or axle is None
                                                                or lim["axle"] == axle) for lim in limits)


def _axles(t: Target) -> list[str | None]:
    if not t.positions:
        return [None]
    return list(dict.fromkeys(AXLE_OF.get(p) for p in t.positions))


def option_limits(targets: tuple[Target, ...]) -> list[dict]:
    """The limits that would rule this way of making a change out: one per target (and axle)."""
    out = []
    for t in targets:
        for axle in _axles(t):
            out.append({"row": SAME_ROW.get(t.row, t.row), "axle": axle, "want": t.want})
    return out


def _option_ok(limits: list[dict], targets: tuple[Target, ...]) -> bool:
    return not any(_blocked(limits, t.row, axle, t.want) for t in targets for axle in _axles(t))


def add_limit(limits: list[dict], new: dict) -> list[dict]:
    """The limits with one more; a limit on both axles replaces the per-axle ones for the same row and way."""
    new = {"row": SAME_ROW.get(new["row"], new["row"]), "axle": new.get("axle"), "want": new["want"]}
    same = [lim for lim in limits if lim["row"] == new["row"] and lim["want"] == new["want"]]
    if any(lim.get("axle") is None or lim.get("axle") == new["axle"] for lim in same):
        return limits
    if new["axle"] is None:
        limits = [lim for lim in limits if lim not in same]
    return [*limits, new]


# ---------- reading a typed reply ----------

ROW_WORDS: tuple[tuple[str, re.Pattern], ...] = (
    ("ride_height", re.compile(r"ride ?heights?|\brh\b|\bheight", re.I)),
    ("spring", re.compile(r"springs?\b|feder|moll", re.I)),
    ("arb", re.compile(r"anti[- ]?roll|roll ?bars?|sway ?bars?|\barbs?\b|\bbars?\b(?! of)", re.I)),
    ("wing", re.compile(r"\bwing|flap|ala\b|fl[üu]gel", re.I)),
    ("bump", re.compile(r"\bbump|compression", re.I)),
    ("rebound", re.compile(r"rebound", re.I)),
    ("dampers", re.compile(r"dampers?|shocks?|clicks?", re.I)),
    ("camber", re.compile(r"camber|sturz|campanatur", re.I)),
    ("toe", re.compile(r"\btoe", re.I)),
    ("brake_balance", re.compile(r"brake ?(balance|bias)|\bbias\b|bremsbalance|ripartizione", re.I)),
    ("pressure_cold", re.compile(r"pressures?|\bpsi\b|luftdruck|pression", re.I)),
)
SOFT = re.compile(r"soft(est|er)?|fully open|weich", re.I)
STIFF = re.compile(r"stiff(est|er)?|hard(est|er)?|fully closed|firm(est)?|hart", re.I)
LOW = re.compile(r"\bmin(imum|imal)?\b|lowest|as low|can'?t go (any )?lower|no lower|bottom(ed)?|on the floor|"
                 r"least|minim", re.I)
HIGH = re.compile(r"\bmax(imum|ed)?\b|highest|as high|can'?t go (any )?higher|no higher|most|full|top", re.I)
FORWARD = re.compile(r"forward|\bfront(most)?\b|nach vorn", re.I)
REARWARD = re.compile(r"rearward|\brear(most)?\b|backward|nach hinten", re.I)
TOE_IN, TOE_OUT = re.compile(r"toe[- ]?in", re.I), re.compile(r"toe[- ]?out", re.I)
LIMIT_CUE = re.compile(r"already|at (the |its |our )?(min|max|limit|lowest|highest|end|bop)|"
                       r"on (the )?(softest|stiffest|hardest|min|max)|can'?t|cannot|no more|maxed|"
                       r"all the way|fully|limit|as (low|high|far|soft|stiff) as|"
                       r"softest|stiffest|hardest|lowest|highest|minimum|maximum|bottomed|\bmin\b|\bmax\b|"
                       r"gi[aà]|schon|bereits", re.I)
GENERIC_LIMIT = re.compile(r"already (there|at|on|done|set|maxed|the)|at (the |its )?(limit|end|max|min)|"
                           r"can'?t go (any )?(further|more|lower|higher|softer|stiffer)|no more (room|adjustment)|"
                           r"maxed( out)?|bottomed( out)?|out of (range|adjustment)|that'?s the (limit|end)", re.I)
TRIED_BAD = re.compile(r"didn'?t (help|work|change)|did not (help|work)|no (better|change|difference)|not better|"
                       r"worse|did nothing|made no|no improvement|doesn'?t (help|work)", re.I)
TRIED_ONLY = re.compile(r"\s*(we )?tried (it|that)( already)?\s*\.?\s*", re.I)
TRIED_GOOD = re.compile(r"\b(helped|better|improved|works|worked|fixed|cured|solved)\b", re.I)
GONE = re.compile(r"(problem|it'?s|that'?s) (is )?(gone|fixed|solved|sorted)|all good|no more (under|over)steer",
                  re.I)
SKIP = re.compile(r"something else|another|other (option|idea|change|way)|skip|\bnext\b|don'?t want|rather not|"
                  r"^\s*no\.?\s*$|^\s*nope\s*$|not that|not now|alternative", re.I)
MORE = re.compile(r"\bstill\b|some left|not (gone|fixed|solved)|a bit left|more of it", re.I)
RESET = re.compile(r"start (again|over)|\breset\b|clear (it|everything|all)|forget (it|everything|all)", re.I)
NEGATION = re.compile(r"\b(not|no|never|isn'?t|wasn'?t|didn'?t)\b", re.I)


def _axle_in(text: str, row: str) -> str | None:
    if row in ("wing", "brake_balance"):
        return None
    front, rear = re.search(r"\bfront\b|vorn|anterior", text, re.I), re.search(r"\brear\b|hinten|posterior", text, re.I)
    if front and not rear:
        return "front"
    if rear and not front:
        return "rear"
    return None


def _want_in(text: str, row: str) -> str | None:
    if row in ("spring", "arb", "bump", "rebound"):
        if SOFT.search(text):
            return "softer"
        if STIFF.search(text):
            return "stiffer"
        return "softer" if LOW.search(text) else "stiffer" if HIGH.search(text) else None
    if row == "wing":
        return "less downforce" if LOW.search(text) else "more downforce" if HIGH.search(text) else None
    if row == "brake_balance":
        if REARWARD.search(text):
            return "more rear"
        if FORWARD.search(text) or HIGH.search(text):
            return "more front"
        return None
    if row == "toe":
        if TOE_OUT.search(text):
            return "more toe-out"
        if TOE_IN.search(text) or HIGH.search(text):
            return "more toe-in"
        return None
    if row == "camber":
        return "more positive" if re.search(r"least|positive", text, re.I) else (
            "more negative" if HIGH.search(text) or LIMIT_CUE.search(text) else None)
    # ride height, pressures
    return "lower" if LOW.search(text) else "higher" if HIGH.search(text) else None


def _clauses(text: str) -> list[str]:
    out = []
    for part in re.split(r"[.;!?\n]+|\bbut\b", text):
        bits = re.split(r"\band\b|,|&|\+", part)
        if len(bits) > 1 and sum(1 for b in bits if any(rx.search(b) for _, rx in ROW_WORDS)) == len(bits):
            out += bits  # "minimum ride height and the softest rear spring": two limits
        else:
            out.append(part)
    return [c.strip() for c in out if c.strip()]


def read_limits(text: str) -> list[dict]:
    """The limits a typed reply states: 'we're already at minimum ride height' -> ride height can't go lower on
    either axle; 'rear bar is on the softest' -> the rear bar can't go softer."""
    out: list[dict] = []
    for clause in _clauses(text):
        if not LIMIT_CUE.search(clause):
            continue
        for row, rx in ROW_WORDS:
            if not rx.search(clause):
                continue
            if row == "arb" and re.search(r"\b\d+(\.\d+)?\s*bar\b", clause, re.I):
                continue  # "1.4 bar" is a pressure
            rows = ("bump", "rebound") if row == "dampers" else (row,)
            if row == "dampers" and any(r.search(clause) for k, r in ROW_WORDS if k in ("bump", "rebound")):
                continue
            want = _want_in(clause, rows[0])
            if want is None:
                continue
            for r in rows:
                out.append({"row": r, "axle": _axle_in(clause, r), "want": want})
    return out


def read_problem(text: str) -> dict | None:
    """The car's problem in a typed message, as an observation dict: 'understeer mid-corner in T6'."""
    claim = read_claim(text)
    kind = "lock_up" if claim.kind == "abs" else claim.kind
    if kind not in KINDS:
        if re.search(r"bottom(s|ing|ed)?|kerbs?|curbs?|bump(s|y)\b", text, re.I):
            kind = "ride"
        else:
            return None
    if claim.negated:
        return None
    phase = {"traction": "exit", "lock_up": "braking", "braking_stability": "braking", "ride": None}.get(
        kind, claim.phase)
    speed = "fast" if FAST.search(text) else "slow" if SLOW.search(text) else None
    return {"kind": kind, "phase": phase, "corner": corner_in_text(text), "speed": speed, "text": text.strip()}


def read_reply(text: str) -> list[dict]:
    """What a typed reply asks, as actions: limit, tried (helped / no_better), skip, gone, reset, problem."""
    text = text.strip()
    if not text:
        return []
    if RESET.search(text):
        return [{"type": "reset"}]
    actions: list[dict] = [{"type": "limit", "limit": lim} for lim in read_limits(text)]
    if not actions and GENERIC_LIMIT.search(text):
        actions.append({"type": "limit_current"})
    if GONE.search(text):
        actions.append({"type": "gone"})
    elif TRIED_BAD.search(text):
        actions.append({"type": "tried", "result": "no_better"})
    elif TRIED_GOOD.search(text) and not NEGATION.search(text[:TRIED_GOOD.search(text).start()]):
        actions.append({"type": "tried", "result": "helped"})
    elif TRIED_ONLY.fullmatch(text):
        actions.append({"type": "tried", "result": "no_better"})
    if not actions:
        problem = read_problem(text)
        if problem:
            actions.append({"type": "problem", "problem": problem})
    if not actions and SKIP.search(text):
        actions.append({"type": "skip"})
    if not actions and MORE.search(text):
        actions.append({"type": "more"})
    return actions


# ---------- picking the next change ----------

def _observations(problems: list[dict]) -> list[Observation]:
    return [Observation(kind=p["kind"], phase=p.get("phase"), corner=p.get("corner"), speed=p.get("speed"),
                        source="driver", text=p.get("text") or p.get("label") or "") for p in problems]


def _first_option(lever: Lever, limits: list[dict], template: Template, values: dict
                  ) -> tuple[tuple[Target, ...], list[dict]] | None:
    """The first way of making the lever's change that the limits and the sheet allow, with its field changes."""
    for opt in lever.options:
        if not _option_ok(limits, opt):
            continue
        changes = _apply(template, values, opt)
        if changes is not None:
            return opt, changes
    return None


def ranked(problems: list[dict], data: list[dict] | None = None) -> list[tuple[str, float, str | None]]:
    """(lever key, score, reason from the data) best first: the run's ranked suggestions (driver and data), then
    the levers that answer the problems stated here."""
    out: list[tuple[str, float, str | None]] = []
    seen = set()
    for i, s in enumerate(data or []):
        if s.get("lever") in BY_KEY and s["lever"] not in seen:
            seen.add(s["lever"])
            # "understeer mid-corner at T6 (driver; data, 0.12 s)": who says so, in the tool's words
            reason = (s.get("reason") or "").replace(" (driver)", "").replace("(driver", "(debrief").replace(
                "; data", "; logger data").replace("(data", "(logger data")
            reason = f"It answers {reason}" if reason else ""
            if s.get("data_shows"):
                shows = f"The data shows {s['data_shows']}"
                reason = f"{reason}. {shows}" if reason else shows
            out.append((s["lever"], 100.0 - i, f"{reason}." if reason else None))
    obs = _observations(problems)
    scored = []
    for lever in CHAT_LEVERS:
        if lever.key in seen:
            continue
        score = sum(_contribution(lever, o) for o in obs) * lever.effort
        if score >= MIN_SCORE:
            scored.append((lever.key, round(score, 3), None))
    scored.sort(key=lambda x: -x[1])
    return out + scored


def next_change(state: dict, template: Template = BMW_M4_GT4_EVO, values: dict | None = None,
                data: list[dict] | None = None, past: list[dict] | None = None) -> dict | None:
    """The next change to offer: the best-ranked lever not tried, not skipped and not ruled out by a limit."""
    values = values or {}
    done = {t["lever"] for t in state.get("tried", [])} | set(state.get("skipped", []))
    limits = state.get("limits", [])
    ruled_out = []
    for key, score, reason in ranked(state.get("problems", []), data):
        if key in done:
            continue
        lever = BY_KEY[key]
        pick = _first_option(lever, limits, template, values)
        if pick is None:
            ruled_out.append(key)
            continue
        opt, changes = pick
        made_another_way = opt is not lever.options[0]
        return {"lever": key, "title": lever.title, "kind": lever.kind,
                "changes": [c["text"] for c in changes],
                "why": reason or _why(lever, state.get("problems", [])),
                "expected": lever.expected, "watch": lever.cost,
                "another_way": made_another_way, "limits": option_limits(opt), "score": score,
                "history": evidence(lever, past or [], state.get("problems", []), template),
                "ruled_out_before": [BY_KEY[k].title for k in ruled_out]}
    return None


def _why(lever: Lever, problems: list[dict]) -> str:
    helped = [p for p in problems if any(_contribution(lever, o) > 0 for o in _observations([p]))]
    names = [problem_label(p) for p in helped] or [problem_label(p) for p in problems]
    return "It answers " + " and ".join(names) + "." if names else ""


def problem_label(p: dict) -> str:
    base = next((x["label"] for x in PROBLEMS if x["kind"] == p["kind"] and x["phase"] == p.get("phase")), None)
    if base is None:
        base = Observation(kind=p["kind"], phase=p.get("phase")).describe()
    where = f" at {p['corner']}" if p.get("corner") else f" in {p['speed']} corners" if p.get("speed") else ""
    return base.lower() + where


# ---------- what the logged setups say ----------

def _matches(change: dict, targets: tuple[Target, ...], template: Template) -> bool:
    """A past change on the sheet (setup/sheet.py history: row, at, from, to) made the same way as one of these."""
    row = template.rows.get(change.get("row") or "")
    if row is None or change.get("from") is None or change.get("to") is None or change["to"] == change["from"]:
        return False
    up = change["to"] > change["from"]
    for t in targets:
        if SAME_ROW.get(t.row, t.row) != SAME_ROW.get(row.key, row.key):
            continue
        if t.positions and AXLE_OF.get(change.get("at") or "") not in {AXLE_OF.get(p) for p in t.positions}:
            continue
        wants_up = row.up == t.want
        if row.up is not None and (wants_up or OPPOSITE.get(t.want) == row.up) and up == wants_up:
            return True
    return False


def evidence(lever: Lever, past: list[dict], problems: list[dict], template: Template = BMW_M4_GT4_EVO) -> dict:
    """What the logged runs say about this change: how many times it was made (from one run's sheet to the next, at
    any event with this car), what the best lap did, and how the balance moved in the problem's phase.
    past: the run-to-run changes, each {"event", "run", "changes": [...], "deltas": {...} or None}."""
    hits = []
    for run in past:
        if any(_matches(c, opt, template) for c in run.get("changes", []) for opt in lever.options):
            hits.append(run)
    if not hits:
        return {"times": 0, "text": "Not logged before with this car, so this comes from the car's setup logic. "
                                    "Log each run's setup and the tool learns what your changes do."}
    timed = [h["deltas"]["best_s"] for h in hits if (h.get("deltas") or {}).get("best_s") is not None]
    parts = [f"Made {len(hits)} time{'s' if len(hits) != 1 else ''} before ("
             + ", ".join(f"{h['run']} at {h['event']}" for h in hits[:3]) + (", …" if len(hits) > 3 else "") + ")."]
    if timed:
        mean = sum(timed) / len(timed)
        parts.append(f"Best lap {'+' if mean > 0 else MINUS if mean < 0 else '±'}{abs(mean):.2f} s on average "
                     f"against the run before ({len(timed)} with timed laps; tyres and conditions differ).")
    phases = [p.get("phase") for p in problems if p.get("kind") in ("understeer", "oversteer")]
    phase = next((ph for ph in phases if ph in ("entry", "mid", "exit")), "mid" if phases else None)
    if phase:
        moves = [((h.get("deltas") or {}).get("balance") or {}).get(phase) for h in hits]
        moves = [m for m in moves if m is not None]
        if moves:
            towards_over = sum(1 for m in moves if m < 0)
            parts.append(f"The {'mid-corner' if phase == 'mid' else phase} balance moved towards oversteer "
                         f"{towards_over} of {len(moves)} times in the data.")
    return {"times": len(hits), "text": " ".join(parts)}


# ---------- one turn ----------

def new_state(variant: str = "evo") -> dict:
    return {"variant": variant if variant in VARIANTS else "evo", "session_id": None, "problems": [], "limits": [],
            "tried": [], "skipped": [], "current": None, "messages": []}


def _say(state: dict, who: str, text: str, change: dict | None = None) -> None:
    msg = {"from": who, "text": text, "at": datetime.now(UTC).isoformat(timespec="seconds")}
    if change is not None:
        msg["change"] = change
    state["messages"] = [*state.get("messages", []), msg][-80:]


def quick_replies(state: dict) -> list[dict]:
    """The one-tap answers for where the conversation is."""
    cur = state.get("current")
    if cur:
        out = []
        for lim in cur.get("limits", [])[:2]:
            out.append({"label": already_label(lim), "action": {"type": "limit", "limit": lim}})
        out += [{"label": "Tried it, it helped", "action": {"type": "tried", "result": "helped"}},
                {"label": "Tried it, no better", "action": {"type": "tried", "result": "no_better"}},
                {"label": "Something else", "action": {"type": "skip"}}]
        return out
    if state.get("problems"):
        return [{"label": "Still some left", "action": {"type": "more"}},
                {"label": "Problem gone", "action": {"type": "gone"}}]
    return [{"label": p["label"], "action": {"type": "problem", "problem": {"kind": p["kind"], "phase": p["phase"]}}}
            for p in PROBLEMS]


def _offer(state: dict, template: Template, values: dict | None, data: list[dict] | None, lead: list[str],
           past: list[dict] | None = None) -> None:
    change = next_change(state, template, values, data, past)
    state["current"] = change
    if change is None:
        if not state.get("problems") and not data:
            _say(state, "tool", " ".join([*lead, "What is the car doing? Pick one below or type it, for example "
                                                 "\"understeer mid-corner in T6\"."]).strip())
            return
        _say(state, "tool", " ".join([*lead, "I have no more changes for this with the limits you've given me. "
                                             "Check the tyre pressures and temperatures against the target, or "
                                             "clear a limit above if it no longer holds."]).strip())
        return
    lines = [*lead]
    if change["another_way"]:
        lines.append("The usual way is ruled out by a limit you gave me, so here is the same change made another "
                     "way.")
    lines.append(f"Try: {change['title']}.")
    _say(state, "tool", " ".join(lines), change)


def turn(state: dict, action: dict, template: Template = BMW_M4_GT4_EVO, values: dict | None = None,
         data: list[dict] | None = None, said: str | None = None, past: list[dict] | None = None) -> dict:
    """Apply one answer (an action from a tap, or read from typed text) and offer the next change. `said` is what
    the engineer typed or the tapped answer's words, kept in the conversation."""
    state = {**new_state(), **state}
    if said:
        _say(state, "you", said)
    kind = action.get("type")
    cur = state.get("current")
    lead: list[str] = []
    if kind == "reset":
        keep = {k: state[k] for k in ("variant", "session_id", "limits")}
        state = {**new_state(), **keep}
        lead.append("Started again. I kept the limits you gave me for this event.")
    elif kind == "problem":
        p = {k: v for k, v in action["problem"].items() if k in ("kind", "phase", "corner", "speed", "text")}
        if p.get("kind") in KINDS and p not in state["problems"]:
            state["problems"] = [*state["problems"], p]
        state["skipped"] = []
        lead.append(f"Noted: {problem_label(p)}.")
    elif kind in ("limit", "limit_current"):
        lims = [action["limit"]] if kind == "limit" else (cur or {}).get("limits", [])
        if not lims:
            lead.append("Which setting is at its limit? Say, for example, \"rear bar already softest\".")
        for lim in lims:
            state["limits"] = add_limit(state["limits"], lim)
            lead.append(f"Noted for this event: {_lc(limit_label(lim))}.")
    elif kind == "tried" and cur:
        state["tried"] = [*state["tried"], {"lever": cur["lever"], "title": cur["title"],
                                            "result": action.get("result", "no_better")}]
        if action.get("result") == "helped":
            state["current"] = None
            _say(state, "tool", f"Good: keep {cur['title'].lower()}. Is there some of the problem left?")
            return state
        lead.append(f"Noted: {cur['title'].lower()} made no difference, so I won't offer it again.")
    elif kind == "skip" and cur:
        state["skipped"] = [*state["skipped"], cur["lever"]]
        lead.append("All right, something else.")
    elif kind == "forget_limit":
        lim = action.get("limit") or {}
        state["limits"] = [x for x in state["limits"] if not (x["row"] == lim.get("row") and x["want"] ==
                                                               lim.get("want") and x.get("axle") == lim.get("axle"))]
        if lim.get("row"):
            lead.append(f"Cleared: {_lc(limit_label(lim))}.")
    elif kind == "gone":
        state["problems"], state["skipped"], state["current"] = [], [], None
        _say(state, "tool", "Great. What else is the car doing? Pick one below or type it.")
        return state
    _offer(state, template, values, data, lead, past)
    return state


def turn_text(state: dict, text: str, template: Template = BMW_M4_GT4_EVO, values: dict | None = None,
              data: list[dict] | None = None, past: list[dict] | None = None) -> dict:
    """A typed reply: read into actions, applied in order, with one offer at the end."""
    actions = read_reply(text)
    if not actions:
        state = {**new_state(), **state}
        _say(state, "you", text)
        _say(state, "tool", "I didn't catch that. You can tell me what the car does (\"oversteer on exit\"), a "
                            "setting that's at its limit (\"already at minimum ride height\", \"softest rear "
                            "spring\"), or answer with the buttons.")
        return state
    for i, a in enumerate(actions):
        if i < len(actions) - 1:  # earlier actions only update the state; the last one makes the offer
            state = _apply_quiet(state, a)
        else:
            state = turn(state, a, template, values, data, said=text, past=past)
    if len(actions) > 1:
        notes = [f"Noted for this event: {_lc(limit_label(a['limit']))}."
                 for a in actions[:-1] if a["type"] == "limit"]
        if notes:
            last = state["messages"][-1]
            last["text"] = " ".join([*notes, last["text"]])
    return state


def _apply_quiet(state: dict, a: dict) -> dict:
    state = {**new_state(), **state}
    if a["type"] == "limit":
        state["limits"] = add_limit(state["limits"], a["limit"])
    elif a["type"] == "problem" and a["problem"] not in state["problems"]:
        state["problems"] = [*state["problems"], a["problem"]]
    return state


def problems_after(state: dict, text: str | None = None, action: dict | None = None) -> list[dict]:
    """The problems the conversation will be on once this answer is taken in: what the run's data is weighed
    against before the turn is made."""
    problems = list(state.get("problems", []))
    for a in (read_reply(text) if text else [action or {}]):
        if a.get("type") in ("reset", "gone"):
            problems = []
        elif a.get("type") == "problem" and a.get("problem") and a["problem"] not in problems:
            problems.append(a["problem"])
    return problems


def view(state: dict) -> dict:
    """The conversation as the page shows it."""
    state = {**new_state(), **state}
    return {**state, "variant_label": VARIANTS.get(state["variant"], state["variant"]),
            "variants": [{"key": k, "label": v} for k, v in VARIANTS.items()],
            "limit_labels": [{**lim, "label": limit_label(lim)} for lim in state["limits"]],
            "problem_labels": [{**p, "label": _uc(problem_label(p))} for p in state["problems"]],
            "quick_replies": quick_replies(state), "problem_choices": list(PROBLEMS)}
