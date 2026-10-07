"""The time left of an upload: the rates kept from past imports, and the estimate of an import as it runs."""
import pytest

from tests.test_imports import make_zip, upload
from tests.test_upload_dupes import log

MB = 1e6


@pytest.fixture()
def rates_module():
    from app import import_rates

    return import_rates


def rows(points):
    """(bytes, out_bytes, seconds) rows of logs from (MB, seconds)."""
    return [(int(mb * MB), 0, s) for mb, s in points]


def test_a_log_takes_a_time_per_log_and_per_mb_fitted_on_the_latest(rates_module):
    m = rates_module
    logs = rows([(mb, 1.5 + 0.2 * mb) for mb in (3, 10, 25, 40, 60, 90, 5, 70)])
    r = m.fit([], [], [], logs, [])
    assert r.log_s == pytest.approx(1.5) and r.log_s_per_mb == pytest.approx(0.2)
    assert r.measured == 8 and r.mean_log_mb == pytest.approx(37.875)
    assert r.log_seconds(int(50 * MB)) == pytest.approx(11.5)


def test_few_logs_or_logs_of_one_size_are_taken_per_mb(rates_module):
    m = rates_module
    r = m.fit([], [], [], rows([(80, 10.0), (78, 10.0)]), [])
    assert r.log_s == pytest.approx(m.FALLBACK.log_s)  # at most half of what a log took
    assert r.log_seconds(int(80 * MB)) == pytest.approx(10.0, rel=0.05)
    # a line that would start below zero goes through zero
    r = m.fit([], [], [], rows([(10, 0.1), (20, 2), (30, 4), (40, 6), (50, 8), (60, 10)]), [])
    assert r.log_s == 0 and r.log_s_per_mb == pytest.approx(30.1 / 210)


def test_the_other_rates_and_the_guesses_without_history(rates_module):
    m = rates_module
    assert m.fit([], [], [], [], []) == m.FALLBACK
    r = m.fit(receive=[(int(100 * MB), 0, 2.0), (int(300 * MB), 0, 2.0)],
              unpack=[(int(90 * MB), int(810 * MB), 0.5), (0, 0, 1.5)],  # a zip of 90 MB held 810 MB of logs
              check=[(int(800 * MB), 0, 8.0)], logs=[], finish=[(0, 0, 1.0), (0, 0, 3.0)])
    assert r.receive_s_per_mb == pytest.approx(0.01)
    assert r.unpack_s == pytest.approx(1.0)
    assert r.zip_expansion == pytest.approx(9.0)
    assert r.check_s_per_mb == pytest.approx(0.01)
    assert r.finish_s == pytest.approx(2.0)


def test_before_any_log_is_timed_the_imports_done_before_give_the_time_per_log(rates_module):
    m = rates_module
    # the server's past imports took 300 s for 15 logs and 100 s for 5: 20 s a log of the usual size
    r = m.fit([], [], [], [], [], jobs=[(300.0, 15), (100.0, 5)])
    assert r.log_seconds(int(m.FALLBACK.mean_log_mb * MB)) == pytest.approx(20.0)
    assert r.log_s / r.log_s_per_mb == pytest.approx(m.FALLBACK.log_s / m.FALLBACK.log_s_per_mb)
    # once logs have been timed, those count
    assert m.fit([], [], [], rows([(10, 1.0)]), [], jobs=[(300.0, 15)]).log_seconds(int(10 * MB)) == pytest.approx(1)


def test_before_the_logs_are_known_an_upload_is_judged_by_its_size(rates_module):
    m = rates_module
    r = m.Rates(receive_s_per_mb=0.01, unpack_s=0.5, zip_expansion=10, check_s_per_mb=0.02, log_s=1,
                log_s_per_mb=0.1, mean_log_mb=20, finish_s=1)
    # a 90 MB zip holds about 900 MB of logs, 45 logs of 20 MB
    assert m.before(r, int(90 * MB), int(90 * MB)) == pytest.approx(0.5 + 18 + 45 + 90 + 1)
    # the same size of loose logs is ten times less to read
    assert m.before(r, int(90 * MB), 0) == pytest.approx(0.5 + 1.8 + 4.5 + 9 + 1)


def test_the_time_left_of_an_import_as_it_runs(rates_module, monkeypatch):
    m = rates_module
    r = m.Rates(receive_s_per_mb=0.01, unpack_s=2, zip_expansion=10, check_s_per_mb=0.01, log_s=1, log_s_per_mb=0.1,
                mean_log_mb=20, finish_s=3)
    monkeypatch.setattr(m, "rates", lambda: r)
    monkeypatch.setattr(m, "_running", {})
    m.queued(7, int(9 * MB), int(9 * MB))  # a 9 MB zip: about 90 MB of logs
    p = m.progress(7)
    t = p.stage_at
    whole = m.before(r, int(9 * MB), int(9 * MB))
    assert m.eta(7, t) == {"stage": "waiting", "stage_s": 0, "total_s": round(whole, 1)}
    # another import queued behind it waits for this one first
    m.queued(8, int(1 * MB), 0)
    assert m.eta(8, t)["stage_s"] == round(whole, 1)

    p.stage, p.stage_at = "unpacking", t
    assert m.eta(7, t + 1.5) == {"stage": "unpacking", "stage_s": 0.5, "total_s": round(whole - 1.5, 1)}

    # the logs are found: 30, 50 and 10 MB, checked first
    p.sizes, p.stage, p.stage_at = [int(30 * MB), int(50 * MB), int(10 * MB)], "checking", t + 2
    assert m.eta(7, t + 2.4) == {"stage": "checking", "stage_s": 0.5, "total_s": round(0.5 + 4 + 6 + 2 + 3, 1)}
    # the first took 1 s instead of 0.3: the server is busier than the rates say, so the rest take a little longer
    m.checking(7, 1)
    p.log_at, p.check_took = t + 3, 1.0
    pace = (1 + m.PRIOR_S) / (0.3 + m.PRIOR_S)
    assert m.eta(7, t + 3.2) == {"stage": "checking", "stage_s": round(0.6 * pace - 0.2, 1),
                                 "total_s": round(0.6 * pace - 0.2 + 12 * pace + 3, 1)}
    m.checked(p, 0.9)  # all of them in the time the rates say

    # the 50 MB one was uploaded before: left out
    p.sizes[1] = None
    p.to("logs")
    p.stage_at = t + 3
    assert m.eta(7, t + 3) == {"stage": "logs", "stage_s": 4 + 2 + 3, "total_s": 4 + 2 + 3}
    m.log_started(p, 0)
    p.log_at = t + 3
    assert m.eta(7, t + 5)["stage_s"] == pytest.approx(2 + 2 + 3)
    assert m.eta(7, t + 9)["stage_s"] == pytest.approx(0 + 2 + 3)  # taking longer than it should: none left of it
    # it took 8 s instead of 4: the rest are judged a little slower (this import's pace, against PRIOR_S of history)
    monkeypatch.setattr(m, "record", lambda *a, **k: None)
    m.log_read(p, int(30 * MB), 8.0)
    pace = (8 + 0.9 + m.PRIOR_S) / (4 + 0.9 + m.PRIOR_S)
    m.log_started(p, 2)
    p.log_at = t + 11
    assert m.eta(7, t + 11)["stage_s"] == pytest.approx(round(2 * pace + 3, 1), abs=0.06)
    p.stage, p.stage_at = "finishing", t + 13
    assert m.eta(7, t + 14) == {"stage": "logs", "stage_s": 2.0, "total_s": 2.0}
    m.ended(7)
    assert m.eta(7) is None


def test_an_import_keeps_its_times_and_shows_its_time_left(client, monkeypatch):
    from app import import_rates
    from app.db import SessionLocal

    assert client.get("/imports/rates").json()["measured"] == 0
    monkeypatch.setenv("UPLOAD_DUPES", "on")
    a, b = log(), log((0.95, 1.0, 0.98))
    z = make_zip({"Test/01/a.ld": a, "Test/02/b.ld": b})
    r = client.post("/imports", files=[("files", ("Test.zip", z))])
    assert r.status_code == 202
    assert r.json()["eta"]["stage"] == "waiting" and r.json()["eta"]["total_s"] > 0
    job = upload(client, ("Test again.zip", z))  # the same logs again: checked, and left out
    assert job["eta"] is None and job["already_uploaded"] == 2

    with SessionLocal() as db:
        kept = {}
        for x in db.query(import_rates.ImportRate).order_by(import_rates.ImportRate.id):
            kept.setdefault(x.stage, []).append(x)
    assert len(kept["receive"]) == 2 and kept["receive"][0].bytes == len(z)
    assert [u.items for u in kept["unpack"]] == [2, 2] and kept["unpack"][0].out_bytes == len(a) + len(b)
    assert len(kept["check"]) == 2 and kept["check"][0].bytes == len(a) + len(b)
    assert sorted(x.bytes for x in kept["log"]) == sorted([len(a), len(b)])  # the new logs only, read once
    assert len(kept["finish"]) == 2
    rates = client.get("/imports/rates").json()
    assert rates["measured"] == 2 and rates["zip_expansion"] == pytest.approx((len(a) + len(b)) / len(z))


def test_only_the_latest_measurements_are_kept(client):
    from app import import_rates
    from app.db import SessionLocal

    for i in range(import_rates.KEEP + 5):
        import_rates.record("log", 1.0 + i, bytes=1000, items=1)
    import_rates.record("finish", 1.0)
    with SessionLocal() as db:
        logs = db.query(import_rates.ImportRate).filter_by(stage="log").all()
        assert len(logs) == import_rates.KEEP and min(x.seconds for x in logs) == 6.0
        assert db.query(import_rates.ImportRate).filter_by(stage="finish").count() == 1
