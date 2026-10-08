"""A run with a driver change at a stop split into one run per driver (app/run_split.py): the windowed log each part
reads (importers/window.py), the parts' laps, names and drivers, no split without a stop, a part never split again,
and the deletes that keep a stored log while another run still reads it. Synthetic logs only."""
import time

import numpy as np
from sqlalchemy import select

from app.analysis import driver_style as ds
from app.importers.csvlog import read_csv_log
from app.importers.motec import read_ld
from app.importers.window import shift_clock, window
from tests import synthetic
from tests.synthetic import simulate, write_ld
from tests.test_driver_style import _sharp_speed
from tests.test_results import fake_site  # noqa: F401  (the series' site stand-in)

PACES = (1.0, 0.99, 0.995, 0.985, 0.99, 0.99, 0.985, 0.99, 0.995, 0.99)
STINTS = ((1, 2, 3, 4), (6, 7, 8, 9, 10))  # the stop is in lap 5


def _log(stop_s: float = 40.0, day: str = "03/07/2026", at: str = "12:00:00") -> bytes:
    """Ten laps with a stop at the line at the end of the fifth (none when stop_s is 0)."""
    data = write_ld(simulate(paces=PACES, stops={5: stop_s} if stop_s else None)[0])
    return data.replace(b"03/07/2026", day.encode(), 1).replace(b"12:00:00", at.encode(), 1)


def _run(client, event_id: int, name: str | None = None, **log) -> int:
    s = client.post("/sessions", json={"event_id": event_id, **({"name": name} if name else {})}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("long run.ld", _log(**log))})
    assert r.status_code == 201, r.text
    return s["id"]


def _guess(sid: int, drivers=(None, None), stints=STINTS, mode="groups") -> ds.Guess:
    """Two styles in the run, one stint each (drivers: who each style is, when known)."""
    groups = [ds.Group(d, "tag" if d else "", 0) for d in drivers]
    run = ds.SessionGuess(sid, 1, 0.5, 9, [ds.Stint(list(st), i, 1.0) for i, st in enumerate(stints)])
    return ds.Guess(mode, 0.3, groups, [run], np.zeros(0, int))


def _laps(db, sid: int) -> list[tuple]:
    from app import models

    s = db.get(models.RunSession, sid)
    return [(l.number, round(l.start_s, 3), round(l.time_s, 3), l.clean) for l in s.laps]


# ---------- the windowed log ----------

def test_a_windowed_motec_log_starts_at_0_at_its_part():
    from app import models, storage, timing

    data = write_ld({"vCar": (10, "km/h", np.arange(600.0)), "Lap Time": (1, "s", np.arange(60.0)),
                     "gLat": (100, "G", np.arange(6000.0) / 100)})
    ld = read_ld(data)
    part = window(ld, 20.0, 40.0)
    v = part.channel("vCar")
    assert v.count == 200 and v.times()[0] == 0 and v.values()[0] == 200 and v.values()[-1] == 399
    assert part.channel("Lap Time").values().tolist() == list(range(20, 40))
    assert part.channel("gLat").values()[0] == 20 and part.duration == 20
    assert (part.date, part.time) == ("03/07/2026", "12:00:20")
    assert ld.channel("vCar").count == 600 and ld.time == "12:00:00"  # the log itself is untouched
    assert window(ld, 50.0, 70.0).channel("vCar").count == 100  # a window past the end stops at the end

    f = models.LoggerFile(path=storage.save(data, ".ld"), meta={"window": [20.0, 40.0]})
    assert timing.read_file(f).channel("vCar").values()[0] == 200
    f.meta = {}
    assert timing.read_file(f).channel("vCar").values()[0] == 0


def test_a_windowed_csv_export_starts_at_0_at_its_part():
    t = np.arange(0, 60, 0.1)
    rows = ['"Format","MoTeC CSV File"', '"Venue","Test Track"', '"Log Date","31/12/2025"', '"Log Time","23:59:50"',
            '"Beacon Markers","10.000 25.000 45.000"', "", '"Time","Ground Speed"', '"s","km/h"', "",
            *(f'"{x:.3f}","{x * 10:.3f}"' for x in t)]
    ld = read_csv_log("\n".join(rows).encode())
    part = window(ld, 20.0, 40.0)
    v = part.channel("Ground Speed")
    assert v.count == 200 and v.times()[0] == 0 and abs(v.times()[-1] - 19.9) < 1e-9
    assert v.values()[0] == 200 and abs(v.values()[-1] - 399) < 1e-9
    assert part.beacons == [5.0] and part.time_offset == 20.0 and abs(part.duration - 20) < 1e-9
    assert (part.date, part.time) == ("01/01/2026", "00:00:10")  # over midnight, into the new year
    assert ld.channel("Ground Speed").count == 600 and ld.beacons == [10.0, 25.0, 45.0]


def test_the_header_clock_moves_on_as_it_was_written():
    assert shift_clock("05/05/2025", "10:00:00", 75) == ("05/05/2025", "10:01:15")
    assert shift_clock("2025-05-05", "10:00", 3600) == ("2025-05-05", "11:00")
    assert shift_clock("Monday, May 5, 2025", "10:00 AM", 7200) == ("Monday, May 5, 2025", "12:00 PM")
    assert shift_clock("", "", 60) == ("", "")
    assert shift_clock(None, None, 60) == (None, None)


# ---------- a split ----------

def test_a_driver_change_at_a_stop_makes_two_runs_with_their_own_laps(client):
    from app import db as app_db
    from app import models, page_cache, run_split, timing
    from app.analysis.laps import time_laps
    from app.routers import reports

    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()["id"]
    sid = _run(client, ev)
    with app_db.SessionLocal() as db:
        before = _laps(db, sid)
        assert [n for n, *_ in before] == list(range(1, 11)) and not before[4][3]  # lap 5 holds the stop
        f = db.get(models.RunSession, sid).files[0]
        path, duration = f.path, f.meta["duration_s"]
        cuts = run_split.driver_changes(db, ev, _guess(sid))
        assert list(cuts) == [sid] and len(cuts[sid]) == 1
        cut = cuts[sid][0]
        lap5 = before[4]
        assert lap5[1] + lap5[2] - 40 < cut < lap5[1] + lap5[2] and cut == round(cut)  # mid-stop, a whole second
        (new,) = run_split.split_event(db, ev, _guess(sid))

    with app_db.SessionLocal() as db:
        one, two = db.get(models.RunSession, sid), db.get(models.RunSession, new)
        assert _laps(db, sid) == before[:4]  # part 1: the same laps, the stop lap gone
        laps = _laps(db, new)
        assert [n for n, *_ in laps] == [1, 2, 3, 4, 5] and all(c for *_, c in laps)
        assert [(t, c) for _, _, t, c in laps] == [(t, c) for _, _, t, c in before[5:]]
        assert [round(s + cut, 3) for _, s, _, _ in laps] == [s for _, s, _, _ in before[5:]]
        (f1,), (f2,) = one.files, two.files
        assert f1.path == f2.path == path and f1.filename == f2.filename
        assert f1.meta["window"] == [0.0, cut] and f2.meta["window"][0] == cut
        assert f1.meta["split_from"] == f2.meta["split_from"] == sid
        assert f1.meta["duration_s"] == cut and abs(f1.meta["duration_s"] + f2.meta["duration_s"] - duration) < 0.2
        h, m, s = (int(x) for x in f2.meta["time"].split(":"))
        assert f1.meta["time"] == "12:00:00" and (h - 12) * 3600 + m * 60 + s == cut
        assert f1.meta["unsplit"] == {"window": None, "duration_s": duration, "date": "03/07/2026",
                                      "time": "12:00:00", "beacons": None, "parts": [new]}
        assert "unsplit" not in f2.meta
        assert (two.event_id, two.car_id, two.kind, two.driver_id) == (ev, one.car_id, one.kind, None)
        assert one.name is None and two.name == "long run (2)"  # named by the upload: the timetable may rename it
        # the laps stored are the ones a later re-timing gives from the part's window
        for s in (one, two):
            f = s.files[0]
            again = time_laps(timing.read_file(f), f.meta.get("beacons"),
                              timing.track_line(page_cache.known_track(db, s, f))).laps
            assert [(l.number, round(l.start, 3), round(l.time, 3), l.clean) for l in again] == _laps(db, s.id)
            assert abs(timing.read_file(f).duration - f.meta["duration_s"]) < 0.1
        track_id = one.event.track_id
        for f in (f1, f2):  # and a re-timing (older lap timing) times them the same again
            f.meta = {**f.meta, "timing_version": 0}
        db.commit()
    timing.check_track(track_id)
    with app_db.SessionLocal() as db:
        assert _laps(db, sid) == before[:4] and _laps(db, new) == laps

    # the report reads each part from its window
    assert reports.wait_idle()
    body = client.get(f"/reports/events/{ev}").json()
    t0 = time.monotonic()
    while body["status"] in ("queued", "running") and time.monotonic() - t0 < 120:
        time.sleep(0.2)
        body = client.get(f"/reports/events/{ev}").json()
    assert body["status"] == "ready", body
    assert {s["id"]: s["clean_laps"] for s in body["sessions"]} == {sid: 4, new: 5}
    analysis = client.get(f"/sessions/{new}/analysis").json()
    assert [lap["number"] for lap in analysis["laps"]] == [1, 2, 3, 4, 5]

    # a part has one stint: never split again, by the guess made before the split or by a new one
    with app_db.SessionLocal() as db:
        assert run_split.split_event(db, ev, _guess(sid)) == []
        again = ds.Guess("groups", 0.3, [ds.Group(None, "", 0)] * 2, [
            ds.SessionGuess(sid, 0, 1.0, 4, [ds.Stint([1, 2, 3, 4], 0, 1.0)]),
            ds.SessionGuess(new, 1, 1.0, 5, [ds.Stint([1, 2, 3, 4, 5], 1, 1.0)])], np.zeros(0, int))
        assert run_split.driver_changes(db, ev, again) == {}
        assert db.scalar(select(models.RunSession.id).where(models.RunSession.id > new)) is None


def test_no_stop_or_a_short_one_is_no_driver_change(client, monkeypatch):
    from app import db as app_db
    from app import models, run_split, timing

    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()["id"]
    plain = _run(client, ev, at="12:00:00", stop_s=0)
    short = _run(client, ev, at="13:00:00", stop_s=10)
    with app_db.SessionLocal() as db:
        assert run_split.driver_changes(db, ev, _guess(plain)) == {}
        assert run_split.split_event(db, ev, _guess(short)) == []

        def read_file(f):
            raise AssertionError("read again")

        monkeypatch.setattr(timing, "read_file", read_file)  # asked again (each pass does): not read again
        assert run_split.driver_changes(db, ev, _guess(plain)) == {}
        monkeypatch.undo()
        assert run_split.driver_changes(db, ev, _guess(short, mode="one style")) == {}
        # the same style either side of the stop: no change of driver
        same = _guess(plain)
        same.sessions[0].stints[1].group = 0
        assert run_split.driver_changes(db, ev, same) == {}
        assert len(db.scalars(select(models.RunSession.id)).all()) == 2


def test_a_long_stop_in_a_race_is_a_red_flag_not_a_driver_change(client):
    # Gabriele, 2026-10-08: "any interruption during the race that is longer than a pitstop is a red flag"
    from app import db as app_db
    from app import run_split

    ev = client.post("/events/folders", json={"name": "Race weekend"}).json()["id"]
    red = _run(client, ev, "04_R1", at="12:00:00", stop_s=400)
    pit = _run(client, ev, "05_R2", at="15:00:00", stop_s=90)
    test = _run(client, ev, "Long run", at="17:00:00", stop_s=400)
    with app_db.SessionLocal() as db:
        assert run_split.driver_changes(db, ev, _guess(red)) == {}  # the race goes on after it
        assert list(run_split.driver_changes(db, ev, _guess(pit))) == [pit]  # a pit stop of 1.5 minutes
        assert list(run_split.driver_changes(db, ev, _guess(test))) == [test]  # outside a race: a driver change


def test_too_few_laps_either_side_is_no_split(client):
    from app import db as app_db
    from app import models, run_split

    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()["id"]
    sid = _run(client, ev)
    with app_db.SessionLocal() as db:
        laps = _laps(db, sid)
        assert run_split._enough([], [100.0]) == []
        clean = [l for l in db.get(models.RunSession, sid).laps if l.clean]
        end4 = laps[3][1] + laps[3][2]
        assert run_split._enough(clean, [end4 + 10]) == [end4 + 10]
        assert run_split._enough(clean, [laps[1][1] + laps[1][2] + 1]) == []  # only two laps before it


def test_a_typed_name_stays_its_parts_get_2_and_the_driver_goes_to_their_style(client):
    from app import db as app_db
    from app import driver_prints, laptags, models, run_split
    from app.results import models as rm
    from app.setup import models as setup_models

    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()["id"]
    sid = _run(client, ev, "Long run", at="12:00:00")
    other = _run(client, ev, "Other run", at="14:00:00")
    anna = client.post("/garage/drivers", json={"name": "Anna"}).json()["id"]
    assert client.put(f"/sessions/{sid}/driver", json={"driver_id": anna}).status_code == 200
    with app_db.SessionLocal() as db:
        s = db.get(models.RunSession, sid)
        f = s.files[0]
        laps = {l.number: l for l in s.laps}
        for n, tag in ((2, "traffic"), (5, "sc"), (7, "fcy")):
            laptags.set_tag(db, f.id, sid, laps[n], tag)
        db.add(setup_models.SessionSetup(session_id=sid, template="bmw-m4-gt4", values={"arb_front": 3}))
        db.add(models.Debrief(session_id=sid, transcript="Understeer"))
        db.commit()
        # Anna's laps are the second style: she drove after the stop
        (new,) = run_split.split_event(db, ev, _guess(sid, drivers=(None, anna)))

    with app_db.SessionLocal() as db:
        one, two = db.get(models.RunSession, sid), db.get(models.RunSession, new)
        assert one.name == "Long run" and two.name == "Long run (2)"
        assert db.scalar(select(rm.RunNameMark.by_hand).where(rm.RunNameMark.session_id == new)) is True
        assert (one.driver_id, two.driver_id) == (None, anna)
        assert db.scalar(select(driver_prints.StyleTag).where(driver_prints.StyleTag.session_id == new)) is None
        tags = {(t.session_id, t.lap): t.tag for t in db.scalars(select(laptags.LapTag))}
        assert tags == {(sid, 2): "traffic", (new, 2): "fcy"}  # lap 7 is the part's second; lap 5 (the stop) gone
        assert laptags.tags_for_files(db, [two.files[0].id]) == {two.files[0].id: {2: "fcy"}}
        sheet = db.scalar(select(setup_models.SessionSetup).where(setup_models.SessionSetup.session_id == new))
        assert sheet.values == {"arb_front": 3} and sheet.copied_from_session_id == sid
        assert len(one.debriefs) == 1 and two.debriefs == []
        assert db.get(models.RunSession, other).name == "Other run"


def test_who_drives_each_part(client):
    from app import db as app_db
    from app import driver_prints, models, run_split

    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()["id"]
    anna = client.post("/garage/drivers", json={"name": "Anna"}).json()["id"]
    runs = {k: _run(client, ev, k, at=f"1{i}:00:00") for i, k in enumerate(("person", "unknown", "style"))}
    for sid in runs.values():
        assert client.put(f"/sessions/{sid}/driver", json={"driver_id": anna}).status_code == 200
    with app_db.SessionLocal() as db:
        db.add(driver_prints.StyleTag(session_id=runs["style"], event_id=ev, driver_id=anna, source="fingerprint"))
        db.commit()
        parts = {k: run_split.split_run(db, sid, run_split.driver_changes(db, ev, _guess(sid))[sid], g)
                 for k, sid, g in (("person", runs["person"], _guess(runs["person"], drivers=(anna, None))),
                                   ("unknown", runs["unknown"], None),
                                   ("style", runs["style"], _guess(runs["style"], drivers=(anna, None))))}
        db.commit()
        drivers = {k: (db.get(models.RunSession, runs[k]).driver_id, db.get(models.RunSession, p).driver_id)
                   for k, (p,) in parts.items()}
        # a person's driver stays with the style of their laps; when that can't be told, with the run; the style's
        # own choice goes, for the style to make again for each part
        assert drivers == {"person": (anna, None), "unknown": (anna, None), "style": (None, None)}
        assert db.scalar(select(driver_prints.StyleTag).where(
            driver_prints.StyleTag.session_id == runs["style"])) is None


def test_the_parts_are_named_after_the_official_sessions(client, fake_site):  # noqa: F811
    from app import db as app_db
    from app import models, run_split

    fake_site.sync(years=[2026])  # R1 at 17:25 on 19 September 2026
    client.post("/tracks", json={"name": "Test Track"})
    ev = client.post("/events/folders", json={"name": "Round 5"}).json()["id"]
    s = client.post("/sessions", json={"event_id": ev}).json()["id"]
    r = client.post(f"/sessions/{s}/files", files={"file": ("race.ld", _log(day="19/09/2026", at="17:27:00"))})
    assert r.status_code == 201, r.text
    with app_db.SessionLocal() as db:
        run = db.get(models.RunSession, s)
        run.name = "Session 1"  # as an import names it: the logger's session name
        db.commit()
        assert run_split._names(db, run, run.files[0], 2) == (["Session 1 (2)", "Session 1 (3)"], False)
        (new,) = run_split.split_event(db, ev, _guess(s))
    with app_db.SessionLocal() as db:
        names = {i: db.get(models.RunSession, i).name for i in (s, new)}
    assert names == {s: "R1 stint 1", new: "R1 stint 2"}


# ---------- a log two runs share ----------

def _split(client, name: str) -> tuple[int, int, int, str]:
    """An event with one run split in two: (event, part 1, part 2, the stored log's key)."""
    from app import db as app_db
    from app import models, run_split

    ev = client.post("/events/folders", json={"name": name}).json()["id"]
    sid = _run(client, ev, "Long run")
    with app_db.SessionLocal() as db:
        (new,) = run_split.split_run(db, sid, run_split.driver_changes(db, ev, _guess(sid))[sid])
        db.commit()
        return ev, sid, new, db.get(models.RunSession, sid).files[0].path


def _stored(key: str) -> bool:
    from app import storage
    try:
        storage.local_path(key)
        return True
    except FileNotFoundError:
        return False


def test_deleting_one_part_keeps_the_log_the_other_reads(client):
    _, one, two, key = _split(client, "Runs")
    size = client.get("/runs/size", params={"ids": str(two)}).json()
    assert size["logs"] == 1 and size["files"] == 0  # its log row goes, the stored log stays
    assert client.delete("/runs", params={"ids": str(two)}).status_code == 200
    assert _stored(key) and client.get(f"/sessions/{one}/analysis").status_code == 200
    assert client.delete("/runs", params={"ids": str(one)}).status_code == 200
    assert not _stored(key)

    _, one, two, key = _split(client, "Both")
    assert client.delete("/runs", params={"ids": f"{one},{two}"}).status_code == 200
    assert not _stored(key)


def test_deleting_an_event_keeps_a_log_a_run_elsewhere_reads(client):
    ev, one, two, key = _split(client, "Weekend")
    assert client.post("/events/none/sessions", json={"session_ids": [two]}).status_code == 200
    assert client.delete(f"/events/{ev}", params={"runs": "delete"}).status_code == 200
    assert _stored(key) and client.get(f"/sessions/{two}/analysis").status_code == 200
    assert client.get(f"/sessions/{one}").status_code == 404
    assert client.delete("/loose-runs").status_code == 200
    assert not _stored(key)

    ev, _, _, key = _split(client, "Whole weekend")
    assert client.delete(f"/events/{ev}", params={"runs": "delete"}).status_code == 200
    assert not _stored(key)


def test_an_empty_run_removed_keeps_a_log_another_run_reads(client):
    from app import db as app_db
    from app import empty_runs, models

    _, one, two, key = _split(client, "Weekend")
    with app_db.SessionLocal() as db:
        assert empty_runs.remove_session(db, db.get(models.RunSession, two)) == []
        db.commit()
        assert empty_runs.remove_session(db, db.get(models.RunSession, one)) == [key]
        db.commit()


# ---------- the style tells the drivers apart ----------

SMOOTH = (1.0, 0.99, 0.995, 0.985, 0.99)
SHARP = (0.94, 0.935, 0.94, 0.93, 0.935)  # the later, harder stops of _sharp_speed, at about the same lap time


def _two_drivers(stop_s: float = 40.0) -> bytes:
    """One log: a driver's laps, a stop at the line, then another driver's."""
    a, _ = simulate(paces=SMOOTH, stops={len(SMOOTH) + 1: stop_s})  # stands at the line after the in-lap
    default = synthetic.speed_at
    synthetic.speed_at = _sharp_speed
    try:
        b, _ = simulate(paces=SHARP)
    finally:
        synthetic.speed_at = default
    whole = len(a["vCar"][2]) // 100  # whole seconds of the first: every channel joins on time
    return write_ld({k: (hz, unit, np.concatenate([v[:whole * hz], b[k][2]])) for k, (hz, unit, v) in a.items()})


def test_the_style_finds_the_change_and_the_parts_are_one_style_each(client):
    from app import db as app_db
    from app import driver_prints, models, run_split
    from app.routers import reports
    from tests.test_driver_style import _log as style_log

    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()["id"]
    both = client.post("/sessions", json={"event_id": ev, "name": "A then B"}).json()["id"]
    assert client.post(f"/sessions/{both}/files", files={"file": ("ab.ld", _two_drivers())}).status_code == 201
    for i, (paces, sharp) in enumerate(((SMOOTH[:4], False), (SHARP[:4], True))):
        s = client.post("/sessions", json={"event_id": ev, "name": f"Run {i}"}).json()["id"]
        log = style_log(paces, f"1{i + 3}:00:00", sharp)
        assert client.post(f"/sessions/{s}/files", files={"file": ("run.ld", log)}).status_code == 201

    def settled() -> ds.Guess:
        """The event's guess once nothing is left to do: the report and the background passes (which split runs and
        start the report again) are done."""
        t0 = time.monotonic()
        while True:
            assert time.monotonic() - t0 < 180
            client.get(f"/events/{ev}/driver-guess")  # starts the report for lap traces still missing
            assert reports.wait_idle()
            driver_prints.wait_idle()
            with app_db.SessionLocal() as db:
                ep, pending = driver_prints.refresh(db, ev)
                if not pending and not reports._pending and not driver_prints.busy():
                    return driver_prints.guess_for(db, ev, ep, driver_prints.learned(db))
            time.sleep(0.2)

    # the background pass finds the change and splits the run by itself
    g = settled()
    with app_db.SessionLocal() as db:
        (new,) = [r.id for r in db.scalars(select(models.RunSession).where(models.RunSession.event_id == ev))
                  if any((f.meta or {}).get("split_from") == both for f in r.files) and r.id != both]
        assert [l.number for l in db.get(models.RunSession, new).laps] == [1, 2, 3, 4, 5]
    stints = {x.session_id: x.stints for x in g.sessions}
    assert len(stints[both]) == len(stints[new]) == 1 and stints[both][0].group != stints[new][0].group
    with app_db.SessionLocal() as db:
        assert run_split.split_event(db, ev, g) == []  # one style in each part: never split again
