"""Home Assistant media_player → YouTube heartbeat mapping."""
import sqlite3

import pytest

import home_assistant_poller
from tests.conftest import DB_PATH


@pytest.fixture(autouse=True)
def _reset_ha_config():
    """Config lives outside the shared _clean_youtube_data fixture, so reset
    it here between tests. The entity_users table is wiped then re-seeded
    with the baked-in defaults so both defaults and mapping tests are
    deterministic no matter which test ran previously."""
    import main
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "UPDATE home_assistant_config SET base_url = NULL, token = NULL WHERE id = 1"
        )
        conn.execute("DELETE FROM home_assistant_entity_users")
        main._seed_default_ha_entity_users(conn)
        conn.commit()
    finally:
        conn.close()
    yield


def _states(*extra_entities):
    """Return a /api/states-shaped list including a dummy non-media entity."""
    return [{"entity_id": "sensor.dummy", "state": "on"}, *extra_entities]


def test_youtube_media_player_becomes_youtube_heartbeat():
    payload = _states({
        "entity_id": "media_player.living_room",
        "state": "playing",
        "attributes": {
            "app_name": "YouTube",
            "media_artist": "MrBeast",
            "media_title": "I gave $1M away",
            "media_content_id": "abcdefghijk",  # 11-char id
        },
    })
    rows = home_assistant_poller._rows_from_states(payload, now=1000)
    assert len(rows) == 1
    (ts, channel, title, video_id, playlist_id, state, tab_visible,
     yt_user, client_id) = rows[0]
    assert ts == 1000
    assert channel == "mrbeast"
    assert title == "I gave $1M away"
    assert video_id == "abcdefghijk"
    assert playlist_id is None
    assert state == "active"
    assert tab_visible == 1
    assert yt_user is None
    assert client_id == "ha:media_player.living_room"


def test_non_youtube_apps_are_ignored():
    payload = _states(
        {
            "entity_id": "media_player.tv",
            "state": "playing",
            "attributes": {
                "app_name": "Netflix",
                "media_artist": "Netflix Show",
                "media_title": "Some Episode",
            },
        },
        {
            "entity_id": "media_player.speaker",
            "state": "playing",
            "attributes": {
                "app_name": "Spotify",
                "media_artist": "An Artist",
                "media_title": "A Song",
            },
        },
    )
    assert home_assistant_poller._rows_from_states(payload, now=1000) == []


def test_paused_youtube_is_passive():
    payload = _states({
        "entity_id": "media_player.tv",
        "state": "paused",
        "attributes": {
            "app_name": "youtube",
            "media_artist": "Ludwig",
            "media_title": "Chess talk",
        },
    })
    rows = home_assistant_poller._rows_from_states(payload, now=42)
    assert rows[0][5] == "passive"


def test_missing_channel_or_title_is_skipped():
    payload = _states(
        {
            "entity_id": "media_player.tv",
            "state": "playing",
            "attributes": {"app_name": "youtube", "media_title": "titleonly"},
        },
        {
            "entity_id": "media_player.tv2",
            "state": "playing",
            "attributes": {"app_name": "youtube", "media_artist": "artistonly"},
        },
    )
    assert home_assistant_poller._rows_from_states(payload, now=1) == []


def test_media_channel_falls_back_when_artist_missing():
    payload = _states({
        "entity_id": "media_player.cast",
        "state": "playing",
        "attributes": {
            "app_name": "youtube",
            "media_channel": "Cast Channel",
            "media_title": "video",
        },
    })
    rows = home_assistant_poller._rows_from_states(payload, now=1)
    assert rows[0][1] == "cast channel"


def test_content_id_dropped_when_not_video_id_shaped():
    payload = _states({
        "entity_id": "media_player.tv",
        "state": "playing",
        "attributes": {
            "app_name": "youtube",
            "media_artist": "chan",
            "media_title": "vid",
            "media_content_id": "https://www.youtube.com/watch?v=abcdefghijk",
        },
    })
    rows = home_assistant_poller._rows_from_states(payload, now=1)
    assert rows[0][3] is None


def test_non_media_player_entities_ignored():
    payload = _states(
        {"entity_id": "light.kitchen", "state": "on",
         "attributes": {"app_name": "youtube", "media_artist": "x", "media_title": "y"}},
    )
    assert home_assistant_poller._rows_from_states(payload, now=1) == []


def test_read_config_returns_none_when_unset(db):
    db.execute("UPDATE home_assistant_config SET base_url = NULL, token = NULL WHERE id = 1")
    db.commit()
    assert home_assistant_poller._read_config(DB_PATH) == (None, None)


def test_settings_get_masks_token(client, auth_headers, db):
    db.execute(
        "UPDATE home_assistant_config SET base_url = ?, token = ? WHERE id = 1",
        ("http://ha.local:8123", "sekret"),
    )
    db.commit()
    res = client.get("/settings/home-assistant", headers=auth_headers)
    body = res.json()
    assert body["base_url"] == "http://ha.local:8123"
    assert body["has_token"] is True
    assert body["configured"] is True
    assert "token" not in body


def test_settings_put_preserves_token_when_blank(client, auth_headers, db):
    db.execute(
        "UPDATE home_assistant_config SET base_url = ?, token = ? WHERE id = 1",
        ("http://old:8123", "old-token"),
    )
    db.commit()
    res = client.put(
        "/settings/home-assistant",
        headers=auth_headers,
        json={"base_url": "http://new:8123", "token": ""},
    )
    assert res.status_code == 200
    row = sqlite3.connect(DB_PATH).execute(
        "SELECT base_url, token FROM home_assistant_config WHERE id = 1"
    ).fetchone()
    assert row == ("http://new:8123", "old-token")


def test_settings_put_updates_token_when_provided(client, auth_headers, db):
    db.execute(
        "UPDATE home_assistant_config SET base_url = ?, token = ? WHERE id = 1",
        ("http://old:8123", "old-token"),
    )
    db.commit()
    res = client.put(
        "/settings/home-assistant",
        headers=auth_headers,
        json={"base_url": "http://new:8123/", "token": "new-token"},
    )
    assert res.status_code == 200
    row = sqlite3.connect(DB_PATH).execute(
        "SELECT base_url, token FROM home_assistant_config WHERE id = 1"
    ).fetchone()
    # trailing slash is stripped, token updated
    assert row == ("http://new:8123", "new-token")


def test_settings_delete_clears_config(client, auth_headers, db):
    db.execute(
        "UPDATE home_assistant_config SET base_url = ?, token = ? WHERE id = 1",
        ("http://ha:8123", "tok"),
    )
    db.commit()
    res = client.delete("/settings/home-assistant", headers=auth_headers)
    assert res.status_code == 200
    row = sqlite3.connect(DB_PATH).execute(
        "SELECT base_url, token FROM home_assistant_config WHERE id = 1"
    ).fetchone()
    assert row == (None, None)


def test_settings_test_requires_config(client, auth_headers, db):
    db.execute("UPDATE home_assistant_config SET base_url = NULL, token = NULL WHERE id = 1")
    db.commit()
    res = client.post("/settings/home-assistant/test", headers=auth_headers)
    assert res.status_code == 400


# ---------- entity → user mapping ----------

def test_rows_populate_youtube_user_for_mapped_entity():
    payload = _states({
        "entity_id": "media_player.jwsoat_tv",
        "state": "playing",
        "attributes": {"app_name": "youtube", "media_artist": "chan", "media_title": "vid"},
    })
    rows = home_assistant_poller._rows_from_states(
        payload, now=1, entity_users={"media_player.jwsoat_tv": "jwsoat"},
    )
    assert rows[0][7] == "jwsoat"


def test_rows_leave_youtube_user_null_for_unmapped_entity():
    payload = _states({
        "entity_id": "media_player.guest_room",
        "state": "playing",
        "attributes": {"app_name": "youtube", "media_artist": "chan", "media_title": "vid"},
    })
    rows = home_assistant_poller._rows_from_states(
        payload, now=1, entity_users={"media_player.jwsoat_tv": "jwsoat"},
    )
    assert rows[0][7] is None


def test_default_seed_maps_jwsoat_tv_to_jwsoat():
    """The seeded row from _seed_default_ha_entity_users survives boot."""
    mapping = home_assistant_poller._read_entity_users(DB_PATH)
    assert mapping.get("media_player.jwsoat_tv") == "jwsoat"


def test_list_endpoint_returns_seeded_mapping(client, auth_headers):
    res = client.get("/settings/home-assistant/entity-users", headers=auth_headers)
    assert res.status_code == 200
    mappings = res.json()["mappings"]
    assert {"entity_id": "media_player.jwsoat_tv", "youtube_user": "jwsoat"} in mappings


def test_add_endpoint_upserts_mapping(client, auth_headers):
    res = client.post(
        "/settings/home-assistant/entity-users",
        headers=auth_headers,
        json={"entity_id": "media_player.bedroom", "youtube_user": "Alice"},
    )
    assert res.status_code == 200
    mapping = home_assistant_poller._read_entity_users(DB_PATH)
    # Lowercased on write so filter queries (WHERE youtube_user = ?) match.
    assert mapping["media_player.bedroom"] == "alice"

    # Second POST for the same entity overwrites, not duplicates.
    res = client.post(
        "/settings/home-assistant/entity-users",
        headers=auth_headers,
        json={"entity_id": "media_player.bedroom", "youtube_user": "bob"},
    )
    assert res.status_code == 200
    mapping = home_assistant_poller._read_entity_users(DB_PATH)
    assert mapping["media_player.bedroom"] == "bob"


def test_add_endpoint_rejects_non_media_player_entity(client, auth_headers):
    res = client.post(
        "/settings/home-assistant/entity-users",
        headers=auth_headers,
        json={"entity_id": "light.kitchen", "youtube_user": "alice"},
    )
    assert res.status_code == 422  # pattern validation


def test_delete_endpoint_removes_mapping(client, auth_headers, db):
    db.execute(
        "INSERT OR REPLACE INTO home_assistant_entity_users (entity_id, youtube_user) "
        "VALUES (?, ?)",
        ("media_player.temp", "bob"),
    )
    db.commit()
    res = client.delete(
        "/settings/home-assistant/entity-users/media_player.temp",
        headers=auth_headers,
    )
    assert res.status_code == 200
    assert "media_player.temp" not in home_assistant_poller._read_entity_users(DB_PATH)


def test_delete_endpoint_404_for_unknown(client, auth_headers):
    res = client.delete(
        "/settings/home-assistant/entity-users/media_player.nope",
        headers=auth_headers,
    )
    assert res.status_code == 404
