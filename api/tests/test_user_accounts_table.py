"""Verify user_accounts table created by init_db."""
import sqlite3
from tests.conftest import DB_PATH


def test_user_accounts_table_exists():
    conn = sqlite3.connect(DB_PATH)
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
    finally:
        conn.close()
    assert "user_accounts" in tables


def test_user_accounts_has_required_columns():
    conn = sqlite3.connect(DB_PATH)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(user_accounts)")}
    finally:
        conn.close()
    assert cols >= {"id", "label", "twitch_user", "youtube_user"}
