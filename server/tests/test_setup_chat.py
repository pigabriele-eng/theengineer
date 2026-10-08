from app.setup.chat import (
    BY_KEY,
    already_label,
    limit_label,
    new_state,
    next_change,
    quick_replies,
    read_limits,
    read_reply,
    turn,
    turn_text,
)
from app.setup.templates import BMW_M4_GT4_EVO

UNDERSTEER_MID = {"type": "problem", "problem": {"kind": "understeer", "phase": "mid"}}


# ---------- reading replies ----------

def test_typed_limits_are_read_per_setting_and_axle():
    assert read_limits("we are already at minimum ride height") == [
        {"row": "ride_height", "axle": None, "want": "lower"}]
    assert read_limits("already on the softest spring") == [{"row": "spring", "axle": None, "want": "softer"}]
    assert read_limits("rear bar is already on the stiffest") == [{"row": "arb", "axle": "rear", "want": "stiffer"}]
    assert read_limits("wing is maxed") == [{"row": "wing", "axle": None, "want": "more downforce"}]
    assert read_limits("brake bias already all the way forward") == [
        {"row": "brake_balance", "axle": None, "want": "more front"}]
    assert read_limits("front ride height at minimum and softest rear spring") == [
        {"row": "ride_height", "axle": "front", "want": "lower"}, {"row": "spring", "axle": "rear", "want": "softer"}]
    assert read_limits("pressures already at the minimum 1.4 bar") == [
        {"row": "pressure_cold", "axle": None, "want": "lower"}]
    assert read_limits("the car understeers in T6") == []


def test_typed_answers_become_actions():
    assert read_reply("tried it, no better") == [{"type": "tried", "result": "no_better"}]
    assert read_reply("Tried it, it helped") == [{"type": "tried", "result": "helped"}]
    assert read_reply("something else please") == [{"type": "skip"}]
    assert read_reply("we're already there") == [{"type": "limit_current"}]
    assert read_reply("start over") == [{"type": "reset"}]
    p = read_reply("oversteer on exit of T2")[0]
    assert p["type"] == "problem" and (p["problem"]["kind"], p["problem"]["phase"], p["problem"]["corner"]) == (
        "oversteer", "exit", "T2")
    assert read_reply("no understeer at all") == []  # says the car doesn't do it


# ---------- the conversation ----------

def test_a_limit_moves_on_to_another_change_for_the_same_problem():
    st = turn(new_state(), UNDERSTEER_MID)
    first = st["current"]
    assert first["lever"] == "arb_front_softer"
    assert "understeer mid-corner" in first["why"]
    st = turn_text(st, "we are already on the softest front bar")
    assert st["limits"] == [{"row": "arb", "axle": "front", "want": "softer"}]
    assert st["current"]["lever"] != "arb_front_softer"
    assert "Noted for this event: front anti-roll bar on its softest position." in st["messages"][-1]["text"]
    # it never comes back while the limit holds, whatever else is said
    seen = {st["current"]["lever"]}
    for _ in range(12):
        st = turn(st, {"type": "skip"})
        if st["current"] is None:
            break
        seen.add(st["current"]["lever"])
    assert "arb_front_softer" not in seen and "spring_front_softer" in seen
    assert "no more changes" in st["messages"][-1]["text"]


def _offered(st: dict) -> dict[str, dict]:
    """Every change offered for the problems, skipping each in turn."""
    st = {**st, "skipped": list(st.get("skipped", []))}
    out = {}
    while (c := next_change(st)) is not None:
        out[c["lever"]] = c
        st["skipped"].append(c["lever"])
    return out


def test_ride_height_limits_make_rake_another_way_then_rule_it_out():
    st = {**new_state(), "problems": [{"kind": "understeer", "phase": "mid"}],
          "limits": [{"row": "ride_height", "axle": "front", "want": "lower"}]}
    rake = _offered(st)["rake_more"]
    assert rake["changes"] == ["Ride height rear: 2 mm higher"] and not rake["another_way"]
    st["limits"] = [{"row": "ride_height", "axle": "rear", "want": "higher"}]
    rake = _offered(st)["rake_more"]
    assert rake["changes"] == ["Ride height front: 2 mm lower"] and rake["another_way"]
    st["limits"].append({"row": "ride_height", "axle": "front", "want": "lower"})
    assert "rake_more" not in _offered(st)


def test_softest_spring_rules_out_the_spring_and_its_rate():
    st = {**new_state(), "limits": [{"row": "spring", "axle": None, "want": "softer"}],
          "problems": [{"kind": "traction", "phase": "exit"}]}
    levers = set(_offered(st))
    assert "spring_rear_softer" not in levers and "spring_front_softer" not in levers
    assert {"arb_rear_softer", "bump_rear_softer"} <= levers


def test_the_sheet_says_when_a_setting_is_at_its_end():
    st = {**new_state(), "problems": [{"kind": "understeer", "phase": "mid"}]}
    change = next_change(st, BMW_M4_GT4_EVO, {"arb_front": 1})  # already the softest position
    assert change["lever"] != "arb_front_softer"
    change = next_change(st, BMW_M4_GT4_EVO, {"arb_front": 3})
    assert change["changes"] == ["Anti-roll bar front 3 → 2"]


def test_tried_helped_and_gone():
    st = turn(new_state(), UNDERSTEER_MID)
    st = turn(st, {"type": "tried", "result": "helped"})
    assert st["current"] is None and st["tried"][0]["result"] == "helped"
    assert [q["label"] for q in quick_replies(st)] == ["Still some left", "Problem gone"]
    st = turn(st, {"type": "more"})
    assert st["current"]["lever"] != "arb_front_softer"
    st = turn(st, {"type": "gone"})
    assert st["problems"] == [] and st["current"] is None
    assert quick_replies(st)[0]["label"] == "Understeer on entry"


def test_quick_replies_offer_the_limit_of_the_change_on_the_table():
    st = turn(new_state(), UNDERSTEER_MID)
    labels = [q["label"] for q in quick_replies(st)]
    assert labels == ["Already on the softest front bar", "Tried it, it helped", "Tried it, no better",
                      "Something else"]
    st = turn(st, quick_replies(st)[0]["action"])
    assert st["limits"] == [{"row": "arb", "axle": "front", "want": "softer"}]


def test_reset_keeps_the_limits_and_forget_clears_one():
    st = turn_text(turn(new_state(), UNDERSTEER_MID), "already at minimum ride height")
    st = turn(st, {"type": "reset"})
    assert st["problems"] == [] and st["limits"] == [{"row": "ride_height", "axle": None, "want": "lower"}]
    st = turn(st, {"type": "forget_limit", "limit": {"row": "ride_height", "axle": None, "want": "lower"}})
    assert st["limits"] == []


def test_labels_and_levers():
    assert limit_label({"row": "wing", "axle": None, "want": "more downforce"}) == "Rear wing at maximum downforce"
    assert already_label({"row": "ride_height", "axle": None, "want": "lower"}) == "Already at minimum ride height"
    assert already_label({"row": "camber", "axle": "front", "want": "more negative"}) == (
        "Front camber already at the limit")
    # the car's adjustments only: no TC or ABS, but pressures are in
    assert "tc_more" not in BY_KEY and "abs_more" not in BY_KEY and "pressure_front_lower" in BY_KEY


# ---------- the API ----------

def test_chat_api_remembers_limits_per_event(client):
    event = client.post("/events", json={"name": "Spa weekend"}).json()
    run = client.post("/sessions", json={"name": "FP1", "event_id": event["id"]}).json()
    r = client.get(f"/setup/chat?event_id={event['id']}").json()
    assert r["session_id"] == run["id"] and r["runs"][0]["name"] == "FP1" and r["messages"] == []
    assert r["quick_replies"][0]["label"] == "Understeer on entry"

    r = client.post("/setup/chat", json={"event_id": event["id"], "text": "understeer mid-corner in T6"}).json()
    assert r["current"]["lever"] == "arb_front_softer"
    assert r["messages"][-1]["from"] == "tool"
    r = client.post("/setup/chat", json={"event_id": event["id"], "action": r["quick_replies"][0]["action"],
                                         "said": r["quick_replies"][0]["label"]}).json()
    assert r["limit_labels"][0]["label"] == "Front anti-roll bar on its softest position"
    assert r["messages"][-2] == {**r["messages"][-2], "from": "you", "text": "Already on the softest front bar"}
    assert r["current"]["lever"] != "arb_front_softer"

    again = client.get(f"/setup/chat?event_id={event['id']}").json()
    assert again["limits"] == r["limits"] and len(again["messages"]) == 4
    other = client.post("/events", json={"name": "Monza"}).json()
    assert client.get(f"/setup/chat?event_id={other['id']}").json()["limits"] == []

    r = client.post("/setup/chat", json={"event_id": event["id"], "variant": "non_evo"}).json()
    assert r["variant"] == "non_evo" and r["variant_label"].startswith("M4 GT4 (G82")
    assert client.post("/setup/chat", json={"event_id": event["id"], "variant": "gt3"}).status_code == 422
    assert client.get("/setup/chat?event_id=99999").status_code == 404


def test_evidence_counts_the_same_change_in_the_log():
    from app.setup.chat import MINUS, evidence
    lever = BY_KEY["arb_front_softer"]
    past = [
        {"event": "Spa", "run": "FP2", "changes": [{"row": "arb", "at": "front", "from": 3, "to": 2}],
         "deltas": {"best_s": -0.2, "balance": {"mid": -0.3}}},
        {"event": "Monza", "run": "FP1", "changes": [{"row": "arb", "at": "front", "from": 2, "to": 3}],
         "deltas": {"best_s": 0.1, "balance": {"mid": 0.2}}},  # the other way: not counted
        {"event": "Monza", "run": "Q1", "changes": [{"row": "arb", "at": "rear", "from": 3, "to": 2}],
         "deltas": None},  # the other axle
    ]
    e = evidence(lever, past, [{"kind": "understeer", "phase": "mid"}])
    assert e["times"] == 1
    assert "FP2 at Spa" in e["text"] and f"{MINUS}0.20 s" in e["text"] and "1 of 1" in e["text"]
    assert evidence(lever, [], [])["times"] == 0


def test_chat_api_reads_the_logged_changes(client):
    event = client.post("/events", json={"name": "Spa weekend"}).json()
    a, b = (client.post("/sessions", json={"name": n, "event_id": event["id"]}).json() for n in ("FP1", "FP2"))
    client.put(f"/sessions/{a['id']}/setup", json={"values": {"arb_front": 3, "arb_rear": 2}})
    client.put(f"/sessions/{b['id']}/setup", json={"values": {"arb_front": 2, "arb_rear": 2}})
    r = client.post("/setup/chat", json={"event_id": event["id"], "session_id": b["id"], "set_session": True,
                                         "text": "understeer mid-corner"}).json()
    assert r["current"]["lever"] == "arb_front_softer"
    assert r["current"]["changes"] == ["Anti-roll bar front 2 → 1"]  # from FP2's sheet
    assert r["current"]["history"]["times"] == 1 and "FP2 at Spa weekend" in r["current"]["history"]["text"]


def test_problems_after_an_answer():
    from app.setup.chat import problems_after
    st = {**new_state(), "problems": [{"kind": "understeer", "phase": "mid"}]}
    assert problems_after(st, action={"type": "reset"}) == []
    assert [p["kind"] for p in problems_after(st, text="and oversteer on exit")] == ["understeer", "oversteer"]
    assert problems_after(st, action={"type": "skip"}) == st["problems"]
