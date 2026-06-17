"""Smoke tests for the new static-asset routes."""


def test_root_returns_index_html(client):
    res = client.get("/")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    assert "<!doctype html>" in res.text.lower() or "<html" in res.text.lower()


def test_tv_returns_html(client):
    res = client.get("/tv")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")


def test_static_assets_served(client):
    res = client.get("/static/styles.css")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/css")


def test_health_still_open(client):
    # / and /tv require routes; /health stays unauthenticated
    res = client.get("/health")
    assert res.status_code == 200


def test_twitch_returns_html(client):
    res = client.get("/twitch")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")


def test_youtube_returns_html(client):
    res = client.get("/youtube")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")


def test_settings_returns_html(client):
    res = client.get("/settings")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")


def test_media_pages_return_html(client):
    for path in ("/x", "/facebook", "/instagram", "/plex"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.headers["content-type"].startswith("text/html")
