"""Runs called by their own names in the report (app/run_labels.py), never by a number, in the event page's order."""
import time

from app import models
from app.run_labels import base_name, driver_code, label_runs, renamed, short_name
from tests.synthetic import simulate, write_ld


def _run(id_, name, date="10/04/2026", at="10:00:00", driver=None, folder=None, session=None):
    meta = {"date": date, "time": at, "duration_s": 1200}
    if folder:
        meta["folder"] = folder
    if session:
        meta["event_session"] = session
    s = models.RunSession(id=id_, name=name)
    s.files = [models.LoggerFile(filename="x.ld", path="x", logger="motec", meta=meta)]
    s.driver = models.Driver(name=driver) if driver else None
    return s


def test_short_forms_and_driver_codes():
    assert [short_name(n) for n in ("FP1 stint 1", "PT2 stint 1", "Q1", "R1 stint 2", "Race 1 stint 2", "Race 2",
                                    "Pre-qualifying", "01_D1S1")] == \
        ["FP1 S1", "PT2 S1", "Q1", "R1 S2", "R1 S2", "R2", "PQ", "01_D1S1"]
    assert (driver_code("Gabriele Piana"), driver_code("Rackl"), driver_code("PIA")) == ("PIA", "RAC", "PIA")


def test_a_run_named_only_by_a_number_takes_its_folder():
    """Paul Ricard's paid tests came in folders 01_PTS/1 and 01_PTS/2, so the import named their runs "1", "1 (2)"."""
    assert base_name(_run(1, "1", folder="Data/01_PTS/1")) == "PTS 1"
    assert base_name(_run(2, "1 (2)", folder="Data/01_PTS/1")) == "PTS 1 (2)"
    assert base_name(_run(3, "02", folder="01_Data/01_PTS/02", session="PT_24002")) == "PTS 02"
    assert base_name(_run(4, "3", session="PTS")) == "PTS 3"  # no folder above: the logger's session name
    assert base_name(_run(5, "4")) == "Run 4"
    assert base_name(_run(6, "FP1 stint 1", folder="Data/02_FP1")) == "FP1 stint 1"
    assert base_name(models.RunSession(id=7, name=None)) == "Session 7"


def test_runs_in_time_order_and_told_apart_only_when_alike():
    runs = [
        _run(1, "Q1", date="30/05/2026", at="11:05:00", driver="Gabriele Piana"),
        _run(2, "Q1", date="30/05/2026", at="11:40:00", driver="Max Rackl"),
        _run(3, "FP2 stint 1", date="29/05/2026", at="15:00:00"),
        _run(4, "FP2 stint 1", date="30/05/2026", at="09:00:00"),
        _run(5, "FP1 stint 2", date="29/05/2026", at="10:40:00"),
        _run(6, "FP1 stint 10", date="29/05/2026", at="10:40:00"),
        _run(7, "Race 1", date="30/05/2026", at="17:00:00"),
        _run(8, "Race 1", date="30/05/2026", at="17:55:00"),
        _run(9, "No log yet"),
    ]
    runs[8].files = []
    labels = label_runs(runs)
    # the event page's order: by day, then the time of day ("stint 2" before "stint 10" at the same time), no log last
    assert [lab.id for lab in labels] == [5, 6, 3, 4, 1, 2, 7, 8, 9]
    names = {lab.id: (lab.name, lab.short) for lab in labels}
    assert names[5] == ("FP1 stint 2", "FP1 S2")
    assert names[3] == ("Day 1 · FP2 stint 1", "D1 FP2 S1") and names[4] == ("Day 2 · FP2 stint 1", "D2 FP2 S1")
    assert names[1] == ("Q1 · Gabriele Piana", "Q1 PIA") and names[2] == ("Q1 · Max Rackl", "Q1 RAC")
    assert names[7] == ("Race 1 · 17:00", "R1 17:00") and names[8] == ("Race 1 · 17:55", "R1 17:55")
    assert names[9] == ("No log yet", "No log yet")
    assert len({lab.name for lab in labels}) == len(labels)
    assert {lab.id: lab.day for lab in labels}[4] == 2
    assert all(not lab.name.strip().isdigit() for lab in labels)
    # only the runs whose label isn't their stored name change what a kept page was made from
    assert renamed(labels) == [[(1, "Q1 · Gabriele Piana"), (2, "Q1 · Max Rackl"), (3, "Day 1 · FP2 stint 1"),
                                (4, "Day 2 · FP2 stint 1"), (7, "Race 1 · 17:00"), (8, "Race 1 · 17:55")]]
    assert renamed(label_runs([_run(1, "01_D1S1"), _run(2, "02_D1S2")])) == []


def test_runs_alike_in_everything_are_numbered_as_the_importer_numbers_them():
    labels = label_runs([_run(1, "FP1"), _run(2, "FP1")])
    assert [lab.name for lab in labels] == ["FP1", "FP1 (2)"]
    # never the name of another run
    labels = label_runs([_run(1, "FP1"), _run(2, "FP1"), _run(3, "FP1 (2)", at="11:00:00")])
    assert [lab.name for lab in labels] == ["FP1", "FP1 (3)", "FP1 (2)"]


# ---------- the report ----------

def _wait(client, url, timeout=120):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        body = client.get(url).json()
        if body["status"] not in ("queued", "running"):
            return body
        time.sleep(0.2)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_the_report_calls_runs_by_their_names_in_time_order(client):
    """Logs a zip held in folders 01_PTS/1 and 01_PTS/2 were named "1" and "2"; two drivers' Q1 runs share a name.
    The report calls each by its name (with the folder, the driver), never "1", and lists them by time of day."""
    import app.db

    event = client.post("/events", json={"name": "Paul Ricard"}).json()
    piana = client.post("/drivers", json={"name": "Gabriele Piana"}).json()
    rackl = client.post("/drivers", json={"name": "Max Rackl"}).json()
    # stored in this order; driven: "2" at 09:00, "1" at 10:00, Q1 (Rackl) at 14:00, Q1 (Piana) at 14:30
    runs = [("1", None, "10:00:00", "Data/01_PTS/1", (0.95, 0.97, 0.96)),
            ("Q1", piana["id"], "14:30:00", "Data/04_Q", (0.98, 1.0, 0.985)),
            ("2", None, "09:00:00", "Data/01_PTS/2", (0.96, 0.975, 0.97)),
            ("Q1", rackl["id"], "14:00:00", "Data/04_Q", (0.97, 0.99, 0.98))]
    ids = []
    for name, driver, at, folder, paces in runs:
        s = client.post("/sessions", json={"event_id": event["id"], "name": name, "driver_id": driver}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
        ids.append(s["id"])
        with app.db.SessionLocal() as db:
            f = db.get(models.RunSession, s["id"]).files[0]
            f.meta = {**f.meta, "time": at, "folder": folder}
            db.commit()

    body = _wait(client, f"/reports/events/{event['id']}")
    assert body["status"] == "ready", body.get("error")
    want = ["PTS 2", "PTS 1", "Q1 · Max Rackl", "Q1 · Gabriele Piana"]
    assert [r["name"] for r in body["runs"]] == want
    assert [r["short"] for r in body["runs"]] == ["PTS 2", "PTS 1", "Q1 RAC", "Q1 PIA"]
    assert [r["id"] for r in body["runs"]] == [ids[2], ids[0], ids[3], ids[1]]
    assert [s["name"] for s in body["sessions"]] == want
    # one report per tyre level: the qualifying runs (a new set each) have their own, apart from the test runs
    reps = [body["report"], *body["report"]["condition"]["others"]]
    quali = next(r for r in reps if r["condition"]["tyres"] == "new" and r["condition"]["runs"] == sorted(ids[1::2]))
    assert len(reps) >= 2 and quali["headline"]["fastest"]["session_id"] in (ids[1], ids[3])
    for r in reps:
        sids = [i for i in (ids[2], ids[0], ids[3], ids[1]) if i in r["condition"]["runs"]]
        names = [want[[ids[2], ids[0], ids[3], ids[1]].index(i)] for i in sids]
        trends = r["trends"]["runs"]
        assert [x["run"] for x in trends] == names  # the sessions table, by time of day
        assert [x["session_id"] for x in trends] == sids
        assert {x["run"] for x in r["trends"]["laps"]} == set(names)
        assert r["headline"]["fastest"]["run"] in names and r["headline"]["fastest"]["session_id"] in sids
        assert all(s["times"]["best_lap"].rsplit("#", 1)[0] in names for s in r["sections"])
        assert f"{r['headline']['fastest']['run']} lap" in r["summary"]
        assert r["summary"].startswith(r["condition"]["label"])
        assert not any(x["run"].strip().isdigit() for x in trends)
        assert all(x["tyres"]["tyres"] == r["condition"]["tyres"] for x in trends)

    # one run's report calls it as the event's does
    one = _wait(client, f"/reports/sessions/{ids[0]}")
    assert one["title"] == "PTS 1" and one["report"]["trends"]["runs"][0]["run"] == "PTS 1"
    assert [r["name"] for r in one["runs"]] == want  # the event's runs, for the switch between them

    # renamed from the official timetable: the report is worked out again under the new name
    client.patch(f"/sessions/{ids[0]}", json={"name": "PT1 stint 1"})
    again = _wait(client, f"/reports/events/{event['id']}")
    assert "PT1 stint 1" in {x["run"] for r in (again["report"], *again["report"]["condition"]["others"])
                             for x in r["trends"]["runs"]}
    assert again["runs"][1]["short"] == "PT1 S1"
