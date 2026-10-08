"""A report per official session of a weekend (FP1, Q1, R1...): every run of that session, both drivers' stints, called
as on the event page (app/run_parts.py, routers/reports.py)."""
import time

from sqlalchemy import select

from app import models
from app.event_delete import scope_named
from app.run_labels import label_runs
from app.run_parts import code_of, parts
from tests.synthetic import simulate, write_ld

SECTORED = [("T1", 100, None), ("T2", 280, "T2-T5"), ("T3", 300, "T2-T5"), ("T4", 320, "T2-T5"),
            ("T5", 520, "T2-T5"), ("T6", 690, None), ("T7", 740, None)]


def _run(id_, name, date="19/09/2026", at="10:00:00", driver=None, folder=None):
    meta = {"date": date, "time": at, "duration_s": 1200}
    if folder:
        meta["folder"] = folder
    s = models.RunSession(id=id_, name=name)
    s.files = [models.LoggerFile(filename="x.ld", path="x", logger="motec", meta=meta)]
    s.driver = models.Driver(name=driver) if driver else None
    return s


def test_a_run_s_session_is_the_timetable_code_its_name_starts_with():
    assert [code_of(n) for n in ("FP1 stint 1", "FP1 stint 2 (2)", "PT2 stint 1", "Q1", "Q2 stint 2", "R1 stint 2",
                                 "Race 1 stint 2", "Pre-qualifying stint 1", "Q1 Piana")] == \
        [("FP1", True), ("FP1", True), ("PT2", True), ("Q1", True), ("Q2", True), ("R1", True), ("R1", True),
         ("PQ", True), ("Q1", True)]
    # not a timetable name: the name without the importer's numbering
    assert [code_of(n) for n in ("03_Q", "03_Q (2)", "PTS 1 (2)", "01_D1S1", "R2D2 test", "Q")] == \
        [("03_Q", False), ("03_Q", False), ("PTS 1", False), ("01_D1S1", False), ("R2D2 test", False),
         ("Q", False)]


def test_an_event_s_runs_by_session_in_the_order_they_ran():
    """ADAC runs Q1, R1 on Saturday and Q2, R2 on Sunday: the sessions come in that order, not by kind."""
    runs = [
        _run(1, "R1 stint 2", date="20/09/2026", at="15:40:00", driver="Max Rackl"),
        _run(2, "Q1", date="20/09/2026", at="09:00:00", driver="Gabriele Piana"),
        _run(3, "R1 stint 1", date="20/09/2026", at="15:00:00", driver="Gabriele Piana"),
        _run(4, "FP1 stint 1", date="19/09/2026", at="10:00:00", driver="Gabriele Piana"),
        _run(5, "FP1 stint 2", date="19/09/2026", at="10:40:00", driver="Max Rackl"),
        _run(6, "Q2", date="21/09/2026", at="09:00:00", driver="Max Rackl"),
        _run(7, "03_Q", date="21/09/2026", at="12:00:00"),
        _run(8, "03_Q (2)", date="21/09/2026", at="12:30:00"),
    ]
    labels = label_runs(runs)
    found = parts(runs, labels)
    assert [(p.code, p.ids) for p in found] == [("FP1", [4, 5]), ("Q1", [2]), ("R1", [3, 1]), ("Q2", [6]),
                                                ("03_Q", [7, 8])]
    assert [p.official for p in found] == [True, True, True, True, False]
    # the runs keep the names the event page gives them
    assert [lab.name for lab in found[0].runs] == ["FP1 stint 1", "FP1 stint 2"]
    assert parts(runs, labels)[0].title == "FP1" and parts([_run(9, "Pre-qualifying stint 1")],
                                                             label_runs([_run(9, "Pre-qualifying stint 1")]))[0].title \
        == "Pre-qualifying"


def test_a_folder_name_met_on_two_days_is_a_session_per_day():
    runs = [_run(1, "1", date="10/04/2026", folder="Data/01_PTS/1"),
            _run(2, "1 (2)", date="11/04/2026", folder="Data/01_PTS/1"),
            _run(3, "FP1 stint 1", date="11/04/2026", at="14:00:00")]
    found = parts(runs, label_runs(runs))
    assert [(p.code, p.ids) for p in found] == [("Day 1 · PTS 1", [1]), ("Day 2 · PTS 1", [2]), ("FP1", [3])]


def test_part_scopes_fit_the_column_and_name_their_event():
    from app.routers import reports

    assert reports.part_scope(3, "FP1") == "part:3:FP1"
    long = reports.part_scope(3, "A name typed by hand that is much too long")
    assert len(long) <= reports.SCOPE_LEN and long.startswith("part:3:#")
    assert scope_named("part:3:FP1", {"events": {3}}) and not scope_named("part:3:FP1", {"events": {4}})
    assert scope_named("event:3", {"events": {3}}) and not scope_named("part:x", {"events": {3}})


# ---------- the API ----------

def _wait(client, url, timeout=180):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r = client.get(url)
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] not in ("queued", "running"):
            return body
        time.sleep(0.2)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_a_session_report_covers_that_session_s_runs_only(client):
    import app.db
    from app.routers import reports

    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": m, "sector": sector} for code, m, sector in SECTORED]}).json()
    event = client.post("/events", json={"name": "Zandvoort", "track_id": track["id"]}).json()
    eid = event["id"]
    piana = client.post("/drivers", json={"name": "Gabriele Piana"}).json()
    rackl = client.post("/drivers", json={"name": "Max Rackl"}).json()
    runs = [("FP1 stint 2", rackl["id"], "10:40:00", (0.97, 0.99, 0.98)),
            ("Q1", piana["id"], "14:00:00", (0.99, 1.0)),  # quicker than practice: practice on the same tyres
            ("FP1 stint 1", piana["id"], "10:00:00", (0.96, 0.975, 0.97))]
    ids = {}
    for name, driver, at, paces in runs:
        s = client.post("/sessions", json={"event_id": eid, "name": name, "driver_id": driver}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
        ids[name] = s["id"]
        with app.db.SessionLocal() as db:
            f = db.get(models.RunSession, s["id"]).files[0]
            f.meta = {**f.meta, "date": "19/09/2026", "time": at}
            db.commit()

    listed = client.get(f"/reports/events/{eid}/parts").json()
    assert (listed["start"], listed["end"]) == ("2026-09-19", "2026-09-19")
    fp1, q1 = listed["parts"]
    assert (fp1["code"], fp1["title"], fp1["official"]) == ("FP1", "FP1", True)
    assert [r["name"] for r in fp1["runs"]] == ["FP1 stint 1", "FP1 stint 2"]
    assert fp1["drivers"] == ["Gabriele Piana", "Max Rackl"] and fp1["driver_codes"] == ["PIA", "RAC"]
    assert fp1["best"] == min(r["best"] for r in fp1["runs"]) and fp1["clean_laps"] == 6
    assert fp1["status"] == "not started" and not fp1["ready"]
    assert q1["code"] == "Q1" and [r["id"] for r in q1["runs"]] == [ids["Q1"]]

    body = _wait(client, f"/reports/events/{eid}/sessions/FP1")
    assert body["status"] == "ready", body.get("error")
    assert (body["scope"], body["id"], body["title"], body["part"]) == ("part", eid, "FP1", "FP1")
    assert [s["id"] for s in body["sessions"]] == [ids["FP1 stint 1"], ids["FP1 stint 2"]]
    assert body["report"]["runs_analysed"] == 2
    assert {r["run"] for r in body["report"]["trends"]["runs"]} == {"FP1 stint 1", "FP1 stint 2"}
    # the event's runs, labelled among all of them (as on the event page)
    assert [r["name"] for r in body["runs"]] == ["FP1 stint 1", "FP1 stint 2", "Q1"]
    assert client.get(f"/reports/events/{eid}/parts").json()["parts"][0]["ready"]

    # a session of one run: that run's own report, worked out once for both
    one = _wait(client, f"/reports/events/{eid}/sessions/Q1")
    assert one["status"] == "ready" and one["title"] == "Q1" and one["report"]["runs_analysed"] == 1
    own = client.get(f"/reports/sessions/{ids['Q1']}").json()
    assert own["status"] == "ready" and own["report"] == one["report"]
    with app.db.SessionLocal() as db:
        scopes = set(db.scalars(select(models.ReportCache.scope)))
    assert f"part:{eid}:FP1" in scopes and f"session:{ids['Q1']}" in scopes and f"part:{eid}:Q1" not in scopes

    r = client.post(f"/reports/events/{eid}/sessions/FP1/refresh")
    assert r.status_code == 200 and r.json()["status"] in ("queued", "running", "ready")
    assert _wait(client, f"/reports/events/{eid}/sessions/FP1")["status"] == "ready"
    assert client.get(f"/reports/events/{eid}/sessions/R1").status_code == 404
    assert client.get("/reports/events/9999/parts").status_code == 404

    # after an import the sessions that got runs are queued after their event's report
    asked = []
    real = reports.report_for
    try:
        reports.report_for = lambda db, *ask: asked.append(ask)
        with app.db.SessionLocal() as db:
            reports.schedule_sessions(db, [ids["FP1 stint 2"]])
    finally:
        reports.report_for = real
    assert asked == [("event", eid), ("part", eid, "FP1")]

    # and in the prebuild, right after the event's report
    from app import prebuild
    with app.db.SessionLocal() as db:
        pieces = prebuild.pieces(db, [ids["FP1 stint 2"]], prep=False)
    at = pieces.index(("report", ("event", eid)))
    assert pieces[at + 1] == ("report", ("part", eid, "FP1"))
    assert reports.prebuild("part", eid, "FP1") == "up to date"
