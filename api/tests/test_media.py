"""Tests for the generic media sources (x, facebook, instagram, plex):
ingest via /media/heartbeats and stats via /stats/media/{platform}/*."""
import time

from tests.conftest import insert_media_heartbeat


# ---------- ingest ----------

def test_media_ingest_stores_rows(client, auth_headers, db):
    now = int(time.time())
    body = {
        "heartbeats": [
            {
                "ts": now, "platform": "x", "channel": "NASA",
                "title": "Launch stream", "video_id": "1790",
                "state": "active", "tab_visible": True,
                "client_id": "c1", "media_user": "Me",
            }
        ]
    }
    res = client.post("/media/heartbeats", json=body, headers=auth_headers)
    assert res.status_code == 200
    assert res.json() == {"ok": True, "stored": 1}

    row = db.execute("SELECT * FROM media_heartbeats").fetchone()
    assert row["platform"] == "x"
    assert row["channel"] == "nasa"        # lowercased
    assert row["media_user"] == "me"       # lowercased


def test_media_ingest_rejects_unknown_platform(client, auth_headers):
    now = int(time.time())
    body = {"heartbeats": [{
        "ts": now, "platform": "tiktok", "channel": "a",
        "state": "active", "tab_visible": True, "client_id": "c1",
    }]}
    res = client.post("/media/heartbeats", json=body, headers=auth_headers)
    assert res.status_code == 422


def test_media_ingest_requires_auth(client):
    assert client.post("/media/heartbeats", json={"heartbeats": []}).status_code == 401


# ---------- stats ----------

def test_media_today_counts_seconds_per_platform(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 10, platform="x", channel="nasa")
    insert_media_heartbeat(db, ts=now - 20, platform="x", channel="nasa")
    insert_media_heartbeat(db, ts=now - 30, platform="instagram", channel="natgeo")
    db.commit()

    res = client.get("/stats/media/x/today", headers=auth_headers)
    data = res.json()
    assert data["channels"][0]["channel"] == "nasa"
    assert data["channels"][0]["seconds"] == 120
    # instagram heartbeat must not leak into x
    assert all(c["channel"] != "natgeo" for c in data["channels"])


def test_media_platforms_are_isolated(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 10, platform="facebook", channel="fb")
    db.commit()
    assert client.get("/stats/media/instagram/today", headers=auth_headers).json()["channels"] == []
    assert client.get("/stats/media/facebook/today", headers=auth_headers).json()["channels"][0]["channel"] == "fb"


def test_media_unknown_platform_404(client, auth_headers):
    assert client.get("/stats/media/tiktok/today", headers=auth_headers).status_code == 404


def test_media_user_filter(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 10, platform="x", channel="a", media_user="me")
    insert_media_heartbeat(db, ts=now - 20, platform="x", channel="b", media_user="them")
    db.commit()
    res = client.get("/stats/media/x/today?user=me", headers=auth_headers)
    assert [c["channel"] for c in res.json()["channels"]] == ["a"]


def test_media_exclude_passive(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 10, platform="x", channel="a", state="active")
    insert_media_heartbeat(db, ts=now - 20, platform="x", channel="a", state="passive")
    db.commit()
    res = client.get("/stats/media/x/today?include_passive=false", headers=auth_headers)
    assert res.json()["channels"][0]["seconds"] == 60


def test_media_week_excludes_old(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 3 * 86400, platform="x", channel="recent")
    insert_media_heartbeat(db, ts=now - 10 * 86400, platform="x", channel="old")
    db.commit()
    channels = [c["channel"] for c in client.get("/stats/media/x/week", headers=auth_headers).json()["channels"]]
    assert "recent" in channels and "old" not in channels


def test_media_users_lists_accounts(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 10, platform="plex", channel="show", media_user="alice")
    insert_media_heartbeat(db, ts=now - 20, platform="plex", channel="show", media_user="bob")
    db.commit()
    users = {u["user"] for u in client.get("/stats/media/plex/users", headers=auth_headers).json()["users"]}
    assert users == {"alice", "bob"}


def test_media_videos_top_titles(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 10, platform="instagram", channel="a", title="Reel 1")
    insert_media_heartbeat(db, ts=now - 20, platform="instagram", channel="a", title="Reel 1")
    insert_media_heartbeat(db, ts=now - 30, platform="instagram", channel="b", title="Reel 2")
    db.commit()
    videos = client.get("/stats/media/instagram/videos?window=today", headers=auth_headers).json()["videos"]
    assert videos[0]["title"] == "Reel 1"
    assert videos[0]["seconds"] == 120


def test_media_now_returns_recent_active(client, auth_headers, db):
    now = int(time.time())
    insert_media_heartbeat(db, ts=now - 5, platform="x", channel="live", title="t", state="active")
    db.commit()
    data = client.get("/stats/media/x/now", headers=auth_headers).json()
    assert data["channel"] == "live"


def test_media_stats_requires_auth(client):
    for path in [
        "/stats/media/x/today",
        "/stats/media/x/users",
        "/stats/media/x/videos",
        "/stats/media/x/now",
    ]:
        assert client.get(path).status_code == 401


# ---------- plex poller ----------

def test_plex_rows_from_sessions_maps_fields():
    import plex_poller
    payload = {"MediaContainer": {"Metadata": [
        {
            "type": "episode", "title": "Pilot", "grandparentTitle": "The Show",
            "ratingKey": 42, "User": {"title": "Alice"}, "Player": {"state": "playing"},
        },
        {  # music track is skipped
            "type": "track", "title": "Song", "Player": {"state": "playing"},
        },
        {  # paused movie -> passive
            "type": "movie", "title": "A Film", "ratingKey": 7,
            "User": {"title": "Bob"}, "Player": {"state": "paused"},
        },
    ]}}
    rows = plex_poller._rows_from_sessions(payload, now=1000)
    assert len(rows) == 2
    ep = rows[0]
    # (ts, platform, channel, title, video_id, state, tab_visible, media_user, client_id)
    assert ep[1] == "plex"
    assert ep[2] == "the show"
    assert ep[3] == "Pilot"
    assert ep[5] == "active"
    assert ep[7] == "alice"
    assert rows[1][2] == "a film"   # movie falls back to its own title
    assert rows[1][5] == "passive"


def test_plex_channel_from_studio_when_enabled():
    import plex_poller
    payload = {"MediaContainer": {"Metadata": [
        {"type": "movie", "title": "Some Upload", "studio": "MrBeast",
         "ratingKey": 1, "User": {"title": "Me"}, "Player": {"state": "playing"}},
        {"type": "movie", "title": "No Studio Vid", "grandparentTitle": "Archive",
         "ratingKey": 2, "User": {"title": "Me"}, "Player": {"state": "playing"}},
    ]}}
    rows = plex_poller._rows_from_sessions(payload, now=1000, channel_from_studio=True)
    # studio used when present, lowercased
    assert rows[0][2] == "mrbeast"
    # falls back to grandparentTitle/title when studio is missing
    assert rows[1][2] == "archive"


def test_plex_studio_ignored_by_default():
    import plex_poller
    payload = {"MediaContainer": {"Metadata": [
        {"type": "movie", "title": "Some Upload", "studio": "MrBeast",
         "ratingKey": 1, "User": {"title": "Me"}, "Player": {"state": "playing"}},
    ]}}
    rows = plex_poller._rows_from_sessions(payload, now=1000)
    assert rows[0][2] == "some upload"  # title, studio ignored


def test_plex_channel_from_studio_env(monkeypatch):
    import plex_poller
    monkeypatch.setenv("PLEX_CHANNEL_FROM_STUDIO", "true")
    assert plex_poller._channel_from_studio() is True
    monkeypatch.setenv("PLEX_CHANNEL_FROM_STUDIO", "0")
    assert plex_poller._channel_from_studio() is False
    monkeypatch.delenv("PLEX_CHANNEL_FROM_STUDIO", raising=False)
    assert plex_poller._channel_from_studio() is False


def test_plex_not_configured_by_default(monkeypatch):
    import plex_poller
    monkeypatch.delenv("PLEX_BASE_URL", raising=False)
    monkeypatch.delenv("PLEX_TOKEN", raising=False)
    assert plex_poller.is_configured() is False
    assert plex_poller.start("/tmp/whatever.db", 10) is False
