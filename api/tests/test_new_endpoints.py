"""Tests for /stats/now, /stats/users, /stats/categories, /stats/recent."""
import time
from tests.conftest import insert_heartbeat


# ---------- /stats/now ----------

def test_now_returns_null_when_no_recent_heartbeat(client, auth_headers, db):
    insert_heartbeat(db, ts=int(time.time()) - 600, channel="alice")  # 10 min ago
    db.commit()
    res = client.get("/stats/now", headers=auth_headers)
    assert res.json() == {"now": None}


def test_now_returns_most_recent_within_120s(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 30, channel="alice", category="cat", title="t", twitch_user="user_a")
    db.commit()
    res = client.get("/stats/now", headers=auth_headers)
    data = res.json()
    assert data["channel"] == "alice"
    assert data["category"] == "cat"
    assert data["title"] == "t"
    assert data["twitch_user"] == "user_a"
    assert data["ts"] == now - 30


def test_now_user_filter(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 30, channel="alice", twitch_user="user_a")
    insert_heartbeat(db, ts=now - 20, channel="bob", twitch_user="user_b")  # more recent
    db.commit()
    res = client.get("/stats/now?user=user_a", headers=auth_headers)
    assert res.json()["channel"] == "alice"


# ---------- /stats/users ----------

def test_users_returns_empty_when_no_data(client, auth_headers):
    res = client.get("/stats/users", headers=auth_headers)
    assert res.json() == {"users": []}


def test_users_lists_distinct_users_with_metadata(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 100, channel="x", twitch_user="user_a")
    insert_heartbeat(db, ts=now - 50, channel="x", twitch_user="user_a")
    insert_heartbeat(db, ts=now - 200, channel="x", twitch_user="user_b")
    insert_heartbeat(db, ts=now - 10, channel="x", twitch_user=None)
    db.commit()
    res = client.get("/stats/users", headers=auth_headers)
    users = {u["user"]: u for u in res.json()["users"]}
    assert set(users) == {"user_a", "user_b", "anonymous"}
    assert users["user_a"]["count"] == 2
    assert users["user_a"]["last_ts"] == now - 50
    assert users["user_b"]["count"] == 1
    assert users["anonymous"]["count"] == 1


def test_users_ordered_by_last_activity_desc(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 300, channel="x", twitch_user="user_old")
    insert_heartbeat(db, ts=now - 10, channel="x", twitch_user="user_new")
    db.commit()
    res = client.get("/stats/users", headers=auth_headers)
    logins = [u["user"] for u in res.json()["users"]]
    assert logins == ["user_new", "user_old"]
