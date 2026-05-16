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


@pytest.fixture
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
