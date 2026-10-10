"""Process a recorded debrief: transcribe, structure, and save the points against the session.

Speech to text is Deepgram when DEEPGRAM_API_KEY is set, else what the phone wrote down while recording
(LiveTranscript, free). Structuring is Claude when ANTHROPIC_API_KEY is set, else keyword sorting (keywords.py, free).
"""
from __future__ import annotations

import os
import re

from sqlalchemy import select

from app import db as dbmod
from app import models, storage
from app.debrief import keywords as keywords_mod
from app.debrief import structure as structure_mod
from app.debrief import transcribe as transcribe_mod


def context_for(s: models.RunSession, mode: str) -> structure_mod.Context:
    track = s.event.track if s.event else None
    return structure_mod.Context(
        track=track.name if track else None,
        corners=[(c.code, c.name) for c in track.corners] if track else [],
        car=s.car.name if s.car else None,
        session=" ".join(x for x in (s.event.name if s.event else None, s.kind, s.name) if x) or None,
        drivers=[s.driver.name] if s.driver else [],
        mode=mode,
    )


def _match_corner(said: str | None, corners: list[models.Corner]) -> models.Corner | None:
    if not said:
        return None
    key = said.strip().lower()
    return next((c for c in corners if c.code.lower() == key or (c.name and c.name.lower() == key)), None)


def process_debrief(debrief_id: int, edited: bool = False) -> None:
    """Transcribes the recording and sorts what was said into points. edited: the transcript was corrected by hand
    (PUT /debriefs/{id}/transcript), so it is sorted again as it stands, without going back to the recording."""
    db = dbmod.SessionLocal()
    try:
        d = db.get(models.Debrief, debrief_id)
        if d is None or (d.audio_path is None and not edited):
            return
        d.status, d.error = models.DebriefStatus.processing, None
        db.commit()
        s = d.session
        ctx = context_for(s, d.mode)
        try:
            if edited:
                tr = from_text(d.transcript or "", d.segments or [])
            else:
                tr = _transcript(db, d, ctx)
                d.transcript = tr.text
            d.segments = [seg.__dict__ for seg in tr.segments]
            db.commit()
            if os.environ.get("ANTHROPIC_API_KEY"):
                result = structure_mod.structure(tr, ctx)
            else:
                result = keywords_mod.structure(tr, ctx)
        except Exception as e:  # keep the audio and say why, so it can be processed again later
            d.status, d.error = models.DebriefStatus.failed, str(e)
            db.commit()
            return

        corners = s.event.track.corners if s.event and s.event.track else []
        d.summary = result["summary"]
        d.speakers = {sp["label"]: {"role": sp["role"], "name": sp["name"]} for sp in result["speakers"]}
        d.points = []
        for p in result["points"]:
            corner = _match_corner(p["corner"], corners)
            said = corner.code if corner else p["corner"]
            d.points.append(models.DebriefPoint(
                section=p["section"], text=p["text"], speaker=_fit(p["speaker"]), phase=p["phase"],
                corner_code=_fit(said), corner_id=corner.id if corner else None,
                audio_start_s=p["audio_start_s"],
                speaker_driver_id=s.driver_id if d.mode == "individual" and _is_driver(d.speakers, p) else None,
            ))
        d.status = models.DebriefStatus.ready
        db.commit()
    finally:
        db.close()


SPEAKER_LINE = re.compile(r"^\s*(S\d+)\s*:\s*(.*)$")


def from_text(text: str, old: list[dict]) -> transcribe_mod.Transcript:
    """A transcript corrected by hand, back into segments: one per line, "S1: ..." names the speaker (a line without
    one keeps the speaker before it). Line n keeps the times of the n-th segment it was written from, so the points
    still play from about where they were said."""
    segs: list[transcribe_mod.Segment] = []
    speaker = "S0"
    for line in (x for x in text.splitlines() if x.strip()):
        m = SPEAKER_LINE.match(line)
        speaker, said = (m.group(1), m.group(2)) if m else (speaker, line)
        if not said.strip():
            continue
        was = old[len(segs)] if len(segs) < len(old) else (old[-1] if old else {})
        start = float(was.get("start") or 0)
        segs.append(transcribe_mod.Segment(speaker, start, float(was.get("end") or start), said.strip()))
    return transcribe_mod.Transcript(segs)


def _transcript(db, d: models.Debrief, ctx: structure_mod.Context) -> transcribe_mod.Transcript:
    """Deepgram's transcript when its key is set, else the phone's own (no speakers told apart)."""
    if not os.environ.get("DEEPGRAM_API_KEY"):
        live = db.scalar(select(models.LiveTranscript).where(models.LiveTranscript.audio_path == d.audio_path))
        if live is not None and live.segments:
            return transcribe_mod.Transcript([
                transcribe_mod.Segment("S0", float(x.get("start") or 0), float(x.get("end") or 0), x["text"].strip())
                for x in live.segments if (x.get("text") or "").strip()])
    names = [n for _, n in ctx.corners if n]
    return transcribe_mod.transcribe(storage.local_path(d.audio_path), d.language, key_terms=names)


def _fit(label: str | None, n: int = 16) -> str | None:
    """Speaker and corner labels as said, cut to their column's length."""
    return label[:n] if label else label


def _is_driver(speakers: dict, point: dict) -> bool:
    return speakers.get(point["speaker"] or "", {}).get("role") == "driver"
