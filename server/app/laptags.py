"""Why a lap was slow, as the user tagged it: safety car, FCY or traffic; or "none" (looked at: no reason to leave it
out), or "count" (the user wants the lap in the stint's trends although the analysis would leave it out).

A new table (create_all adds it; nothing on the existing tables changes), keyed by session, logger file and lap
number so any screen can read it. Lap numbers come from the lap timing, which can change when a track's
start/finish line is learned again; the lap's start time is kept too, so a tag follows its lap when the numbers
move. No foreign keys: the tags of a session that is deleted are simply never read.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, Float, Integer, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import models
from app.db import Base

TAGS = ("sc", "fcy", "traffic", "none", "count")
MATCH_S = 3.0  # a tag follows its lap when the lap numbers change: the lap starting within this many seconds


def _now() -> datetime:
    return datetime.now(UTC)


class LapTag(Base):
    __tablename__ = "lap_tags"
    __table_args__ = (UniqueConstraint("file_id", "lap", name="uq_lap_tags_file_lap"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    file_id: Mapped[int] = mapped_column(Integer, index=True)
    lap: Mapped[int] = mapped_column(Integer)  # the lap number, as timed when it was tagged
    lap_start_s: Mapped[float | None] = mapped_column(Float)  # seconds into the log the lap started
    tag: Mapped[str] = mapped_column(String(16))  # one of TAGS
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


def tags_for_files(db: Session, file_ids: list[int]) -> dict[int, dict[int, str]]:
    """file id -> {lap number: tag}, each tag on the lap it was given to even if the laps were numbered again."""
    if not file_ids:
        return {}
    rows = db.scalars(select(LapTag).where(LapTag.file_id.in_(file_ids))).all()
    laps = db.execute(select(models.Lap.file_id, models.Lap.number, models.Lap.start_s)
                      .where(models.Lap.file_id.in_(file_ids))).all()
    starts: dict[int, dict[int, float]] = {}
    for fid, number, start in laps:
        starts.setdefault(fid, {})[number] = start
    out: dict[int, dict[int, str]] = {}
    for r in rows:
        own = starts.get(r.file_id, {})
        number = r.lap
        now = own.get(number)
        if r.lap_start_s is not None and (now is None or abs(now - r.lap_start_s) > MATCH_S):
            near = [n for n, s in own.items() if abs(s - r.lap_start_s) <= MATCH_S]
            if not near:
                continue  # its lap is gone
            number = near[0]
        out.setdefault(r.file_id, {})[number] = r.tag
    return out


def tag_row(db: Session, file_id: int, lap: models.Lap) -> LapTag | None:
    """The tag on this lap: found by when the lap started (its number may have changed since it was tagged), else
    by its number."""
    rows = db.scalars(select(LapTag).where(LapTag.file_id == file_id)).all()
    by_start = [r for r in rows if r.lap_start_s is not None and abs(r.lap_start_s - lap.start_s) <= MATCH_S]
    if by_start:
        return by_start[0]
    return next((r for r in rows if r.lap == lap.number and r.lap_start_s is None), None)


def set_tag(db: Session, file_id: int, session_id: int, lap: models.Lap, tag: str) -> LapTag:
    """Tag a lap (or tag it again), keyed by its number now. A tag left under that number by a lap that has since
    been numbered differently moves to its lap's number, or goes when its lap is gone."""
    row = tag_row(db, file_id, lap)
    if row is None or row.lap != lap.number:
        stale = db.scalar(select(LapTag).where(LapTag.file_id == file_id, LapTag.lap == lap.number))
        if stale is not None and stale is not row:
            moved = db.scalar(select(models.Lap).where(
                models.Lap.file_id == file_id, models.Lap.start_s.between((stale.lap_start_s or -1e9) - MATCH_S,
                                                                          (stale.lap_start_s or -1e9) + MATCH_S)))
            taken = moved is not None and db.scalar(select(LapTag).where(
                LapTag.file_id == file_id, LapTag.lap == moved.number)) is not None
            if moved is None or taken or moved.number == lap.number:
                db.delete(stale)
            else:
                stale.lap = moved.number
            db.flush()
    if row is None:
        row = LapTag(session_id=session_id, file_id=file_id, lap=lap.number)
        db.add(row)
    row.lap, row.tag, row.lap_start_s = lap.number, tag, lap.start_s
    return row


def to_dict(r: LapTag) -> dict:
    return {"session_id": r.session_id, "file_id": r.file_id, "lap": r.lap, "tag": r.tag,
            "lap_start_s": r.lap_start_s, "updated_at": r.updated_at.isoformat() if r.updated_at else None}
