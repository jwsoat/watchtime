"""Tests for POST /settings/user-accounts/auto-link."""
import time
from tests.conftest import insert_heartbeat, insert_youtube_heartbeat


def test_auto_link_empty_when_no_overlap(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now, channel="x", twitch_user="alice", client_id="cid-a")
    insert_youtube_heartbeat(db, ts=now, channel="y", youtube_user="bob", client_id="cid-b")
    db.commit()
    res = client.post("/settings/user-accounts/auto-link", headers=auth_headers)
    data = res.json()
    assert data["created"] == 0
    assert data["total_pairs"] == 0


def test_auto_link_creates_pair_from_same_client(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now, channel="x", twitch_user="alice", client_id="cid-shared")
    insert_youtube_heartbeat(db, ts=now, channel="y", youtube_user="alice_yt", client_id="cid-shared")
    db.commit()
    res = client.post("/settings/user-accounts/auto-link", headers=auth_headers)
    data = res.json()
    assert data["created"] == 1
    assert data["skipped"] == 0

    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert len(accounts) == 1
    assert accounts[0]["twitch_user"] == "alice"
    assert accounts[0]["youtube_user"] == "alice_yt"
    assert accounts[0]["label"].startswith("Auto:")


def test_auto_link_is_idempotent(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now, channel="x", twitch_user="alice", client_id="cid-shared")
    insert_youtube_heartbeat(db, ts=now, channel="y", youtube_user="alice_yt", client_id="cid-shared")
    db.commit()
    client.post("/settings/user-accounts/auto-link", headers=auth_headers)
    res = client.post("/settings/user-accounts/auto-link", headers=auth_headers)
    data = res.json()
    assert data["created"] == 0
    assert data["skipped"] == 1


def test_auto_link_ignores_heartbeats_without_user(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now, channel="x", twitch_user=None, client_id="cid-shared")
    insert_youtube_heartbeat(db, ts=now, channel="y", youtube_user="alice_yt", client_id="cid-shared")
    db.commit()
    res = client.post("/settings/user-accounts/auto-link", headers=auth_headers)
    assert res.json()["created"] == 0


def test_auto_link_multiple_clients_create_multiple_pairs(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now, channel="x", twitch_user="alice", client_id="cid-1")
    insert_youtube_heartbeat(db, ts=now, channel="y", youtube_user="alice_yt", client_id="cid-1")
    insert_heartbeat(db, ts=now, channel="x", twitch_user="bob", client_id="cid-2")
    insert_youtube_heartbeat(db, ts=now, channel="y", youtube_user="bob_yt", client_id="cid-2")
    db.commit()
    res = client.post("/settings/user-accounts/auto-link", headers=auth_headers)
    assert res.json()["created"] == 2


def test_auto_link_requires_auth(client):
    assert client.post("/settings/user-accounts/auto-link").status_code == 401
