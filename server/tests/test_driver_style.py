"""Driver fingerprints: telling drivers apart by style alone, naming them from tags and from other events, driver
changes at a stop, and the API on top. Synthetic data only."""
import time

import numpy as np

from app.analysis import driver_style as ds
from tests import synthetic
from tests.synthetic import simulate, write_ld

LENGTH = 1000


def _trace(corners: tuple[float, ...], style: str, pace: float, rng: np.random.Generator) -> dict[str, np.ndarray]:
    """A lap on a 1 m grid. Style "smooth" builds the brake slowly, peaks lower and trails it into the corner;
    "sharp" brakes later and harder, releases before turning and picks the throttle up early."""
    d = np.arange(LENGTH + 1, dtype=float)
    v = np.full_like(d, 160.0 * pace)
    brake = np.zeros_like(d)
    throttle = np.full_like(d, 100.0)
    steer = np.zeros_like(d)
    for apex in corners:
        a = int(apex)
        v -= 90 * pace * np.exp(-(((d - apex) / (45 if style == "smooth" else 32)) ** 2))
        steer += 60 * np.exp(-(((d - apex) / 40) ** 2))
        if style == "smooth":
            on, peak, off, t_on, ramp = a - 120, a - 70, a - 5, a + 10, 60
            brake[on:peak] = np.linspace(0, 70, peak - on)
            brake[peak:off] = np.linspace(70, 0, off - peak)
        else:
            on, peak, off, t_on, ramp = a - 90, a - 85, a - 40, a - 15, 25
            brake[on:peak] = np.linspace(0, 100, peak - on)
            brake[peak:off] = 100
            brake[off:off + 5] = np.linspace(100, 0, 5)
        throttle[on:t_on] = 0
        throttle[t_on:t_on + ramp] = np.linspace(10, 100, ramp)
    v *= 1 + rng.normal(0, 0.003)
    t = np.concatenate([[0.0], np.cumsum(1 / (v[1:] / 3.6))])
    noise = lambda x, s: x + rng.normal(0, s, len(x))  # noqa: E731
    return {"t": t, "speed": v, "throttle": np.clip(noise(throttle, 1.0), 0, 100),
            "brake": np.clip(noise(brake, 1.0), 0, None), "steer": noise(steer, 0.5),
            "gear": np.where(v < 100, 3.0, 4.0)}


def _event(runs: list[tuple[int, list[str]]], corners=(250.0, 600.0, 850.0), seed=1) -> list[ds.EventLap]:
    """Every run's laps in order, one style per lap (a run's styles can change at a stop: lap numbers skip one)."""
    rng = np.random.default_rng(seed)
    laps = []
    for sid, styles in runs:
        n = 1
        for i, style in enumerate(styles):
            if i and style != styles[i - 1]:
                n += 1  # the in-lap and out-lap of the driver change are not clean laps
            tr = _trace(corners, style, 1 - rng.uniform(0, 0.01), rng)
            laps.append(ds.EventLap(sid, n, float(tr["t"][-1]), tr))
            n += 1
    return laps


def test_two_styles_are_told_apart_without_names():
    laps = _event([(1, ["smooth"] * 6), (2, ["sharp"] * 6), (3, ["smooth"] * 5), (4, ["sharp"] * 5)])
    ep = ds.event_print(laps)
    g = ds.guess(ep, {})
    assert g.mode == "groups" and g.separation >= ds.CLEAR_SPLIT and len(g.groups) == 2
    by = {s.session_id: s for s in g.sessions}
    assert by[1].group == by[3].group != by[2].group == by[4].group
    assert all(s.share == 1.0 and len(s.stints) == 1 for s in g.sessions)
    assert all(grp.driver_id is None and grp.source == "" for grp in g.groups)
    assert ds.confidence(g, g.groups[by[1].group], by[1].share) == "sure"
    smooth = ds.traits(g.groups[by[1].group].v, ep.kinds)
    words = {t["kind"]: t["words"] for t in smooth}
    assert words["trail"] == "trails the brake deeper into the corner"
    assert words["brake_build"] == "builds the brake pressure more gradually"
    assert all(t["label"] and t["explain"] for t in smooth)


def test_one_driver_is_one_style():
    ep = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["smooth"] * 6), (3, ["smooth"] * 6)]))
    g = ds.guess(ep, {2: 9})
    assert g.mode == "one style" and len(g.groups) == 1
    assert g.groups[0].driver_id == 9 and g.groups[0].source == "tag"  # the one tagged run names everyone's laps
    assert {s.group for s in g.sessions} == {0}


def test_tagged_runs_name_the_others():
    ep = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["sharp"] * 6), (3, ["smooth"] * 5), (4, ["sharp"] * 5)]))
    g = ds.guess(ep, {1: 11, 2: 22})
    assert g.mode == "tagged"
    named = {s.session_id: g.groups[s.group].driver_id for s in g.sessions}
    assert named == {1: 11, 2: 22, 3: 11, 4: 22}


def test_a_driver_change_at_a_stop_splits_the_run():
    ep = ds.event_print(_event([(1, ["smooth"] * 5 + ["sharp"] * 6), (2, ["sharp"] * 5), (3, ["smooth"] * 4)]))
    g = ds.guess(ep, {})
    by = {s.session_id: s for s in g.sessions}
    stints = by[1].stints
    assert [(st.laps[0], st.laps[-1]) for st in stints] == [(1, 5), (7, 12)]
    assert stints[0].group == by[3].group and stints[1].group == by[2].group
    assert by[1].group == stints[1].group  # the longer stint is the run's suggestion


def test_a_lap_or_two_is_not_a_driver_change():
    assert len(ds._stints([1, 2, 3, 5, 6, 7, 8], [0, 0, 0, 1, 0, 0, 0])) == 1
    assert len(ds._stints([1, 2, 3, 4, 6, 7], [0, 0, 0, 0, 1, 1])) == 1  # two laps after the stop: too few
    st = ds._stints([1, 2, 3, 4, 6, 7, 8], [0, 0, 0, 0, 1, 1, 1])
    assert [(s.laps, s.group) for s in st] == [([1, 2, 3, 4], 0), ([6, 7, 8], 1)]


def test_a_fingerprint_from_one_track_finds_the_driver_at_another():
    first = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["sharp"] * 6), (3, ["sharp"] * 4)]))
    g = ds.guess(first, {1: 11, 2: 22})
    known = {grp.driver_id: grp.v for grp in g.groups}
    # another track (other corners), nothing tagged
    other = ds.event_print(_event([(5, ["sharp"] * 6), (6, ["smooth"] * 6), (7, ["smooth"] * 4)],
                                  corners=(150.0, 420.0, 700.0, 900.0), seed=2))
    known = {d: np.array([dict(zip(first.kinds, v, strict=True)).get(k, 0.0) for k in other.kinds])
             for d, v in known.items()}
    g2 = ds.guess(other, {}, known)
    named = {s.session_id: g2.groups[s.group].driver_id for s in g2.sessions}
    assert named == {5: 22, 6: 11, 7: 11}
    assert all(grp.source == "fingerprint" and grp.match > 0.5 for grp in g2.groups)


def test_quicker_laps_tell_what_pays():
    rng = np.random.default_rng(3)
    rows = []
    for _ in range(6):
        trail = rng.normal(0, 1, 8)
        t = 100 - 0.3 * trail + rng.normal(0, 0.1, 8)  # more trail braking, quicker laps
        rows.append((t, np.stack([trail, rng.normal(0, 1, 8)], 1)))
    links = ds.lap_time_links(rows, ["trail", "steer_lock"])
    assert links[0]["kind"] == "trail" and links[0]["r"] < -0.5 and links[0]["laps"] == 48
    assert links[0]["words"] == "On quicker laps the driver trails the brake deeper into the corner"
    assert all(link["kind"] != "steer_lock" for link in links)


def test_the_car_s_other_driver_names_the_other_style():
    ep = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["sharp"] * 6), (3, ["sharp"] * 5)]))
    g = ds.guess(ep, {1: 11}, pair=(11, 22))
    assert {s.session_id: g.groups[s.group].driver_id for s in g.sessions} == {1: 11, 2: 22, 3: 22}
    other = next(grp for grp in g.groups if grp.driver_id == 22)
    assert other.source == "entry" and ds.confidence(g, other, 1.0) == "sure"
    g = ds.guess(ep, {1: 11}, pair=(33, 22))  # the tagged driver isn't one of the car's: nothing follows
    assert {grp.driver_id for grp in g.groups} == {11, None}


def test_of_two_drivers_a_fingerprint_only_has_to_say_which_way_round():
    """Every outing that isn't one of the car's two drivers is the other: a fingerprint far below a sure match still
    names both styles, the right way round; with no fingerprint of either, or no clear way round, nothing is named."""
    ep = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["sharp"] * 6), (3, ["sharp"] * 5)]))
    g = ds.guess(ep, {})
    smooth = next(i for i, grp in enumerate(g.groups) if any(s.session_id == 1 and s.group == i for s in g.sessions))
    u = g.groups[smooth].v / np.linalg.norm(g.groups[smooth].v)
    w = np.random.default_rng(1).standard_normal(len(ep.kinds))
    w -= (w @ u) * u
    weak = 0.15 * u + np.sqrt(1 - 0.15 ** 2) * w / np.linalg.norm(w)  # cosine 0.15 to the smooth style
    assert ds._cos(weak, g.groups[smooth].v) < ds.MATCH_COS  # too weak to name anyone on its own
    g = ds.guess(ep, {}, {11: weak}, max_groups=2, pair=(11, 22))
    assert {s.session_id: g.groups[s.group].driver_id for s in g.sessions} == {1: 11, 2: 22, 3: 22}
    assert {grp.source for grp in g.groups} == {"pair"}
    g = ds.guess(ep, {}, {11: -weak}, max_groups=2, pair=(22, 11))  # either order of the pair
    assert {s.session_id: g.groups[s.group].driver_id for s in g.sessions} == {1: 22, 2: 11, 3: 11}
    assert {grp.driver_id for grp in ds.guess(ep, {}, {}, max_groups=2, pair=(11, 22)).groups} == {None}
    flat = np.zeros(len(ep.kinds))
    assert {grp.driver_id for grp in ds.guess(ep, {}, {11: flat}, max_groups=2, pair=(11, 22)).groups} == {None}


def test_too_few_laps_suggest_nothing():
    assert ds.event_print(_event([(1, ["smooth"] * 3)])) is None


def test_a_lift_without_the_throttle_back_is_not_early_throttle():
    # a lift with no braking where the throttle never comes back: it is on at the corner's end, not 100 m early
    d = np.arange(LENGTH, dtype=float)
    tr = {"t": d / 50, "speed": 200 - 40 * np.exp(-((d - 500) / 60) ** 2), "brake": np.zeros(LENGTH),
          "steer": np.sin(d / 50), "throttle": np.where(d < 380, 100.0, 0.0)}
    f = ds.lap_features(tr, [ds.Corner("C1", 500, 200, 900)], 1.0, 1.0)
    assert f["C1_throttle_on"] == 300


# ---------- the API ----------

def _sharp_speed(d, pace):
    """A later, harder stop than the synthetic default: another driver."""
    from tests.synthetic import CORNERS_M
    a, b = (d - CORNERS_M[0]) / 28.0, (d - CORNERS_M[1]) / 28.0
    return (150.0 - 100.0 * np.exp(-(a * a)) - 80.0 * np.exp(-(b * b))) * pace


def _log(paces, at: str, sharp=False) -> bytes:
    """A synthetic log recorded at the time given (HH:MM:SS): logs with the same header are one log uploaded again."""
    default = synthetic.speed_at
    synthetic.speed_at = _sharp_speed if sharp else default
    try:
        return write_ld(simulate(paces=paces)[0]).replace(b"12:00:00", at.encode(), 1)
    finally:
        synthetic.speed_at = default


def test_event_suggestions_and_the_fingerprint_database(client, monkeypatch):
    ev = client.post("/events/folders", json={"name": "Test weekend"}).json()
    paces = {"A1": ((1.0, 0.99, 0.995, 0.985, 0.99), False), "B1": ((0.99, 0.985, 0.99, 0.98, 0.995), True),
             "A2": ((0.995, 0.99, 0.985, 0.99), False), "B2": ((0.985, 0.99, 0.995, 0.99), True)}
    ids = {}
    for n, (name, (p, sharp)) in enumerate(paces.items()):
        s = client.post("/sessions", json={"event_id": ev["id"], "name": name}).json()
        log = _log(p, f"1{n}:00:00", sharp)
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log)})
        assert r.status_code == 201, r.text
        ids[name] = s["id"]

    url = f"/events/{ev['id']}/driver-guess"
    t0 = time.monotonic()
    body = client.get(url).json()
    while body["status"] == "working" and time.monotonic() - t0 < 120:
        time.sleep(0.2)
        body = client.get(url).json()
    assert body["status"] == "ready" and body["mode"] == "groups"
    sugg = {s["session_id"]: s["suggestion"] for s in body["sessions"]}
    assert sugg[ids["A1"]]["group"] == sugg[ids["A2"]]["group"] != sugg[ids["B1"]]["group"] == sugg[ids["B2"]]["group"]
    assert all(s["driver_id"] is None and s["agrees"] is None for s in body["sessions"])
    assert {g["label"] for g in body["groups"]} == {"New driver"}  # never a letter
    from app import driver_prints

    driver_prints.refresh_in_background()
    driver_prints.wait_idle()
    (q,) = client.get("/season-match/pending", params={"event_id": ev["id"]}).json()["questions"]
    assert q["kind"] == "driver" and q["prompt"].startswith("New driver found in ") and q["runs"] == 2

    # tag one run of each driver: the others are named after them, and the database learns both
    for name, driver in (("A1", "Anna"), ("B1", "Ben")):
        assert client.put(f"/sessions/{ids[name]}/driver", json={"driver_name": driver}).status_code == 200
    body = client.get(url).json()
    assert body["mode"] == "tagged"
    sugg = {s["session_id"]: s["suggestion"] for s in body["sessions"]}
    assert sugg[ids["A2"]]["driver"] == "Anna" and sugg[ids["B2"]]["driver"] == "Ben"
    assert sugg[ids["A2"]]["confidence"] in ("sure", "likely")
    assert {s["session_id"]: s["agrees"] for s in body["sessions"]}[ids["A1"]] is True

    driver_prints.wait_idle()  # the tags' background pass keeps the page
    db = client.get("/drivers/fingerprints").json()
    assert db["events"] == 1 and {d["driver"] for d in db["drivers"]} == {"Anna", "Ben"}
    anna = next(d for d in db["drivers"] if d["driver"] == "Anna")
    assert anna["events"][0]["event"] == "Test weekend" and anna["events"][0]["teammates"] == ["Ben"]
    assert anna["traits"] and all({"label", "explain", "words"} <= set(t) for t in anna["traits"])
    assert db["kinds"] and db["unnamed"] == []

    # kept: the next open answers without working it out again
    from app.routers import driver_style

    def worked_out(_db):
        raise AssertionError("worked out while the page waits")

    driver_prints.wait_idle()
    kept = client.get("/drivers/fingerprints").json()
    monkeypatch.setattr(driver_style, "build_page", worked_out)
    assert client.get("/drivers/fingerprints").json() == kept
    # after a change the kept page comes at once, marked as being updated, until the background pass keeps the new one
    monkeypatch.setattr(driver_prints, "refresh_in_background", lambda: True)
    anna_id = next(d["driver_id"] for d in kept["drivers"] if d["driver"] == "Anna")
    assert client.patch(f"/drivers/{anna_id}", json={"name": "Anna P"}).status_code == 200
    body = client.get("/drivers/fingerprints").json()
    assert body["updating"] is True and body["drivers"] == kept["drivers"]
    monkeypatch.undo()
    driver_prints.refresh_in_background()
    driver_prints.wait_idle()
    body = client.get("/drivers/fingerprints").json()
    assert body["updating"] is False and {d["driver"] for d in body["drivers"]} == {"Anna P", "Ben"}


def test_an_unknown_event_has_no_suggestions(client):
    assert client.get("/events/999/driver-guess").status_code == 404
    body = client.get("/drivers/fingerprints").json()
    assert body["drivers"] == [] and body["events"] == 0


def _weekend(client, name: str, runs: dict[str, tuple[tuple[float, ...], bool]], hour: int) -> dict[str, int]:
    ev = client.post("/events/folders", json={"name": name}).json()
    ids = {}
    for n, (run, (p, sharp)) in enumerate(runs.items()):
        s = client.post("/sessions", json={"event_id": ev["id"], "name": run}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", _log(p, f"{hour}:{n}0:00", sharp))})
        assert r.status_code == 201, r.text
        ids[run] = s["id"]
    return {"event": ev["id"], **ids}


def test_drivers_are_set_from_the_style_by_themselves(client):
    from app import driver_prints
    from app.routers import reports

    smooth, sharp = (1.0, 0.99, 0.995, 0.985, 0.99), (0.99, 0.985, 0.99, 0.98, 0.995)
    first = _weekend(client, "First weekend", {"A1": (smooth, False), "B1": (sharp, True)}, 10)
    second = _weekend(client, "Second weekend", {"A2": (smooth, False), "B2": (sharp, True)}, 14)
    for ev in (first["event"], second["event"]):  # asking makes the lap traces (an import's report does too)
        t0 = time.monotonic()
        while client.get(f"/events/{ev}/driver-guess").json()["status"] == "working" and time.monotonic() - t0 < 120:
            time.sleep(0.2)
    assert reports.wait_idle()
    for run, driver in (("A1", "Anna"), ("B1", "Ben")):  # a person tags the first weekend
        assert client.put(f"/sessions/{first[run]}/driver", json={"driver_name": driver}).status_code == 200
    driver_prints.wait_idle()

    names = {d["id"]: d["name"] for d in client.get("/garage").json()["drivers"]}
    body = client.get(f"/events/{second['event']}/driver-guess").json()
    by = {s["session_id"]: s for s in body["sessions"]}
    assert names[by[second["A2"]]["driver_id"]] == "Anna" and names[by[second["B2"]]["driver_id"]] == "Ben"
    assert by[second["A2"]]["auto"]["source"] == "fingerprint" and by[second["A2"]]["auto"]["match"] >= 0.5
    first_runs = client.get(f"/events/{first['event']}/driver-guess").json()["sessions"]
    assert all(s["auto"] is None for s in first_runs)  # tagged by a person

    # a person clears one: it stays cleared, and the style only suggests it
    assert client.put(f"/sessions/{second['A2']}/driver", json={}).status_code == 200
    driver_prints.wait_idle()
    by = {s["session_id"]: s for s in client.get(f"/events/{second['event']}/driver-guess").json()["sessions"]}
    a2 = by[second["A2"]]
    assert a2["driver_id"] is None and a2["auto"] is None and a2["suggestion"]["driver"] == "Anna"

    # only people's tags teach the fingerprints
    db = client.get("/drivers/fingerprints").json()
    anna = next(d for d in db["drivers"] if d["driver"] == "Anna")
    assert [e["event"] for e in anna["events"]] == ["First weekend"]


def test_every_pick_refines_the_fingerprint_and_a_correction_moves_it(client):
    """Only a person's picks teach, from the laps of the runs they put the driver on: a run the style named after them
    doesn't, the same pick made by a person does, and moving it to someone else takes its laps along."""
    from app import driver_prints
    from app.routers import reports

    smooth, sharp = (1.0, 0.99, 0.995, 0.985, 0.99), (0.99, 0.985, 0.99, 0.98, 0.995)
    ev = _weekend(client, "Test day", {"A1": (smooth, False), "B1": (sharp, True), "A2": (smooth, False)}, 10)
    t0 = time.monotonic()
    while client.get(f"/events/{ev['event']}/driver-guess").json()["status"] == "working":
        assert time.monotonic() - t0 < 120
        time.sleep(0.2)
    assert reports.wait_idle()

    def laps() -> dict[str, int]:
        driver_prints.wait_idle()
        return {d["driver"]: d["laps"] for d in client.get("/drivers/fingerprints").json()["drivers"]}

    assert client.put(f"/sessions/{ev['A1']}/driver", json={"driver_name": "Anna"}).status_code == 200
    one = laps()["Anna"]
    got = {s["session_id"]: s for s in client.get(f"/events/{ev['event']}/driver-guess").json()["sessions"]}
    assert got[ev["A2"]]["auto"] is not None  # named after A1 by the style: the app's, so it doesn't teach
    anna = got[ev["A1"]]["driver_id"]
    assert client.put(f"/sessions/{ev['A2']}/driver", json={"driver_id": anna}).status_code == 200
    both = laps()["Anna"]
    assert both > one
    assert client.put(f"/sessions/{ev['A2']}/driver", json={"driver_name": "Ben"}).status_code == 200
    assert laps() == {"Anna": one, "Ben": both - one}

    # the event page's answer is kept until a driver changes: asked again, the style isn't worked out again
    first = client.get(f"/events/{ev['event']}/driver-guess").json()
    worked = []
    guess_for = driver_prints.guess_for
    driver_prints.guess_for = lambda *a, **k: worked.append(1) or guess_for(*a, **k)
    try:
        assert client.get(f"/events/{ev['event']}/driver-guess").json() == first and not worked
        assert client.put(f"/sessions/{ev['B1']}/driver", json={"driver_name": "Ben"}).status_code == 200
        driver_prints.wait_idle()
        again = client.get(f"/events/{ev['event']}/driver-guess").json()
        assert worked and {s["session_id"]: s["driver_id"] for s in again["sessions"]}[ev["B1"]] is not None
    finally:
        driver_prints.guess_for = guess_for


def test_a_new_pair_is_asked_about_once_and_known_by_style_after(client):
    from app import driver_prints
    from app.routers import reports

    smooth, sharp = (1.0, 0.99, 0.995, 0.985, 0.99), (0.99, 0.985, 0.99, 0.98, 0.995)
    first = _weekend(client, "First weekend", {"A1": (smooth, False), "B1": (sharp, True),
                                               "A2": (smooth, False), "B2": (sharp, True)}, 10)
    second = _weekend(client, "Second weekend", {"A3": (smooth, False), "B3": (sharp, True)}, 14)
    pair = [client.post("/garage/drivers", json={"name": n}).json()["id"] for n in ("Anna", "Ben")]
    for ev in (first["event"], second["event"]):  # the car's two drivers, as the entry list says
        assert client.put(f"/events/{ev}/info", json={"drivers": pair}).status_code == 200
        t0 = time.monotonic()
        while client.get(f"/events/{ev}/driver-guess").json()["status"] == "working" and time.monotonic() - t0 < 120:
            time.sleep(0.2)
    assert reports.wait_idle()
    driver_prints.refresh_in_background()
    driver_prints.wait_idle()

    # nobody known yet: one question for the first weekend, the car's drivers as the answers
    (q,) = client.get("/season-match/pending", params={"event_id": first["event"]}).json()["questions"]
    assert q["kind"] == "driver" and q["prompt"] in ("New driver found in A1 and A2: who is this?",
                                                     "New driver found in B1 and B2: who is this?")
    assert [o["label"] for o in q["options"]] == ["Anna", "Ben"]
    assert q["why"].endswith("The other runs then go to the car's other driver.")
    anna_first = "A1" in q["prompt"]
    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0 if anna_first else 1]["key"]})
    assert r.status_code == 200, r.text
    driver_prints.wait_idle()

    # the other style is the other driver, and the second weekend is known by style: no question left
    names = {d["id"]: d["name"] for d in client.get("/garage").json()["drivers"]}
    for ev, runs in ((first, ("A1", "A2", "B1", "B2")), (second, ("A3", "B3"))):
        got = {s["session_id"]: s for s in client.get(f"/events/{ev['event']}/driver-guess").json()["sessions"]}
        assert [names.get(got[ev[run]]["driver_id"]) for run in runs] == ["Anna" if r[0] == "A" else "Ben"
                                                                          for r in runs]
    assert client.get("/season-match/pending").json()["count"] == 0
    got = {s["session_id"]: s for s in client.get(f"/events/{second['event']}/driver-guess").json()["sessions"]}
    assert all(s["auto"] is not None for s in got.values())  # shown as set from the style, with Change


    # the fingerprints page names each style's runs, to name or put right in one go: a person's name replaces the
    # style's, and teaches
    driver_prints.wait_idle()
    page = client.get("/drivers/fingerprints").json()
    side = "A" if anna_first else "B"  # the driver named by the answer: only a person's answer teaches
    (learned,) = page["drivers"]
    assert learned["driver"] == ("Anna" if anna_first else "Ben")
    assert sorted(learned["events"][0]["session_ids"]) == sorted([first[f"{side}1"], first[f"{side}2"]])
    (found,) = learned["also_found"]
    assert found["event"] == "Second weekend" and found["session_ids"] == [second[f"{side}3"]]
    other = pair[1] if anna_first else pair[0]
    r = client.post("/drivers/assign", json={"driver_id": other, "session_ids": found["session_ids"]})
    assert r.status_code == 200, r.text
    got = {s["session_id"]: s for s in client.get(f"/events/{second['event']}/driver-guess").json()["sessions"]}
    assert got[second[f"{side}3"]]["driver_id"] == other and got[second[f"{side}3"]]["auto"] is None


def test_a_run_deleted_since_and_one_failing_event_don_t_stop_the_others(client, monkeypatch):
    from app import driver_prints
    from app.db import SessionLocal

    anna = client.post("/garage/drivers", json={"name": "Anna"}).json()["id"]
    evs = [client.post("/events/folders", json={"name": n}).json()["id"] for n in ("First", "Second")]
    gone = ds.Guess(mode="groups", separation=None, groups=[ds.Group(driver_id=anna, source="fingerprint", laps=9)],
                    sessions=[ds.SessionGuess(session_id=987654, group=0, share=1.0, laps=9)], labels=np.array([]))
    monkeypatch.setattr(driver_prints, "guess_for", lambda *a, **k: gone)
    with SessionLocal() as db:  # the print names a run that was deleted since
        assert driver_prints.settle(db, evs[0], object(), {}) == 0
        for ev in evs:
            db.add(driver_prints.StylePrint(event_id=ev, signature="s", payload={}))
        db.commit()
        real, seen = driver_prints.settle, []

        def settle(db, event_id, ep, learned):
            seen.append(event_id)
            if event_id == evs[0]:
                raise RuntimeError("broken event")
            return real(db, event_id, ep, learned)

        monkeypatch.setattr(driver_prints, "settle", settle)
        driver_prints.settle_all(db, {ev: ("s", []) for ev in evs})
        assert seen == evs  # the second event is still settled
