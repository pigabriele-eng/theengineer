"""Debriefs recorded before their run is in: they join the run that ended just before them (debrief/inbox.py)."""
from datetime import datetime

from app.debrief.inbox import run_end


def _run(client, name: str, date: str, time: str, duration_s: float, track_id: int | None = None) -> int:
    """A run with a log that started at date time and lasted duration_s (only its header is stored)."""
    from app import models
    from app.db import SessionLocal

    event = client.post("/events", json={"name": f"Weekend {name}", **({"track_id": track_id} if track_id else {})})
    s = client.post("/sessions", json={"name": name, "event_id": event.json()["id"]}).json()
    with SessionLocal() as db:
        db.add(models.LoggerFile(session_id=s["id"], logger="motec", filename=f"{name}.ld", path=f"{name}.ld",
                                 meta={"date": date, "time": time, "duration_s": duration_s}))
        db.commit()
    return s["id"]


def _no_keys(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def test_run_end_from_the_log_header():
    assert run_end({"date": "09/10/2026", "time": "14:00:00", "duration_s": 1800}) == datetime(2026, 10, 9, 14, 30)
    assert run_end({"date": "2026-10-09", "time": "2:00 PM"}) == datetime(2026, 10, 9, 14, 0)
    assert run_end({"time": "14:00:00"}) is None


def test_recording_joins_the_run_that_ended_just_before(client, settle, monkeypatch):
    _no_keys(monkeypatch)
    _run(client, "FP1", "09/10/2026", "10:00:00", 1800)  # ended 10:30
    fp2 = _run(client, "FP2", "09/10/2026", "14:00:00", 1800)  # ended 14:30
    r = client.post("/debriefs/audio", files={"audio": ("debrief.m4a", b"fake audio")},
                    data={"mode": "individual", "language": "en", "recorded_at": "2026-10-09T14:36:10"})
    assert r.status_code == 202, r.text
    d = r.json()["debrief"]
    assert d["session_id"] == fp2
    assert d["linked"]["by"] == "time" and not d["linked"]["confirmed"] and d["linked"]["minutes_after_run"] == 6
    settle()
    assert client.get("/debriefs/waiting").json() == []


def test_recording_waits_for_its_log_then_joins_after_the_upload(client, settle, monkeypatch):
    from app.db import SessionLocal
    from app.debrief import inbox

    _no_keys(monkeypatch)
    _run(client, "FP1", "09/10/2026", "10:00:00", 1800)  # 4 hours before: not this debrief's run
    r = client.post("/debriefs/audio", files={"audio": ("voice note.m4a", b"fake audio")},
                    data={"recorded_at": "2026-10-09T14:36:10"})
    assert r.status_code == 202, r.text
    waiting = r.json()["waiting"]
    assert waiting["recorded_at"] == "2026-10-09T14:36:10"
    assert [w["id"] for w in client.get("/debriefs/waiting").json()] == [waiting["id"]]

    fp2 = _run(client, "FP2", "09/10/2026", "14:00:00", 1800)
    with SessionLocal() as db:  # what an upload does once its runs are in (routers/imports.py)
        inbox.after_upload(db)
    settle()
    assert client.get("/debriefs/waiting").json() == []
    (d,) = client.get(f"/sessions/{fp2}/debriefs").json()
    assert d["linked"]["by"] == "time" and d["has_audio"]

    # a later upload with a run that ended closer before it takes it while it is not confirmed
    stint2 = _run(client, "FP2 stint 2", "09/10/2026", "14:31:00", 300)
    with SessionLocal() as db:
        inbox.after_upload(db)
    settle()
    assert client.get(f"/debriefs/{d['id']}").json()["session_id"] == stint2

    # confirmed: it stays, whatever comes later
    r = client.post(f"/debriefs/{d['id']}/run", json={"session_id": stint2})
    assert r.status_code == 200 and r.json()["linked"]["confirmed"]
    _run(client, "FP2 stint 3", "09/10/2026", "14:34:00", 60)
    with SessionLocal() as db:
        inbox.after_upload(db)
    settle()
    assert client.get(f"/debriefs/{d['id']}").json()["session_id"] == stint2


def test_user_picks_or_deletes_a_waiting_recording_and_moves_a_debrief(client, settle, monkeypatch):
    _no_keys(monkeypatch)
    fp1 = _run(client, "FP1", "09/10/2026", "10:00:00", 1800)
    fp2 = _run(client, "FP2", "09/10/2026", "14:00:00", 1800)
    first = client.post("/debriefs/audio", files={"audio": ("a.m4a", b"a")}, data={"recorded_at": "2026-10-01T09:00"})
    second = client.post("/debriefs/audio", files={"audio": ("b.m4a", b"b")}, data={"recorded_at": "2026-10-02T09:00"})
    first, second = first.json()["waiting"], second.json()["waiting"]
    assert [w["id"] for w in client.get("/debriefs/waiting").json()] == [second["id"], first["id"]]

    d = client.post(f"/debriefs/waiting/{first['id']}/run", json={"session_id": fp1}).json()
    assert d["session_id"] == fp1 and d["linked"] == {**d["linked"], "by": "user", "confirmed": True}
    assert client.delete(f"/debriefs/waiting/{second['id']}").status_code == 200
    settle()
    assert client.get("/debriefs/waiting").json() == []
    assert client.delete(f"/debriefs/waiting/{first['id']}").status_code == 409

    # a typed debrief can move to another run too
    typed = client.post(f"/sessions/{fp1}/debriefs", json={"points": [{"section": "tyres", "text": "Rears gone"}]})
    moved = client.post(f"/debriefs/{typed.json()['id']}/run", json={"session_id": fp2}).json()
    assert moved["session_id"] == fp2 and moved["linked"] is None


def test_bad_recording_time_and_type(client):
    r = client.post("/debriefs/audio", files={"audio": ("a.m4a", b"a")}, data={"recorded_at": "yesterday"})
    assert r.status_code == 422
    assert client.post("/debriefs/audio", files={"audio": ("a.txt", b"a")}).status_code == 415


def test_free_path_phone_transcript_sorted_by_keywords(client, settle, monkeypatch):
    """No keys: what the phone wrote down while recording is sorted into points by keywords."""
    import json

    _no_keys(monkeypatch)
    track = client.post("/tracks", json={"name": "Hockenheim", "corners": [
        {"code": "T1", "name": "Nordkurve"}, {"code": "T6", "name": "Haarnadel"}]}).json()
    fp2 = _run(client, "FP2", "09/10/2026", "14:00:00", 1800, track_id=track["id"])
    live = [{"start": 1.2, "end": 6.0, "text": "Big understeer at turn-in in the hairpin turn six"},
            {"start": 6.5, "end": 9.0, "text": "nice weather today"},
            {"start": 9.5, "end": 14.0, "text": "Rears overheating after five laps. Front left locks under braking"}]
    r = client.post(f"/sessions/{fp2}/debriefs/audio", files={"audio": ("debrief.webm", b"fake audio")},
                    data={"language": "en", "live_transcript": json.dumps(live)})
    assert r.status_code == 202, r.text
    settle()
    d = client.get(f"/debriefs/{r.json()['id']}").json()
    assert d["status"] == "ready", d["error"]
    got = [(p["section"], p["corner_code"], p["phase"], p["audio_start_s"]) for p in d["points"]]
    assert got == [("balance", "T6", "entry", 1.2), ("tyres", None, None, 9.5), ("brakes", None, "braking", 9.5)]
    assert d["transcript"].startswith("S0: Big understeer")
    assert "car balance" in d["summary"]

    bad = client.post(f"/sessions/{fp2}/debriefs/audio", files={"audio": ("d.webm", b"x")},
                      data={"live_transcript": "not json"})
    assert bad.status_code == 422


def test_keyword_sorting_in_three_languages():
    from app.debrief import keywords
    from app.debrief.structure import Context
    from app.debrief.transcribe import Segment, Transcript

    tr = Transcript([Segment("S0", 0, 3, "Sottosterzo in ingresso alla curva tre"),
                     Segment("S0", 3, 6, "Das Heck kommt beim Kurvenausgang in Kurve 12"),
                     Segment("S0", 6, 9, "Can we try a softer front anti-roll bar"),
                     Segment("S0", 9, 12, "Traction out of the Nordkurve is good")])
    out = keywords.structure(tr, Context(corners=[("T1", "Nordkurve")]))
    got = [(p["section"], p["corner"], p["phase"]) for p in out["points"]]
    assert got == [("balance", "T3", "entry"), ("balance", "T12", "exit"), ("setup", None, None),
                   ("traction", "T1", None)]
    assert out["speakers"] == [{"label": "S0", "role": "driver", "name": None}]
