"""Tests for cross-platform creator linking and the merged rollup:
/settings/creator-links CRUD and /stats/merged/*."""
import time

from tests.conftest import (
    insert_heartbeat,
    insert_youtube_heartbeat,
    insert_media_heartbeat,
)


# ---------- creator-links CRUD ----------

def test_creator_link_create_and_list(client, auth_headers):
    r1 = client.post("/settings/creator-links",
                     json={"label": "MrBeast", "platform": "youtube", "channel": "MrBeast"},
                     headers=auth_headers)
    assert r1.status_code == 200
    gid = r1.json()["group_id"]
    r2 = client.post("/settings/creator-links",
                     json={"label": "MrBeast", "platform": "plex", "channel": "mrbeast"},
                     headers=auth_headers)
    assert r2.json()["group_id"] == gid  # same group, by label

    groups = client.get("/settings/creator-links", headers=auth_headers).json()["groups"]
    assert len(groups) == 1
    members = {(m["platform"], m["channel"]) for m in groups[0]["members"]}
    assert members == {("youtube", "mrbeast"), ("plex", "mrbeast")}


def test_creator_link_channel_unique(client, auth_headers):
    client.post("/settings/creator-links",
                json={"label": "A", "platform": "youtube", "channel": "chan"},
                headers=auth_headers)
    dup = client.post("/settings/creator-links",
                      json={"label": "B", "platform": "youtube", "channel": "chan"},
                      headers=auth_headers)
    assert dup.status_code == 409


def test_creator_link_rejects_bad_platform(client, auth_headers):
    res = client.post("/settings/creator-links",
                      json={"label": "A", "platform": "tiktok", "channel": "x"},
                      headers=auth_headers)
    assert res.status_code == 422


def test_creator_alias_delete_removes_empty_group(client, auth_headers):
    r = client.post("/settings/creator-links",
                    json={"label": "Solo", "platform": "x", "channel": "solo"},
                    headers=auth_headers)
    alias_id = r.json()["alias_id"]
    client.delete(f"/settings/creator-links/alias/{alias_id}", headers=auth_headers)
    assert client.get("/settings/creator-links", headers=auth_headers).json()["groups"] == []


def test_creator_group_delete(client, auth_headers):
    r = client.post("/settings/creator-links",
                    json={"label": "G", "platform": "x", "channel": "a"},
                    headers=auth_headers)
    gid = r.json()["group_id"]
    assert client.delete(f"/settings/creator-links/group/{gid}", headers=auth_headers).status_code == 200
    assert client.get("/settings/creator-links", headers=auth_headers).json()["groups"] == []


def test_creator_links_require_auth(client):
    assert client.get("/settings/creator-links").status_code == 401
    assert client.post("/settings/creator-links", json={}).status_code == 401


# ---------- merged rollup ----------

def test_merged_channels_rolls_up_linked_creator(client, auth_headers, db):
    now = int(time.time())
    # Same creator on YouTube and Plex.
    insert_youtube_heartbeat(db, ts=now - 10, channel="mrbeast")
    insert_youtube_heartbeat(db, ts=now - 20, channel="mrbeast")
    insert_media_heartbeat(db, ts=now - 30, platform="plex", channel="mrbeast")
    db.commit()

    client.post("/settings/creator-links",
                json={"label": "MrBeast", "platform": "youtube", "channel": "mrbeast"},
                headers=auth_headers)
    client.post("/settings/creator-links",
                json={"label": "MrBeast", "platform": "plex", "channel": "mrbeast"},
                headers=auth_headers)

    data = client.get("/stats/merged/channels?window=today", headers=auth_headers).json()
    assert len(data["rows"]) == 1
    row = data["rows"][0]
    assert row["label"] == "MrBeast"
    assert row["seconds"] == 180   # 2 YT + 1 Plex heartbeats * 60? -> uses interval
    assert set(row["platforms"]) == {"youtube", "plex"}
    assert data["total_seconds"] == 180


def test_merged_channels_unlinked_are_separate(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 10, channel="xqc")
    insert_youtube_heartbeat(db, ts=now - 20, channel="mkbhd")
    insert_media_heartbeat(db, ts=now - 30, platform="instagram", channel="natgeo")
    db.commit()
    rows = client.get("/stats/merged/channels?window=today", headers=auth_headers).json()["rows"]
    labels = {r["label"] for r in rows}
    assert labels == {"xqc", "mkbhd", "natgeo"}
    for r in rows:
        assert len(r["platforms"]) == 1


def test_merged_channels_sorted_desc(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 10, channel="small")
    insert_youtube_heartbeat(db, ts=now - 10, channel="big")
    insert_youtube_heartbeat(db, ts=now - 20, channel="big")
    db.commit()
    rows = client.get("/stats/merged/channels?window=today", headers=auth_headers).json()["rows"]
    assert [r["label"] for r in rows] == ["big", "small"]


def test_merged_channels_window_filters(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10 * 86400, channel="old")
    insert_youtube_heartbeat(db, ts=now - 1 * 86400, channel="recent")
    db.commit()
    labels = {r["label"] for r in
              client.get("/stats/merged/channels?window=week", headers=auth_headers).json()["rows"]}
    assert labels == {"recent"}


def test_merged_daily_combines_platforms(client, auth_headers, db):
    now = int(time.time())
    insert_heartbeat(db, ts=now - 100, channel="a")
    insert_youtube_heartbeat(db, ts=now - 110, channel="b")
    insert_media_heartbeat(db, ts=now - 120, platform="plex", channel="c")
    db.commit()
    days = client.get("/stats/merged/daily?days=2", headers=auth_headers).json()["days"]
    total = sum(d["seconds"] for d in days)
    assert total == 180  # 3 heartbeats across 3 platforms today


def test_merged_requires_auth(client):
    assert client.get("/stats/merged/channels").status_code == 401
    assert client.get("/stats/merged/daily").status_code == 401


# ---------- migration from legacy channel_links ----------

def test_channel_links_migrated_into_creator_groups(client, auth_headers, db):
    # Seed a legacy channel_links row, then trigger the idempotent migration.
    db.execute(
        "INSERT INTO channel_links (twitch_channel, youtube_channel) VALUES (?, ?)",
        ("ninja", "ninjayt"),
    )
    db.commit()

    import main
    import sqlite3
    conn = sqlite3.connect(main.DB_PATH)
    try:
        main._migrate_channel_links_to_creators(conn)
        conn.commit()
    finally:
        conn.close()

    groups = client.get("/settings/creator-links", headers=auth_headers).json()["groups"]
    assert len(groups) == 1
    members = {(m["platform"], m["channel"]) for m in groups[0]["members"]}
    assert members == {("twitch", "ninja"), ("youtube", "ninjayt")}

    # Re-running must not duplicate.
    conn = sqlite3.connect(main.DB_PATH)
    try:
        main._migrate_channel_links_to_creators(conn)
        conn.commit()
    finally:
        conn.close()
    groups = client.get("/settings/creator-links", headers=auth_headers).json()["groups"]
    assert len(groups) == 1
    assert len(groups[0]["members"]) == 2
