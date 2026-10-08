"""The start/finish line a track's laps are timed from: learned from the best source, and re-timed when it moves."""
import math
from functools import cache

import numpy as np

from tests.synthetic import simulate, write_ld
from tests.test_imports import make_zip, sessions_by_name, upload

AUTO_GPS_DELAY_S = 0.75  # i2's "Auto GPS" beacons in the Hockenheim test sat about 0.75 s past the dash's line


@cache
def run() -> tuple[dict, tuple[float, ...], np.ndarray]:
    """A log, its lap times and the times it crosses the dash's line (end of the out-lap and of each lap)."""
    channels, lap_times = simulate()
    return channels, tuple(lap_times), np.cumsum([0, *lap_times])[1:-1]


def marked() -> bytes:
    return write_ld(run()[0])


def unmarked() -> bytes:
    return write_ld({k: v for k, v in run()[0].items() if k not in ("S/F Marker", "Lap Time")})


def counter_only() -> bytes:
    """No marker and no lap time, only a 1 Hz lap counter: like the first run of the Hockenheim test."""
    channels, lap_times, _ = run()
    out = {k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")}
    seconds = np.arange(len(channels["GPS Latitude"][2]) // 20 + 1)
    out["Lap Number"] = (1, "", np.floor(np.interp(seconds, np.cumsum([0, *lap_times]), np.arange(len(lap_times) + 1))))
    return write_ld(out)


def auto_gps_ldx() -> bytes:
    """Beacons past the dash's line, one lap missing: like i2's "Auto GPS" beacons."""
    beacons = np.delete(run()[2] + AUTO_GPS_DELAY_S, 2)
    marks = "".join(f'<Marker ClassName="BCN" Name="Auto GPS {i}" Time="{t * 1e6}"/>' for i, t in enumerate(beacons))
    return (f"<LDXFile><Layers><Layer><MarkerBlock><MarkerGroup>{marks}</MarkerGroup></MarkerBlock></Layer>"
            "</Layers></LDXFile>").encode()


def metres(a: dict, b: dict) -> float:
    dx = math.radians(b["lon"] - a["lon"]) * 6_371_000 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, math.radians(b["lat"] - a["lat"]) * 6_371_000)


def dash_line() -> dict:
    from app.analysis.laps import lap_starts, timing_line_at
    from app.importers.motec import read_ld

    ld = read_ld(marked())
    return timing_line_at(ld, list(lap_starts(ld)[0]), "marker").__dict__


def db_state():
    """The track, and every log with the times its laps start, straight from the database. (The synthetic car
    starts its log on the line, so a GPS-timed log also has a lap starting at 0 s; it's left out.)"""
    import app.db
    import app.models

    with app.db.SessionLocal() as db:
        (track,) = db.query(app.models.Track).all()
        files = {f.filename: (f.meta, sorted(l.start_s for l in f.session.laps if l.start_s > 5))
                 for f in db.query(app.models.LoggerFile)}
        return track.timing_line, files


def test_a_zip_import_times_every_run_from_the_dash_marker_line(client):
    """The Hockenheim zip: the first run has only a lap counter, the second only "Auto GPS" beacons in its .ldx,
    the third the dash's S/F marker. The line ends up where the marker puts it, whatever the order."""
    from app import timing

    _, lap_times, crossings = run()
    job = upload(client, ("Hockenheim test.zip", make_zip({
        "Hockenheim test/01_D1S1/a.ld": counter_only(),
        "Hockenheim test/02_D1S2/b.ld": unmarked(),
        "Hockenheim test/02_D1S2/b.ldx": auto_gps_ldx(),
        "Hockenheim test/03_D1S3/c.ld": marked(),
    })))
    assert job["status"] == "done" and job["errors"] == []
    timing.wait_idle()  # the runs timed before the marker run came are re-timed in the background

    line, files = db_state()
    assert line["source"] == "marker" and metres(line, dash_line()) < 1
    assert {name: meta["lap_source"] for name, (meta, _) in files.items()} == {"a.ld": "gps", "b.ld": "gps",
                                                                                "c.ld": "marker"}
    for name, (meta, starts) in files.items():
        assert np.allclose(starts[:4], crossings[:4], atol=0.1), name  # every run's laps start on the dash's line
        assert meta["timed_line"] == line
    assert len(files["b.ld"][0]["beacons"]) == 4  # the beacons are kept, they just don't time the laps

    runs = sessions_by_name(client, job)
    for s in runs.values():
        assert abs(s["best_lap_s"] - min(lap_times)) < 0.1  # the beacons missed the best lap
        assert s["track_name"] == "Test Track" and s["event_name"] == "Hockenheim test"
    listed = {s["name"]: s for s in client.get("/sessions").json()}
    assert {listed[n]["track_name"] for n in runs} == {"Test Track"}


def test_beacons_time_the_laps_until_a_marker_log_comes(client):
    from app import timing

    _, _, crossings = run()
    job = upload(client, ("day.zip", make_zip({"01/b.ld": unmarked(), "01/b.ldx": auto_gps_ldx(),
                                               "02/a.ld": counter_only()})))
    timing.wait_idle()
    line, files = db_state()
    assert line["source"] == "beacons" and metres(line, dash_line()) > 20
    assert files["b.ld"][0]["lap_source"] == "beacons" and files["a.ld"][0]["lap_source"] == "gps"
    assert abs(files["a.ld"][1][0] - (crossings[0] + AUTO_GPS_DELAY_S)) < 0.1  # from the beacons' line, for now

    s = client.post("/sessions", json={"name": "marker run"}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("c.ld", marked())})
    assert r.status_code == 201, r.text
    timing.wait_idle()
    line, files = db_state()
    assert line["source"] == "marker" and metres(line, dash_line()) < 1
    assert files["b.ld"][0]["lap_source"] == files["a.ld"][0]["lap_source"] == "gps"
    assert np.allclose(files["a.ld"][1][:4], crossings[:4], atol=0.1)
    assert len(job["session_ids"]) == 2


def test_a_line_saved_by_older_code_corrects_itself_on_startup(client):
    """The live database holds the line older code learned from the "Auto GPS" beacons, with no source, and the
    runs it timed. The startup check replaces it with the marker run's line and re-times those runs."""
    import app.db
    import app.models
    from app import timing
    from app.analysis.laps import TimingLine, time_laps
    from app.importers.motec import read_ld

    _, lap_times, crossings = run()
    upload(client, ("day.zip", make_zip({"01/a.ld": counter_only(), "02/b.ld": unmarked(), "02/b.ldx": auto_gps_ldx(),
                                         "03/c.ld": marked()})))
    timing.wait_idle()
    old = {k: v for k, v in time_laps(read_ld(unmarked()), list(crossings + AUTO_GPS_DELAY_S)).line.__dict__.items()
           if k != "source"}
    with app.db.SessionLocal() as db:  # back to what the older code left
        track = db.query(app.models.Track).one()
        track.timing_line = old
        for f in db.query(app.models.LoggerFile):
            meta = {k: v for k, v in f.meta.items() if k != "timed_line"}
            if f.filename != "c.ld":
                legacy = time_laps(timing.read_file(f), meta.get("beacons"), TimingLine(**old))
                timing.store_laps(db, f.session, f, legacy, None)
                meta["lap_source"] = legacy.source
            f.meta = meta
        db.commit()
    line, files = db_state()
    assert "source" not in line and files["b.ld"][0]["lap_source"] == "beacons"
    assert abs(files["a.ld"][1][0] - (crossings[0] + AUTO_GPS_DELAY_S)) < 0.1

    timing.check_all_tracks()  # what the server does when it starts
    timing.wait_idle()
    line, files = db_state()
    assert line["source"] == "marker" and metres(line, dash_line()) < 1
    for name, (_, starts) in files.items():
        assert np.allclose(starts[:4], crossings[:4], atol=0.1), name
    assert files["b.ld"][0]["timed_line"] == line

    with app.db.SessionLocal() as db:  # a second start finds nothing to do and reads no log
        stamps = {f.id: f.meta["timed_line"] for f in db.query(app.models.LoggerFile) if "timed_line" in f.meta}
    timing.check_all_tracks()
    timing.wait_idle()
    with app.db.SessionLocal() as db:
        assert {f.id: f.meta["timed_line"] for f in db.query(app.models.LoggerFile) if "timed_line" in f.meta} == stamps
    assert len(client.get("/sessions").json()) == 3 and all(abs(s["best_lap_s"] - min(lap_times)) < 0.1
                                                         for s in client.get("/sessions").json())


def test_re_timing_waits_while_other_work_reads_a_log(client):
    """The background re-timing reads its logs under heavy.lock, like every request and import that reads one."""
    import time

    import app.db
    import app.models
    from app import heavy, timing

    upload(client, ("day.zip", make_zip({"01/a.ld": counter_only(), "02/c.ld": marked()})))
    timing.wait_idle()
    with app.db.SessionLocal() as db:  # a.ld timed from an older line
        f = db.query(app.models.LoggerFile).filter_by(filename="a.ld").one()
        f.meta = {**f.meta, "timed_line": {"lat": 0.0, "lon": 0.0, "heading": 0.0}}
        db.commit()
        track_id = db.query(app.models.Track).one().id

    with heavy.lock:  # a request reading a log
        timing.schedule(track_id)
        time.sleep(0.3)
        assert db_state()[1]["a.ld"][0]["timed_line"]["lat"] == 0.0  # waiting its turn
    timing.wait_idle()
    line, files = db_state()
    assert files["a.ld"][0]["timed_line"] == line


def test_a_single_upload_puts_the_session_at_its_track(client):
    a = client.post("/sessions", json={"name": "FP1"}).json()
    assert a["track_name"] is None
    r = client.post(f"/sessions/{a['id']}/files", files={"file": ("a.ld", marked())}).json()
    assert r["track_name"] == "Test Track" and r["event_name"] == "TEST EVENT"  # from the log header
    (event,) = client.get("/events").json()
    assert event["track_id"] == client.get("/tracks").json()[0]["id"] and event["date"] == "2026-07-03"

    b = client.post("/sessions", json={"name": "FP2"}).json()
    r = client.post(f"/sessions/{b['id']}/files", files={"file": ("b.ld", marked())}).json()
    assert r["event_id"] == event["id"]  # the same event and day: one event

    own = client.post("/events", json={"name": "My test day"}).json()  # an event made without a track
    c = client.post("/sessions", json={"name": "FP3", "event_id": own["id"]}).json()
    r = client.post(f"/sessions/{c['id']}/files", files={"file": ("c.ld", marked())}).json()
    assert r["event_id"] == own["id"] and r["event_name"] == "My test day" and r["track_name"] == "Test Track"
    listed = {s["name"]: s["track_name"] for s in client.get("/sessions").json()}
    assert listed == {"FP1": "Test Track", "FP2": "Test Track", "FP3": "Test Track"}


def test_logs_timed_by_older_lap_timing_are_timed_again_once(client, monkeypatch, settle):
    """The live Zandvoort data: older lap timing took two pulses of the dash's marker 3 s apart for a lap. In a pit
    log that was the log's only "lap", clean and the best of the event; in a run it cut a lap in two. On startup
    each log timed by older lap timing is timed again, once: the pit log's run is then an empty run and goes,
    unless the user entered something on it, and what was worked out from the laps follows."""
    import app.db
    import app.models
    from app import timing
    from app.analysis import laps
    from app.vehicle import tyre_store
    from tests.test_empty_runs import pit_channels
    from tests.test_lap_crossings import pulses

    channels, lap_times, crossings = run()
    marker = pulses(len(channels["S/F Marker"][2]), *crossings, crossings[2] + 3.0)
    split_run = write_ld({**channels, "S/F Marker": (10, "", marker)})
    pit = pit_channels(60.0, 12.0)
    pit_log = write_ld({**pit, "S/F Marker": (10, "", pulses(len(pit["S/F Marker"][2]), 30.0, 33.0))})
    with monkeypatch.context() as m:  # timed as older code timed them, keeping every crossing
        m.setattr(laps, "one_per_pass", lambda starts, ld: np.asarray(starts, float))
        job = upload(client, ("R2.zip", make_zip({"R2/01_run/run.ld": split_run, "R2/02_pit/pit.ld": pit_log,
                                                  "R2/03_debriefed/pit.ld": pit_log})))
        timing.wait_idle()
    ids = {name: s["id"] for name, s in sessions_by_name(client, job).items()}
    assert [len(client.get(f"/sessions/{ids[n]}").json()["laps"]) for n in sorted(ids)] == [5, 1, 1]
    (folder,) = client.get("/events/folders").json()
    assert abs(folder["best_lap_s"] - 3.0) < 0.11  # "best 3.00" for the whole event
    assert client.post(f"/sessions/{ids['03_debriefed']}/debriefs", json={"transcript": "Pit stop practice"}
                       ).status_code == 201
    tyre_store.stop()  # its summaries are checked below, not made
    # the import's reports count each log's warm-up in the background, writing its meta: done before this rewrites it
    settle()
    with app.db.SessionLocal() as db:  # what older code left: no timing version, tyre data up to date
        for f in db.query(app.models.LoggerFile):
            f.meta = {k: v for k, v in f.meta.items() if k != "timing_version"}
            db.add(app.models.TyreData(file_id=f.id, session_id=f.session_id, version=tyre_store.version(),
                                       status="none", car_key="k", car_label="k", preset=tyre_store.PRESET,
                                       tyre="Pirelli P Zero DHG", lap_source=tyre_store.timing_key(f.meta)))
        db.commit()
        assert tyre_store.pending(db) == []

    timing.check_all_tracks()  # what the server does when it starts
    timing.wait_idle()
    s = client.get(f"/sessions/{ids['01_run']}").json()
    assert len(s["laps"]) == 4 and abs(s["best_lap_s"] - min(lap_times[1:5])) < 0.11
    assert client.get(f"/sessions/{ids['02_pit']}").status_code == 404  # an empty run: removed
    assert client.get(f"/sessions/{ids['03_debriefed']}").json()["laps"] == []  # kept: it has a debrief
    (folder,) = client.get("/events/folders").json()
    assert folder["sessions"] == 2 and abs(folder["best_lap_s"] - min(lap_times[1:5])) < 0.11
    with app.db.SessionLocal() as db:
        files = db.query(app.models.LoggerFile).all()
        assert {f.meta["timing_version"] for f in files} == {laps.TIMING_VERSION}
        assert sorted(tyre_store.pending(db)) == sorted(f.id for f in files)  # their laps changed: made again

    reads = []

    def read(f):
        reads.append(f.id)
        raise OSError("not read")

    monkeypatch.setattr(timing, "read_file", read)
    timing.check_all_tracks()  # a second start finds nothing to do and reads no log
    timing.wait_idle()
    assert reads == []


def test_on_startup_the_logs_are_read_once_and_only_tracks_with_work_are_checked(client, monkeypatch):
    """check_all_tracks reads every log's row once (not once per track) and schedules only the tracks, and the logs
    at no track, that have a log to re-time."""
    from sqlalchemy import event

    import app.db
    import app.models
    from app import timing

    a = client.post("/sessions", json={"name": "FP1"}).json()
    assert client.post(f"/sessions/{a['id']}/files", files={"file": ("a.ld", marked())}).status_code == 201
    b = client.post("/sessions", json={"name": "FP2"}).json()
    assert client.post(f"/sessions/{b['id']}/files", files={"file": ("b.ld", marked())}).status_code == 201
    timing.wait_idle()
    for name in ("Monza", "Spa"):
        assert client.post("/tracks", json={"name": name}).status_code in (200, 201)
    with app.db.SessionLocal() as db:  # FP2's log at no track: no event, a venue that is no track
        s = db.get(app.models.RunSession, b["id"])
        s.event = None
        s.files[0].meta = {**s.files[0].meta, "venue": "Nowhere"}
        db.commit()
        tracks = {t.name: t for t in db.query(app.models.Track)}
        assert [f.session_id for f in timing.files_at(db, tracks["Test Track"])] == [a["id"]]
        assert [f.session_id for f in timing.files_at(db, None)] == [b["id"]]
        assert timing.files_at(db, tracks["Monza"]) == []
        test_track = tracks["Test Track"].id

    scheduled, selects = [], []
    monkeypatch.setattr(timing, "schedule", scheduled.append)

    def count(conn, cursor, statement, *args):
        if "FROM logger_files" in statement:
            selects.append(statement)
    engine = app.db.SessionLocal.kw["bind"]
    event.listen(engine, "before_cursor_execute", count)
    try:
        timing.check_all_tracks()  # everything up to date: nothing to check
        assert scheduled == [] and len(selects) == 1
        with app.db.SessionLocal() as db:  # timed by older code, at the track and at no track
            for f in db.query(app.models.LoggerFile):
                f.meta = {k: v for k, v in f.meta.items() if k != "timing_version"}
            db.commit()
        selects.clear()
        timing.check_all_tracks()
        assert scheduled == [test_track, timing.NO_TRACK] and len(selects) == 1
    finally:
        event.remove(engine, "before_cursor_execute", count)
