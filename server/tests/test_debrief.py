"""Voice debrief: recording upload, processing with fake providers, and the Claude request shape."""
import json
from types import SimpleNamespace

from app.debrief import structure as structure_mod
from app.debrief import transcribe as transcribe_mod
from app.debrief.transcribe import Segment, Transcript, parse_deepgram

TRANSCRIPT = Transcript([
    Segment("S0", 0.5, 6.0, "So, how was the car?"),
    Segment("S1", 6.2, 14.8, "Big understeer at turn-in in the hairpin, and it gets worse on new tyres."),
    Segment("S1", 15.0, 20.0, "Traction out of the Schöller S is good now."),
])

STRUCTURED = {
    "summary": "Entry understeer in the hairpin is the main limit.",
    "speakers": [{"label": "S0", "role": "engineer", "name": None},
                 {"label": "S1", "role": "driver", "name": "Gabriele"}],
    "points": [
        {"section": "balance", "text": "Big understeer at turn-in in the hairpin, worse on new tyres.",
         "speaker": "S1", "corner": "Grundig", "phase": "entry", "audio_start_s": 6.2},
        {"section": "traction", "text": "Traction out of the Schöller S is good now.",
         "speaker": "S1", "corner": "Schöller S", "phase": "exit", "audio_start_s": 15.0},
    ],
}


def test_parse_deepgram_keeps_speakers_and_times():
    body = {"results": {"utterances": [
        {"speaker": 0, "start": 0.512, "end": 2.0, "transcript": " How was it? "},
        {"speaker": 1, "start": 2.2, "end": 5.0, "transcript": "Understeer in T1."},
        {"speaker": 1, "start": 5.2, "end": 5.4, "transcript": " "},
    ]}}
    tr = parse_deepgram(body)
    assert [(s.speaker, s.start, s.text) for s in tr.segments] == [("S0", 0.51, "How was it?"),
                                                                   ("S1", 2.2, "Understeer in T1.")]
    assert tr.text == "S0: How was it?\nS1: Understeer in T1."


def test_structure_request(monkeypatch):
    calls = {}

    class FakeMessages:
        def create(self, **kwargs):
            calls.update(kwargs)
            return SimpleNamespace(stop_reason="end_turn",
                                   content=[SimpleNamespace(type="text", text=json.dumps(STRUCTURED))])

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    import anthropic

    monkeypatch.setattr(anthropic, "Anthropic", lambda: SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages())))
    ctx = structure_mod.Context(track="Norisring", corners=[("T1", "Grundig")], car="BMW M2 Cup")
    assert structure_mod.structure(TRANSCRIPT, ctx) == STRUCTURED
    assert calls["model"] == "claude-opus-5-5"
    assert calls["fallbacks"] == "default"
    assert calls["output_config"]["format"]["schema"] is structure_mod.SCHEMA
    prompt = calls["messages"][0]["content"]
    assert "T1 (Grundig)" in prompt and "[S1 6.2s] Big understeer" in prompt


def test_recording_is_kept_until_keys_exist_then_processed(client, monkeypatch):
    track = client.post("/tracks", json={"name": "Norisring", "corners": [
        {"code": "T1", "name": "Grundig"}, {"code": "T2", "name": "Schöller S"}]}).json()
    driver = client.post("/drivers", json={"name": "Gabriele"}).json()
    event = client.post("/events", json={"name": "M2 Cup Norisring", "track_id": track["id"]}).json()
    s = client.post("/sessions", json={"event_id": event["id"], "driver_id": driver["id"], "name": "FP2"}).json()

    r = client.post(f"/sessions/{s['id']}/debriefs/audio", files={"audio": ("debrief.m4a", b"fake audio")},
                    data={"mode": "individual", "language": "it"})
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "queued"
    d = client.get(f"/debriefs/{r.json()['id']}").json()
    assert d["status"] == "failed" and "DEEPGRAM_API_KEY" in d["error"]
    assert d["has_audio"] and client.get(f"/debriefs/{d['id']}/audio").content == b"fake audio"

    seen = {}

    def fake_transcribe(path, language, key_terms=None):
        seen.update(language=language, key_terms=key_terms, audio=path.read_bytes())
        return TRANSCRIPT

    def fake_structure(tr, ctx):
        seen["ctx"] = ctx
        return STRUCTURED

    monkeypatch.setattr(transcribe_mod, "transcribe", fake_transcribe)
    monkeypatch.setattr(structure_mod, "structure", fake_structure)
    assert client.post(f"/debriefs/{d['id']}/process").status_code == 202

    d = client.get(f"/debriefs/{d['id']}").json()
    assert d["status"] == "ready", d["error"]
    assert seen["language"] == "it" and seen["audio"] == b"fake audio"
    assert seen["key_terms"] == ["Grundig", "Schöller S"]
    assert seen["ctx"].track == "Norisring" and seen["ctx"].session == "M2 Cup Norisring test FP2"
    assert d["speakers"]["S1"]["role"] == "driver"
    assert d["transcript"].startswith("S0: So, how was the car?")
    p1, p2 = d["points"]
    assert (p1["corner_code"], p1["corner_id"], p1["phase"]) == ("T1", track["corners"][0]["id"], "entry")
    assert p1["speaker_driver_id"] == driver["id"]
    assert p2["corner_code"] == "T2"


def test_accepts_a_whatsapp_voice_note(client):
    # WhatsApp shares voice notes as .opus, often typed application/ogg or octet-stream; the extension decides
    s = client.post("/sessions", json={}).json()
    r = client.post(f"/sessions/{s['id']}/debriefs/audio",
                    files={"audio": ("PTT-20261009-WA0003.opus", b"fake opus", "application/octet-stream")},
                    data={"mode": "individual", "language": "en"})
    assert r.status_code == 202, r.text
    d = client.get(f"/debriefs/{r.json()['id']}").json()
    assert d["has_audio"] and client.get(f"/debriefs/{d['id']}/audio").content == b"fake opus"


def test_rejects_non_audio(client):
    s = client.post("/sessions", json={}).json()
    r = client.post(f"/sessions/{s['id']}/debriefs/audio", files={"audio": ("notes.txt", b"x")})
    assert r.status_code == 415


def test_debrief_corners_line_up_with_logged_corners(client):
    from tests.synthetic import simulate, write_ld

    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "name": "Hairpin"}, {"code": "T2", "name": "Fast left", "apex_m": 690}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    s = client.post("/sessions", json={"event_id": event["id"]}).json()
    channels, _ = simulate()
    assert client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(channels))}).status_code == 201
    d = client.post(f"/sessions/{s['id']}/debriefs", json={"points": [
        {"section": "balance", "text": "Understeer in the hairpin", "corner_code": "T1"},
        {"section": "balance", "text": "Loose in the fast left", "corner_code": "T2", "phase": "exit"},
        {"section": "issues", "text": "Kerb at T9 is broken", "corner_code": "T9"},
    ]}).json()

    corners = client.get(f"/debriefs/{d['id']}/corners").json()["corners"]
    # T1 has no position on the track map, so the first slow point of the lap is not taken to be T1
    assert set(corners) == {"T2"}
    assert corners["T2"]["detected_code"] == "T2" and abs(corners["T2"]["apex_m"] - 700) < 40

    client.put(f"/tracks/{track['id']}/corners", json=[{"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 690}])
    corners = client.get(f"/debriefs/{d['id']}/corners").json()["corners"]
    assert set(corners) == {"T1", "T2"}
    assert abs(corners["T1"]["apex_m"] - 300) < 40
    assert abs(corners["T2"]["apex_m"] - 700) < 40
    assert corners["T1"]["reference"]["min_speed"] > 0 and corners["T1"]["best"]["time"] > 0
