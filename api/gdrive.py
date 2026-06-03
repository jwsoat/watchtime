"""Google Drive backup integration — zero extra dependencies."""

import json
import os
import pathlib
import time
import urllib.parse
import urllib.request

TOKEN_PATH = os.environ.get("GDRIVE_TOKEN_PATH", "/data/gdrive_token.json")
SCOPES = "https://www.googleapis.com/auth/drive.file"
FOLDER_NAME = "Watchtime Backups"
MAX_BACKUPS = 3


def _client_id():
    return os.environ.get("GDRIVE_CLIENT_ID", "")


def _client_secret():
    return os.environ.get("GDRIVE_CLIENT_SECRET", "")


def is_configured():
    return bool(_client_id() and _client_secret())


def is_connected():
    return is_configured() and pathlib.Path(TOKEN_PATH).exists()


def _load_token():
    with open(TOKEN_PATH) as f:
        return json.load(f)


def _save_token(data):
    pathlib.Path(TOKEN_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(TOKEN_PATH, "w") as f:
        json.dump(data, f)


def _refresh_access_token():
    token = _load_token()
    data = urllib.parse.urlencode({
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "refresh_token": token["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    token["access_token"] = result["access_token"]
    token["expires_at"] = time.time() + result.get("expires_in", 3600)
    _save_token(token)
    return token["access_token"]


def _get_access_token():
    token = _load_token()
    if token.get("expires_at", 0) < time.time() + 60:
        return _refresh_access_token()
    return token["access_token"]


def get_auth_url(redirect_uri):
    params = urllib.parse.urlencode({
        "client_id": _client_id(),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{params}"


def exchange_code(code, redirect_uri):
    data = urllib.parse.urlencode({
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    token_data = {
        "access_token": result["access_token"],
        "refresh_token": result["refresh_token"],
        "expires_at": time.time() + result.get("expires_in", 3600),
    }
    _save_token(token_data)
    return token_data


def _find_folder():
    q = urllib.parse.quote(
        f"name='{FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    )
    result = _api_request(
        "GET",
        f"https://www.googleapis.com/drive/v3/files?q={q}&fields=files(id,name)",
    )
    files = result.get("files", [])
    return files[0]["id"] if files else None


def _create_folder():
    result = _api_request("POST", "https://www.googleapis.com/drive/v3/files", body={
        "name": FOLDER_NAME,
        "mimeType": "application/vnd.google-apps.folder",
    })
    return result["id"]


def _get_or_create_folder():
    return _find_folder() or _create_folder()


def _api_request(method, url, body=None):
    access_token = _get_access_token()
    hdrs = {"Authorization": f"Bearer {access_token}"}
    raw = None
    if body is not None:
        raw = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=raw, headers=hdrs, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def upload_file(file_path, filename):
    folder_id = _get_or_create_folder()
    metadata = json.dumps({
        "name": filename,
        "parents": [folder_id],
    }).encode()

    with open(file_path, "rb") as f:
        file_data = f.read()

    boundary = b"----WatchtimeBackupBoundary"
    body = (
        b"--" + boundary + b"\r\n"
        b"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        + metadata + b"\r\n"
        b"--" + boundary + b"\r\n"
        b"Content-Type: application/x-sqlite3\r\n\r\n"
        + file_data + b"\r\n"
        b"--" + boundary + b"--"
    )

    access_token = _get_access_token()
    req = urllib.request.Request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime",
        data=body,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": f"multipart/related; boundary={boundary.decode()}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def list_backups():
    folder_id = _find_folder()
    if not folder_id:
        return []
    q = urllib.parse.quote(f"'{folder_id}' in parents and trashed=false")
    result = _api_request(
        "GET",
        f"https://www.googleapis.com/drive/v3/files?q={q}"
        f"&fields=files(id,name,size,createdTime)&orderBy=createdTime desc",
    )
    return result.get("files", [])


def delete_file(file_id):
    access_token = _get_access_token()
    req = urllib.request.Request(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        method="DELETE",
    )
    urllib.request.urlopen(req)


def rotate_backups(keep=MAX_BACKUPS):
    backups = list_backups()
    deleted = []
    for old in backups[keep:]:
        delete_file(old["id"])
        deleted.append(old["name"])
    return deleted


def disconnect():
    path = pathlib.Path(TOKEN_PATH)
    if path.exists():
        path.unlink()
