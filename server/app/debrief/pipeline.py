"""Process a recorded debrief: transcribe, structure, and save the points against the session."""
from __future__ import annotations

from pathlib import Path

from app import db as dbmod
from app import models
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


def process_debrief(debrief_id: int) -> None:
    db = dbmod.SessionLocal()
    try:
        d = db.get(models.Debrief, debrief_id)
        if d is None or d.audio_path is None:
            return
        d.status, d.error = models.DebriefStatus.processing, None
        db.commit()
        s = d.session
        ctx = context_for(s, d.mode)
        try:
            names = [n for _, n in ctx.corners if n]
            tr = transcribe_mod.transcribe(Path(d.audio_path), d.language, key_terms=names)
            d.segments = [seg.__dict__ for seg in tr.segments]
            d.transcript = tr.text
            db.commit()
            result = structure_mod.structure(tr, ctx)
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
            d.points.append(models.DebriefPoint(
                section=p["section"], text=p["text"], speaker=p["speaker"], phase=p["phase"],
                corner_code=corner.code if corner else p["corner"], corner_id=corner.id if corner else None,
                audio_start_s=p["audio_start_s"],
                speaker_driver_id=s.driver_id if d.mode == "individual" and _is_driver(d.speakers, p) else None,
            ))
        d.status = models.DebriefStatus.ready
        db.commit()
    finally:
        db.close()


def _is_driver(speakers: dict, point: dict) -> bool:
    return speakers.get(point["speaker"] or "", {}).get("role") == "driver"
