"""Tests for /stats/youtube/* endpoints."""
import time
from tests.conftest import insert_youtube_heartbeat


def test_youtube_users_empty(client, auth_headers):
    res = client.get("/stats/youtube/users", headers=auth_headers)
    assert res.json() == {"users": []}


def test_youtube_users_lists_accounts(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 100, channel="a", youtube_user="user_a")
    insert_youtube_heartbeat(db, ts=now - 50,  channel="b", youtube_user="user_a")
    insert_youtube_heartbeat(db, ts=now - 200, channel="c", youtube_user="user_b")
    db.commit()
    res = client.get("/stats/youtube/users", headers=auth_headers)
    users = {u["user"] for u in res.json()["users"]}
    assert users == {"user_a", "user_b"}


def test_youtube_stats_today_counts_seconds(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 30, channel="mkbhd")
    insert_youtube_heartbeat(db, ts=now - 60, channel="mkbhd")
    db.commit()
    res = client.get("/stats/youtube/today", headers=auth_headers)
    data = res.json()
    assert data["channels"][0]["channel"] == "mkbhd"
    assert data["channels"][0]["seconds"] == 120


def test_youtube_stats_today_user_filter(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", youtube_user="user_a")
    insert_youtube_heartbeat(db, ts=now - 20, channel="b", youtube_user="user_b")
    db.commit()
    res = client.get("/stats/youtube/today?user=user_a", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert channels == ["a"]


def test_youtube_stats_week_excludes_old(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 3 * 86400, channel="recent")
    insert_youtube_heartbeat(db, ts=now - 10 * 86400, channel="old")
    db.commit()
    res = client.get("/stats/youtube/week", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert "recent" in channels
    assert "old" not in channels


def test_youtube_stats_month_excludes_old(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 15 * 86400, channel="recent")
    insert_youtube_heartbeat(db, ts=now - 45 * 86400, channel="old")
    db.commit()
    res = client.get("/stats/youtube/month", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert "recent" in channels
    assert "old" not in channels


def test_youtube_stats_all_includes_old(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 365 * 86400, channel="ancient")
    db.commit()
    res = client.get("/stats/youtube/all", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert "ancient" in channels


def test_youtube_playlists_groups_by_playlist_id(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", playlist_id="PLabc")
    insert_youtube_heartbeat(db, ts=now - 20, channel="b", playlist_id="PLabc")
    insert_youtube_heartbeat(db, ts=now - 30, channel="c", playlist_id="PLxyz")
    insert_youtube_heartbeat(db, ts=now - 40, channel="d")  # no playlist
    db.commit()
    res = client.get("/stats/youtube/playlists?window=today", headers=auth_headers)
    playlists = {p["playlist_id"]: p["seconds"] for p in res.json()["playlists"]}
    assert playlists["PLabc"] == 120
    assert playlists["PLxyz"] == 60
    assert None not in playlists


def test_youtube_playlists_exclude_passive(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", playlist_id="PLabc", state="active")
    insert_youtube_heartbeat(db, ts=now - 20, channel="b", playlist_id="PLabc", state="passive")
    db.commit()
    res = client.get(
        "/stats/youtube/playlists?window=today&include_passive=false",
        headers=auth_headers,
    )
    playlists = {p["playlist_id"]: p["seconds"] for p in res.json()["playlists"]}
    assert playlists["PLabc"] == 60


def test_youtube_stats_today_exclude_passive(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", state="active")
    insert_youtube_heartbeat(db, ts=now - 20, channel="a", state="passive")
    db.commit()
    res = client.get("/stats/youtube/today?include_passive=false", headers=auth_headers)
    data = res.json()
    assert data["channels"][0]["channel"] == "a"
    assert data["channels"][0]["seconds"] == 60  # only the active heartbeat


def test_youtube_stats_requires_auth(client):
    for path in [
        "/stats/youtube/users",
        "/stats/youtube/today",
        "/stats/youtube/week",
        "/stats/youtube/month",
        "/stats/youtube/all",
        "/stats/youtube/playlists",
    ]:
        assert client.get(path).status_code == 401
