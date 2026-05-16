"""
Heartbeats may carry an optional twitch_user. POSTing without the field
must still succeed (back-compat). With the field, it must round-trip to DB.
"""
import sqlite3
import time
from tests.conftest import DB_PATH


def _last_row():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM heartbeats ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        conn.close()


def _payload(**overrides):
    base = {
        "ts": int(time.time()),
        "channel": "alice",
        "category": "Just Chatting",
        "title": "stream title",
        "state": "active",
        "tab_visible": True,
        "client_id": "test-client",
    }
    base.update(overrides)
    return base


def test_heartbeat_without_twitch_user_stores_null(client, auth_headers):
    res = client.post("/heartbeat", json=_payload(), headers=auth_headers)
    assert res.status_code == 200
    row = _last_row()
    assert row["twitch_user"] is None


def test_heartbeat_with_twitch_user_stores_value(client, auth_headers):
    res = client.post("/heartbeat", json=_payload(twitch_user="jwsoat"), headers=auth_headers)
    assert res.status_code == 200
    row = _last_row()
    assert row["twitch_user"] == "jwsoat"


def test_heartbeats_batch_with_twitch_user(client, auth_headers):
    batch = {"heartbeats": [
        _payload(channel="alice", twitch_user="user_a"),
        _payload(channel="bob", twitch_user="user_b"),
        _payload(channel="carol"),
    ]}
    res = client.post("/heartbeats", json=batch, headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["stored"] == 3

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT channel, twitch_user FROM heartbeats ORDER BY id").fetchall()
    finally:
        conn.close()
    assert [(r["channel"], r["twitch_user"]) for r in rows] == [
        ("alice", "user_a"), ("bob", "user_b"), ("carol", None),
    ]
