"""Tracks, drivers, cars and events: the reference data sessions hang off."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.known_tracks import fill_corners

router = APIRouter()


@router.post("/tracks", response_model=schemas.TrackOut, status_code=201)
def create_track(body: schemas.TrackIn, db: Session = Depends(get_db)):
    track = models.Track(name=body.name, length_m=body.length_m,
                         corners=[models.Corner(**c.model_dump()) for c in body.corners])
    fill_corners(track)
    db.add(track)
    db.commit()
    return track


@router.put("/tracks/{track_id}/corners", response_model=schemas.TrackOut)
def set_corners(track_id: int, body: list[schemas.CornerIn], db: Session = Depends(get_db)):
    """Replace the track's corners: numbers, positions and which corners are analysed as one sector."""
    track = db.get(models.Track, track_id)
    if track is None:
        raise HTTPException(404, "Track not found")
    track.corners = [models.Corner(**c.model_dump()) for c in body]
    db.commit()
    db.refresh(track)
    return track


@router.get("/tracks", response_model=list[schemas.TrackOut])
def list_tracks(db: Session = Depends(get_db)):
    return db.scalars(select(models.Track).order_by(models.Track.name)).all()


@router.get("/tracks/{track_id}", response_model=schemas.TrackOut)
def get_track(track_id: int, db: Session = Depends(get_db)):
    track = db.get(models.Track, track_id)
    if track is None:
        raise HTTPException(404, "Track not found")
    return track


@router.post("/drivers", response_model=schemas.DriverOut, status_code=201)
def create_driver(body: schemas.DriverIn, db: Session = Depends(get_db)):
    driver = models.Driver(**body.model_dump())
    db.add(driver)
    db.commit()
    return driver


@router.get("/drivers", response_model=list[schemas.DriverOut])
def list_drivers(db: Session = Depends(get_db)):
    return db.scalars(select(models.Driver).order_by(models.Driver.name)).all()


@router.post("/cars", response_model=schemas.CarOut, status_code=201)
def create_car(body: schemas.CarIn, db: Session = Depends(get_db)):
    car = models.Car(**body.model_dump())
    db.add(car)
    db.commit()
    return car


@router.get("/cars", response_model=list[schemas.CarOut])
def list_cars(db: Session = Depends(get_db)):
    return db.scalars(select(models.Car).order_by(models.Car.name)).all()


@router.post("/events", response_model=schemas.EventOut, status_code=201)
def create_event(body: schemas.EventIn, db: Session = Depends(get_db)):
    event = models.Event(**body.model_dump())
    db.add(event)
    db.commit()
    return event


@router.get("/events", response_model=list[schemas.EventOut])
def list_events(db: Session = Depends(get_db)):
    return db.scalars(select(models.Event).order_by(models.Event.date.desc().nulls_last())).all()
