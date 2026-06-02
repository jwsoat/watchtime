"""
Shared test fixtures. Env vars MUST be set before importing `main`, since
main.py reads them at module level and calls init_db() at import time.
"""
import os
import sqlite3
import tempfile

_fd, _DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["API_KEY"] = "test-key-12345"
os.environ["DB_PATH"] = _DB_PATH

import pytest
from fastapi.testclient import TestClient

TEST_API_KEY = "test-key-12345"
DB_PATH = _DB_PATH


@pytest.fixture(scope="session")
def app():
    from main import app as fastapi_app
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def auth_headers():
    return {"X-API-Key": TEST_API_KEY}


@pytest.fixture(autouse=True)
def _clean_heartbeats(app):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("DELETE FROM heartbeats")
        conn.commit()
    finally:
        conn.close()
    yield


@pytest.fixture(autouse=True)
def _clean_youtube_data(app):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("DELETE FROM youtube_heartbeats")
        conn.execute("DELETE FROM channel_links")
        conn.execute("DELETE FROM user_accounts")
        conn.commit()
    finally:
        conn.close()
    yield


def insert_youtube_heartbeat(
    db_conn, ts, channel, youtube_user=None, title=None,
    video_id=None, playlist_id=None, state="active", tab_visible=1,
    client_id="test-client",
):
    """Insert a youtube_heartbeat row directly. Caller must commit."""
    db_conn.execute(
        "INSERT INTO youtube_heartbeats "
        "(ts, channel, title, video_id, playlist_id, state, tab_visible, youtube_user, client_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (ts, channel.lower(), title, video_id, playlist_id, state, tab_visible, youtube_user, client_id),
    )


@pytest.fixture
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def insert_heartbeat(
    db_conn, ts, channel, twitch_user=None, category=None,
    title=None, state="active", tab_visible=1, client_id="test-client",
):
    """Insert a heartbeat row directly. Caller must commit."""
    db_conn.execute(
        "INSERT INTO heartbeats "
        "(ts, channel, category, title, state, tab_visible, client_id, twitch_user) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ts, channel.lower(), category, title, state, tab_visible, client_id, twitch_user),
    )
