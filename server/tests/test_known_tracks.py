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


def test_two_requests_reading_a_track_at_once_give_it_its_corners_once(client):
    """Pages read the track's corners and give a track stored without them the official ones: two requests doing
    so at the same moment, each with the track as it was before, add them once."""
    import app.db
    import app.models
    from app.routers.sessions import official_corners

    with app.db.SessionLocal() as db:
        db.add(app.models.Track(name="Zandvoort"))
        db.commit()
    track_id = client.get("/tracks").json()[0]["id"]
    with app.db.SessionLocal() as a, app.db.SessionLocal() as b:
        ta, tb = a.get(app.models.Track, track_id), b.get(app.models.Track, track_id)
        assert ta.corners == [] and tb.corners == []  # both read it before either added them
        assert len(official_corners(ta)) == 14
        assert len(official_corners(tb)) == 14
        a.commit()
        b.commit()
    stored = client.get(f"/tracks/{track_id}").json()
    assert [c["code"] for c in stored["corners"]] == [f"T{i}" for i in range(1, 15)]


def test_every_known_track_numbers_its_corners_in_lap_order_from_a_source():
    for key, t in KNOWN.items():
        at = [c[1] for c in t["corners"]]
        assert at == sorted(at) and 0 < at[0] and at[-1] < t["length_m"], key
        numbers = [int(c[0][1:]) for c in t["corners"]]
        assert numbers == sorted(numbers) and numbers[0] == 1, key
        for code, _, sector in t["corners"]:  # a sector holds the corners it names
            if sector:
                first, last = (int(x[1:]) for x in sector.split("-"))
                assert first <= int(code[1:]) <= last, key
        assert key == "Hockenheim GP" or t["source"].startswith("https://"), key


def test_season_venues_find_their_track_and_other_layouts_do_not():
    for name, key in [("Paul Ricard", "Circuit Paul Ricard"), ("Le Castellet", "Circuit Paul Ricard"),
                      ("Monza", "Autodromo Nazionale Monza"), ("Spa-Francorchamps", "Circuit de Spa-Francorchamps"),
                      ("Circuit de Spa-Francorchamps", "Circuit de Spa-Francorchamps"),
                      ("N&uuml;rburgring", "Nürburgring GP"), ("Nürburgring", "Nürburgring GP"),
                      ("Red Bull Ring", "Red Bull Ring"), ("Imola", "Autodromo Enzo e Dino Ferrari"),
                      ("Silverstone", "Silverstone Circuit"), ("Brands Hatch", "Brands Hatch GP"),
                      ("Magny-Cours", "Circuit de Nevers Magny-Cours"), ("Hockenheimring", "Hockenheim GP"),
                      ("Misano World Circuit Marco Simoncelli", "Misano World Circuit")]:
        assert known_track(name)[0] == key, name
    for name in ("Nürburgring Nordschleife", "Brands Hatch Indy", "Circuit de Barcelona-Catalunya, Spain",
                 "Test Track", "", None):
        assert known_track(name) is None, name
