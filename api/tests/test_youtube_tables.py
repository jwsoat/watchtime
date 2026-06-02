"""Verify youtube_heartbeats and channel_links tables are created by init_db."""
import sqlite3
from tests.conftest import DB_PATH


def test_youtube_heartbeats_table_exists():
    conn = sqlite3.connect(DB_PATH)
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
    finally:
        conn.close()
    assert "youtube_heartbeats" in tables
    assert "channel_links" in tables


def test_youtube_heartbeats_has_required_columns():
    conn = sqlite3.connect(DB_PATH)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(youtube_heartbeats)")}
    finally:
        conn.close()
    assert cols >= {"id", "ts", "channel", "title", "video_id", "playlist_id",
                    "state", "tab_visible", "youtube_user", "client_id"}


def test_channel_links_has_required_columns():
    conn = sqlite3.connect(DB_PATH)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(channel_links)")}
    finally:
        conn.close()
    assert cols >= {"id", "twitch_channel", "youtube_channel"}
