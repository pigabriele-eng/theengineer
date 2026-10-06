from app.known_tracks import KNOWN, known_track


def test_zandvoort_has_its_fourteen_official_corners_in_lap_order():
    for name in ("Zandvoort", "Circuit Zandvoort", "  circuit zandvoort "):
        assert known_track(name)[0] == "Circuit Zandvoort"
    t = KNOWN["Circuit Zandvoort"]
    assert [c[0] for c in t["corners"]] == [f"T{i}" for i in range(1, 15)]
    at = [c[1] for c in t["corners"]]
    assert at == sorted(at) and 0 < at[0] and at[-1] < t["length_m"]
    sectors = {c[0]: c[2] for c in t["corners"] if c[2]}
    assert sectors == {"T6": "T6-T7", "T7": "T6-T7", "T11": "T11-T12", "T12": "T11-T12"}


def test_a_track_stored_without_corners_gets_the_official_ones_when_next_used(client):
    import app.db
    import app.models
    from app.routers.sessions import official_corners

    with app.db.SessionLocal() as db:  # as a log header named it before its corners were known
        db.add(app.models.Track(name="Zandvoort"))
        db.commit()
    track_id = client.get("/tracks").json()[0]["id"]
    assert client.get(f"/tracks/{track_id}").json()["corners"] == []

    with app.db.SessionLocal() as db:
        track = db.get(app.models.Track, track_id)
        corners = official_corners(track)
        db.commit()
    assert [c[0] for c in corners] == [f"T{i}" for i in range(1, 15)]
    assert corners[2] == ("T3", 821, None)
    stored = client.get(f"/tracks/{track_id}").json()
    assert len(stored["corners"]) == 14 and stored["length_m"] == 4259

    # corners the user set are never replaced
    client.put(f"/tracks/{track_id}/corners", json=[{"code": "T1", "apex_m": 300}])
    with app.db.SessionLocal() as db:
        assert official_corners(db.get(app.models.Track, track_id)) == [("T1", 300, None)]
