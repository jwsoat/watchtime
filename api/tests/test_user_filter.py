"""
?user= filter semantics across stats endpoints:
- omitted: all heartbeats pooled
- user=<login>: only heartbeats with twitch_user=<login>
- user=anonymous: only heartbeats with twitch_user IS NULL
"""
import time
from tests.conftest import insert_heartbeat


def _seed(db):
    now = int(time.time())
    # Two heartbeats today, different users
    insert_heartbeat(db, ts=now - 100, channel="alice", twitch_user="user_a")
    insert_heartbeat(db, ts=now - 200, channel="alice", twitch_user="user_a")
    insert_heartbeat(db, ts=now - 300, channel="bob", twitch_user="user_b")
    insert_heartbeat(db, ts=now - 400, channel="carol", twitch_user=None)
    db.commit()


def test_today_no_filter_returns_all_users(client, auth_headers, db):
    _seed(db)
    res = client.get("/stats/today", headers=auth_headers)
    channels = {c["channel"] for c in res.json()["channels"]}
    assert channels == {"alice", "bob", "carol"}


def test_today_user_filter_returns_only_that_user(client, auth_headers, db):
    _seed(db)
    res = client.get("/stats/today?user=user_a", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert channels == ["alice"]
    assert res.json()["channels"][0]["seconds"] == 120  # 2 heartbeats * 60


def test_today_user_anonymous_returns_only_null(client, auth_headers, db):
    _seed(db)
    res = client.get("/stats/today?user=anonymous", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert channels == ["carol"]


def test_week_user_filter(client, auth_headers, db):
    _seed(db)
    res = client.get("/stats/week?user=user_b", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert channels == ["bob"]


def test_all_user_filter(client, auth_headers, db):
    _seed(db)
    res = client.get("/stats/all?user=user_a", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert channels == ["alice"]


def test_daily_user_filter(client, auth_headers, db):
    _seed(db)
    res = client.get("/stats/daily?user=user_a&days=2", headers=auth_headers)
    data = res.json()
    total = sum(d["seconds"] for d in data["days"])
    assert total == 120  # only user_a's 2 heartbeats counted
