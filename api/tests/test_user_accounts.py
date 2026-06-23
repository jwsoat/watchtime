"""Tests for /settings/user-accounts CRUD."""


def test_get_accounts_empty(client, auth_headers):
    res = client.get("/settings/user-accounts", headers=auth_headers)
    assert res.json() == {"accounts": []}


def test_add_account_with_both_platforms(client, auth_headers):
    res = client.post(
        "/settings/user-accounts",
        json={"label": "Me", "twitch_user": "jwsoat", "youtube_user": "JwsoatVideo"},
        headers=auth_headers,
    )
    assert res.status_code == 200
    assert "id" in res.json()
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert len(accounts) == 1
    assert accounts[0]["label"] == "Me"
    assert accounts[0]["twitch_user"] == "jwsoat"
    assert accounts[0]["youtube_user"] == "jwsoatvideo"


def test_add_account_twitch_only(client, auth_headers):
    res = client.post(
        "/settings/user-accounts",
        json={"label": "Twitch-only", "twitch_user": "alice"},
        headers=auth_headers,
    )
    assert res.status_code == 200
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert accounts[0]["twitch_user"] == "alice"
    assert accounts[0]["youtube_user"] is None


def test_add_account_youtube_only(client, auth_headers):
    res = client.post(
        "/settings/user-accounts",
        json={"label": "YT-only", "youtube_user": "bob"},
        headers=auth_headers,
    )
    assert res.status_code == 200
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert accounts[0]["twitch_user"] is None
    assert accounts[0]["youtube_user"] == "bob"


def test_add_account_requires_at_least_one_platform(client, auth_headers):
    res = client.post(
        "/settings/user-accounts",
        json={"label": "Empty"},
        headers=auth_headers,
    )
    assert res.status_code == 400


def test_add_account_label_required(client, auth_headers):
    res = client.post(
        "/settings/user-accounts",
        json={"twitch_user": "alice"},
        headers=auth_headers,
    )
    assert res.status_code == 422


def test_add_duplicate_account_is_idempotent(client, auth_headers):
    payload = {"label": "Me", "twitch_user": "jwsoat", "youtube_user": "jwsoatvideo"}
    r1 = client.post("/settings/user-accounts", json=payload, headers=auth_headers)
    r2 = client.post("/settings/user-accounts", json=payload, headers=auth_headers)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"]
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert len(accounts) == 1


def test_delete_account(client, auth_headers):
    r = client.post(
        "/settings/user-accounts",
        json={"label": "Me", "twitch_user": "jwsoat"},
        headers=auth_headers,
    )
    aid = r.json()["id"]
    res = client.delete(f"/settings/user-accounts/{aid}", headers=auth_headers)
    assert res.json() == {"ok": True}
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert accounts == []


def test_delete_nonexistent_account_returns_404(client, auth_headers):
    res = client.delete("/settings/user-accounts/99999", headers=auth_headers)
    assert res.status_code == 404


def test_resubmit_same_label_merges_new_handles(client, auth_headers):
    r1 = client.post(
        "/settings/user-accounts",
        json={"label": "Me", "twitch_user": "jwsoat"},
        headers=auth_headers,
    )
    r2 = client.post(
        "/settings/user-accounts",
        json={"label": "Me", "plex_user": "Alice"},
        headers=auth_headers,
    )
    assert r1.json()["id"] == r2.json()["id"]
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert len(accounts) == 1
    assert accounts[0]["twitch_user"] == "jwsoat"
    assert accounts[0]["plex_user"] == "alice"


def test_resubmit_same_label_overwrites_existing_handle(client, auth_headers):
    client.post(
        "/settings/user-accounts",
        json={"label": "Me", "plex_user": "old"},
        headers=auth_headers,
    )
    client.post(
        "/settings/user-accounts",
        json={"label": "Me", "plex_user": "new"},
        headers=auth_headers,
    )
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert len(accounts) == 1
    assert accounts[0]["plex_user"] == "new"


def test_resubmit_blank_field_preserves_existing(client, auth_headers):
    client.post(
        "/settings/user-accounts",
        json={"label": "Me", "twitch_user": "jw", "plex_user": "alice"},
        headers=auth_headers,
    )
    client.post(
        "/settings/user-accounts",
        json={"label": "Me", "youtube_user": "jwyt"},
        headers=auth_headers,
    )
    accounts = client.get("/settings/user-accounts", headers=auth_headers).json()["accounts"]
    assert len(accounts) == 1
    assert accounts[0]["twitch_user"] == "jw"
    assert accounts[0]["plex_user"] == "alice"
    assert accounts[0]["youtube_user"] == "jwyt"


def test_user_accounts_require_auth(client):
    assert client.get("/settings/user-accounts").status_code == 401
    assert client.post(
        "/settings/user-accounts",
        json={"label": "Me", "twitch_user": "x"},
    ).status_code == 401
    assert client.delete("/settings/user-accounts/1").status_code == 401
