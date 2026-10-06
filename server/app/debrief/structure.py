"""Turn a debrief transcript into report points with Claude.

Each point lands in one report section and, where the speaker says so, is tagged with the corner
and the corner phase, so it can later sit next to the logger data for that corner.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from app.debrief.transcribe import NotConfigured, Transcript

MODEL = "claude-opus-5-5"

# Report sections, in report order. Keys match the app's section chips.
SECTIONS = {
    "balance": "Car balance: understeer, oversteer, stability, by speed range",
    "corners": "Corner by corner remarks that are not mainly about balance",
    "tyres": "Tyres: grip, warm-up, pressures, degradation, graining",
    "brakes": "Brakes and ABS: feel, stability under braking, locking, ABS intervention",
    "electronics": "Electronics: TC, engine maps, gearshift, dash and alarms",
    "traction": "Traction and power: exit traction, wheelspin, power delivery",
    "ride": "Ride and kerbs: bumps, kerb riding, bottoming, platform",
    "setup": "Setup changes the driver or engineer asks for or proposes",
    "issues": "Issues: faults, damage, traffic, track limits, anything that went wrong",
    "priorities": "Driver priorities: the one to three things the driver most wants fixed",
}
PHASES = ["braking", "entry", "mid", "exit"]
ROLES = ["driver", "engineer", "coach", "other"]

SYSTEM = """You structure post-session debriefs from motorsport (GT and touring cars) into an engineering report.

The transcript comes from speech to text with automatic speaker labels (S0, S1, ...). It may contain \
recognition errors, especially in corner names and technical terms. Use the session context to fix them \
when the intended word is clear.

Rules:
- One point per distinct statement about the car, the driver's driving, or the session. Merge repeats \
of the same statement into one point.
- Keep the speaker's meaning and their level of certainty. Do not add causes or fixes that nobody said.
- Write each point as a short, complete sentence in the language the debrief was spoken in. Keep \
technical terms as the speaker used them.
- Tag a corner only when the speaker names or clearly describes it. Use the track's corner codes when \
the context lists them; otherwise use the name the speaker used. Tag the phase only when it is said or \
plainly implied (for example "on the brakes" is braking, "at turn-in" is entry, "at the apex" is mid, \
"on the way out" is exit).
- audio_start_s is the start time of the segment the point mainly comes from.
- Skip small talk and anything not about the run.
- The summary is two or three sentences an engineer would read first: the main balance trait and \
the driver's top priority."""


@dataclass
class Context:
    track: str | None = None
    corners: list[tuple[str, str | None]] = field(default_factory=list)  # (code, name)
    car: str | None = None
    session: str | None = None
    drivers: list[str] = field(default_factory=list)
    mode: str = "individual"

    def describe(self) -> str:
        lines = [f"Debrief mode: {self.mode}"]
        if self.session:
            lines.append(f"Session: {self.session}")
        if self.car:
            lines.append(f"Car: {self.car}")
        if self.drivers:
            lines.append(f"Drivers: {', '.join(self.drivers)}")
        if self.track:
            lines.append(f"Track: {self.track}")
        if self.corners:
            lines.append("Corners: " + "; ".join(f"{c} ({n})" if n else c for c, n in self.corners))
        return "\n".join(lines)


def _nullable(schema: dict) -> dict:
    return {"anyOf": [schema, {"type": "null"}]}


SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "speakers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "role": {"type": "string", "enum": ROLES},
                    "name": _nullable({"type": "string"}),
                },
                "required": ["label", "role", "name"],
                "additionalProperties": False,
            },
        },
        "points": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "section": {"type": "string", "enum": list(SECTIONS)},
                    "text": {"type": "string"},
                    "speaker": _nullable({"type": "string"}),
                    "corner": _nullable({"type": "string"}),
                    "phase": _nullable({"type": "string", "enum": PHASES}),
                    "audio_start_s": _nullable({"type": "number"}),
                },
                "required": ["section", "text", "speaker", "corner", "phase", "audio_start_s"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "speakers", "points"],
    "additionalProperties": False,
}


def build_prompt(transcript: Transcript, ctx: Context) -> str:
    sections = "\n".join(f"- {k}: {v}" for k, v in SECTIONS.items())
    lines = "\n".join(f"[{s.speaker} {s.start:.1f}s] {s.text}" for s in transcript.segments)
    return (f"<session>\n{ctx.describe()}\n</session>\n\n<sections>\n{sections}\n</sections>\n\n"
            f"<transcript>\n{lines}\n</transcript>")


def structure(transcript: Transcript, ctx: Context) -> dict:
    """Returns {"summary", "speakers", "points"} as described by SCHEMA."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise NotConfigured("Debrief structuring isn't set up yet: ANTHROPIC_API_KEY is missing on the server")
    if not transcript.segments:
        return {"summary": "", "speakers": [], "points": []}
    import anthropic  # here, not at the top: the SDK takes about 30 MB of the server's memory from when it's imported

    client = anthropic.Anthropic()
    # Refusals are unlikely for debriefs, but "default" fallbacks re-run a declined request on another
    # model instead of failing the debrief.
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        system=SYSTEM,
        messages=[{"role": "user", "content": build_prompt(transcript, ctx)}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("The debrief could not be structured (the request was declined)")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The debrief was too long to structure in one pass")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)
