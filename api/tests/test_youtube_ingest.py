"""Tests for POST /youtube/heartbeats."""
import sqlite3
import time
from tests.conftest import DB_PATH


def _payload(**overrides):
    base = {
        "ts": int(time.time()),
        "channel": "mkbhd",
        "state": "active",
        "tab_visible": True,
        "client_id": "test-client",
    }
    base.update(overrides)
    return base


def test_youtube_batch_stores_heartbeats(client, auth_headers):
    batch = {"heartbeats": [
        _payload(channel="mkbhd", youtube_user="me"),
        _payload(channel="linus", state="passive"),
    ]}
    res = client.post("/youtube/heartbeats", json=batch, headers=auth_headers)
    assert res.status_code == 200
    assert res.json() == {"ok": True, "stored": 2}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT channel, youtube_user FROM youtube_heartbeats ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    assert [(r["channel"], r["youtube_user"]) for r in rows] == [
        ("mkbhd", "me"), ("linus", None),
    ]


def test_youtube_batch_without_optional_fields(client, auth_headers):
    batch = {"heartbeats": [_payload()]}
    res = client.post("/youtube/heartbeats", json=batch, headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["stored"] == 1


def test_youtube_batch_stores_playlist_id(client, auth_headers):
    batch = {"heartbeats": [_payload(playlist_id="PLabc123")]}
    client.post("/youtube/heartbeats", json=batch, headers=auth_headers)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT playlist_id FROM youtube_heartbeats ORDER BY id DESC LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    assert row["playlist_id"] == "PLabc123"


def test_youtube_batch_requires_auth(client):
    res = client.post("/youtube/heartbeats", json={"heartbeats": [_payload()]})
    assert res.status_code == 401


def test_youtube_batch_channel_lowercased(client, auth_headers):
    batch = {"heartbeats": [_payload(channel="MKBHD")]}
    client.post("/youtube/heartbeats", json=batch, headers=auth_headers)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT channel FROM youtube_heartbeats ORDER BY id DESC LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    assert row["channel"] == "mkbhd"
