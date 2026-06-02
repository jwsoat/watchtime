"""Tests for /settings/channel-links CRUD."""


def test_get_links_empty(client, auth_headers):
    res = client.get("/settings/channel-links", headers=auth_headers)
    assert res.json() == {"links": []}


def test_add_link(client, auth_headers):
    res = client.post(
        "/settings/channel-links",
        json={"twitch_channel": "xqc", "youtube_channel": "xqcow"},
        headers=auth_headers,
    )
    assert res.status_code == 200
    assert "id" in res.json()
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert len(links) == 1
    assert links[0]["twitch_channel"] == "xqc"
    assert links[0]["youtube_channel"] == "xqcow"


def test_add_link_lowercases_channels(client, auth_headers):
    res = client.post(
        "/settings/channel-links",
        json={"twitch_channel": "XQC", "youtube_channel": "XQCow"},
        headers=auth_headers,
    )
    assert res.status_code == 200
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert links[0]["twitch_channel"] == "xqc"
    assert links[0]["youtube_channel"] == "xqcow"


def test_add_duplicate_link_is_idempotent(client, auth_headers):
    payload = {"twitch_channel": "xqc", "youtube_channel": "xqcow"}
    r1 = client.post("/settings/channel-links", json=payload, headers=auth_headers)
    r2 = client.post("/settings/channel-links", json=payload, headers=auth_headers)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"]
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert len(links) == 1


def test_delete_link(client, auth_headers):
    r = client.post(
        "/settings/channel-links",
        json={"twitch_channel": "xqc", "youtube_channel": "xqcow"},
        headers=auth_headers,
    )
    link_id = r.json()["id"]
    del_res = client.delete(f"/settings/channel-links/{link_id}", headers=auth_headers)
    assert del_res.json() == {"ok": True}
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert links == []


def test_channel_links_require_auth(client):
    assert client.get("/settings/channel-links").status_code == 401
    assert client.post(
        "/settings/channel-links",
        json={"twitch_channel": "a", "youtube_channel": "b"},
    ).status_code == 401
    assert client.delete("/settings/channel-links/1").status_code == 401


def test_delete_nonexistent_link_returns_404(client, auth_headers):
    res = client.delete("/settings/channel-links/99999", headers=auth_headers)
    assert res.status_code == 404
