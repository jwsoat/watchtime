# User Account Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add `user_accounts` table + CRUD + settings UI + merged-view single-picker so user can declare cross-platform identity and filter merged dashboard by it.

**Architecture:** Additive — new `user_accounts` table, new `/settings/user-accounts` endpoints, settings page gains a second card, merged view replaces dual pickers with one labeled-account picker.

**Tech Stack:** FastAPI, SQLite, Pydantic, vanilla JS.

---

## Task 1: Add user_accounts table

**Files:**
- Modify: `api/main.py` — `init_db()` executescript
- Create: `api/tests/test_user_accounts_table.py`

- [ ] **Step 1: Write failing test**

Create `api/tests/test_user_accounts_table.py`:

```python
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
```

- [ ] **Step 2: Run to verify fails**

```
cd api && python -m pytest -p no:homeassistant tests/test_user_accounts_table.py -v
```

- [ ] **Step 3: Extend init_db executescript**

In `api/main.py`, find the executescript in `init_db()` and append (inside the same triple-quoted SQL block, before the closing `"""`):

```sql
            CREATE TABLE IF NOT EXISTS user_accounts (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                label         TEXT NOT NULL,
                twitch_user   TEXT,
                youtube_user  TEXT,
                UNIQUE(twitch_user, youtube_user)
            );
```

- [ ] **Step 4: Run tests**

```
cd api && python -m pytest -p no:homeassistant tests/test_user_accounts_table.py -v
```
Expected: 2 PASSED.

- [ ] **Step 5: Update conftest.py to clean user_accounts**

In `api/tests/conftest.py`, find the `_clean_youtube_data` fixture and add `user_accounts` cleanup. Change:

```python
        conn.execute("DELETE FROM youtube_heartbeats")
        conn.execute("DELETE FROM channel_links")
```

to:

```python
        conn.execute("DELETE FROM youtube_heartbeats")
        conn.execute("DELETE FROM channel_links")
        conn.execute("DELETE FROM user_accounts")
```

Also rename the fixture from `_clean_youtube_data` to `_clean_youtube_and_user_data` so its name reflects the broader scope — update the fixture decorator/function name accordingly.

- [ ] **Step 6: Commit**

```bash
git add api/main.py api/tests/test_user_accounts_table.py api/tests/conftest.py
git commit -m "feat: add user_accounts table"
```

---

## Task 2: User accounts CRUD endpoints

**Files:**
- Modify: `api/main.py`
- Create: `api/tests/test_user_accounts.py`

- [ ] **Step 1: Write failing tests**

Create `api/tests/test_user_accounts.py`:

```python
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
    assert res.status_code == 422  # Pydantic validation error


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


def test_user_accounts_require_auth(client):
    assert client.get("/settings/user-accounts").status_code == 401
    assert client.post(
        "/settings/user-accounts",
        json={"label": "Me", "twitch_user": "x"},
    ).status_code == 401
    assert client.delete("/settings/user-accounts/1").status_code == 401
```

- [ ] **Step 2: Run to verify fails**

```
cd api && python -m pytest -p no:homeassistant tests/test_user_accounts.py -v
```

- [ ] **Step 3: Add UserAccount model and endpoints to api/main.py**

After the `ChannelLink` model in `api/main.py`, add:

```python
class UserAccount(BaseModel):
    label: str = Field(..., min_length=1, max_length=64)
    twitch_user: Optional[str] = Field(default=None, max_length=64)
    youtube_user: Optional[str] = Field(default=None, max_length=128)
```

After the `delete_channel_link` endpoint, add:

```python
@app.get("/settings/user-accounts", dependencies=[Depends(require_api_key)])
def get_user_accounts():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, label, twitch_user, youtube_user FROM user_accounts ORDER BY id"
        ).fetchall()
    return {
        "accounts": [
            {"id": r["id"], "label": r["label"],
             "twitch_user": r["twitch_user"], "youtube_user": r["youtube_user"]}
            for r in rows
        ]
    }


@app.post("/settings/user-accounts", dependencies=[Depends(require_api_key)])
def add_user_account(account: UserAccount):
    tw = account.twitch_user.lower() if account.twitch_user else None
    yt = account.youtube_user.lower() if account.youtube_user else None
    if tw is None and yt is None:
        raise HTTPException(status_code=400, detail="at least one of twitch_user or youtube_user required")
    with db() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO user_accounts (label, twitch_user, youtube_user) VALUES (?, ?, ?)",
                (account.label, tw, yt),
            )
            account_id = cursor.lastrowid
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id FROM user_accounts WHERE twitch_user IS ? AND youtube_user IS ?",
                (tw, yt),
            ).fetchone()
            account_id = row["id"]
    return {"ok": True, "id": account_id}


@app.delete("/settings/user-accounts/{account_id}", dependencies=[Depends(require_api_key)])
def delete_user_account(account_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM user_accounts WHERE id = ?", (account_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="account not found")
    return {"ok": True}
```

NOTE: The SELECT after IntegrityError uses `IS ?` instead of `= ?` because SQL `NULL = NULL` is false; `IS` handles NULL properly for the idempotency lookup.

- [ ] **Step 4: Run tests**

```
cd api && python -m pytest -p no:homeassistant tests/test_user_accounts.py -v
```
Expected: 10 PASSED.

- [ ] **Step 5: Commit**

```bash
git add api/main.py api/tests/test_user_accounts.py
git commit -m "feat: add /settings/user-accounts CRUD"
```

---

## Task 3: Settings page UI for user accounts

**Files:**
- Modify: `api/static/settings.html`
- Modify: `api/static/settings.js`

- [ ] **Step 1: Add "Your accounts" card to settings.html**

Find the existing `<div class="card" style="max-width:640px">` (the channel links card) in `api/static/settings.html`. INSERT a new card BEFORE it:

```html
    <div class="card" style="max-width:640px; margin-bottom:16px">
      <h2>Your accounts</h2>
      <p style="color:var(--muted); font-size:13px; margin:8px 0 16px">
        Tell the dashboard which Twitch and YouTube accounts are you. The merged view picker uses these labels.
      </p>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Twitch user</th>
            <th>YouTube user</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="accounts-tbody"></tbody>
      </table>
      <form id="add-account-form" class="add-row">
        <input id="input-label" type="text" placeholder="Label (e.g. Me)" autocomplete="off">
        <input id="input-account-twitch" type="text" placeholder="Twitch handle (optional)" autocomplete="off">
        <input id="input-account-youtube" type="text" placeholder="YouTube handle (optional)" autocomplete="off">
        <button type="submit">Add account</button>
      </form>
    </div>
```

- [ ] **Step 2: Update the CSS in the existing <style> block**

The existing settings.html already has table/.add-row styles in a `<style>` block. They will apply to the new table too. No changes needed.

- [ ] **Step 3: Extend settings.js**

In `api/static/settings.js`, after the `loadLinks` function definition, add:

```javascript
async function loadAccounts() {
  const { accounts } = await apiReq("GET", "/settings/user-accounts");
  const tbody = $("accounts-tbody");
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted); padding:12px 0">No accounts configured.</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(a => `
    <tr>
      <td>${escapeHtml(a.label)}</td>
      <td>${a.twitch_user ? escapeHtml(a.twitch_user) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${a.youtube_user ? escapeHtml(a.youtube_user) : '<span style="color:var(--muted)">—</span>'}</td>
      <td><button class="del-acct-btn" data-id="${a.id}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-acct-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/user-accounts/${btn.dataset.id}`);
      loadAccounts().catch(console.error);
    });
  });
}
```

ALSO update the CSS for `.del-acct-btn` — add it to the same selector list as `.del-btn` in settings.html `<style>`. Find:
```css
    .del-btn { background: none; ... }
    .del-btn:hover { ... }
```
Change to:
```css
    .del-btn, .del-acct-btn { background: none; border: 1px solid #555; color: var(--muted); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .del-btn:hover, .del-acct-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }
```

Then find the add-form handler in settings.js and add a NEW handler for the accounts form. After the existing `$("add-form").addEventListener(...)` block, add:

```javascript
$("add-account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("input-label").value.trim();
  const twitch = $("input-account-twitch").value.trim().toLowerCase();
  const youtube = $("input-account-youtube").value.trim().toLowerCase();
  if (!label) return;
  if (!twitch && !youtube) {
    alert("Provide at least a Twitch or YouTube handle.");
    return;
  }
  const body = { label };
  if (twitch) body.twitch_user = twitch;
  if (youtube) body.youtube_user = youtube;
  try {
    await apiReq("POST", "/settings/user-accounts", body);
  } catch (err) {
    alert(`Failed: ${err.message}`);
    return;
  }
  $("input-label").value = "";
  $("input-account-twitch").value = "";
  $("input-account-youtube").value = "";
  loadAccounts().catch(console.error);
});
```

Finally, update `boot()` to also load accounts:

```javascript
async function boot() {
  await loadLinks();
  await loadAccounts();
}
```

- [ ] **Step 4: Commit**

```bash
git add api/static/settings.html api/static/settings.js
git commit -m "feat: settings page UI for user account linking"
```

---

## Task 4: Replace merged view dual pickers with single account picker

**Files:**
- Modify: `api/static/index.html`
- Modify: `api/static/app.js`

- [ ] **Step 1: Replace dual pickers in index.html**

Find this block in `api/static/index.html`:

```html
    <div style="display:flex; gap:12px; margin-bottom:8px; flex-wrap:wrap;">
      <select id="twitch-picker" class="account-picker"></select>
      <select id="youtube-picker" class="account-picker"></select>
    </div>
```

Replace with:

```html
    <div style="display:flex; gap:12px; margin-bottom:8px; flex-wrap:wrap;">
      <select id="account-picker" class="account-picker"></select>
    </div>
```

- [ ] **Step 2: Update app.js boot/loadPickers logic**

Open `api/static/app.js`. Replace the entire `loadPickers()` function AND both `$("twitch-picker")` / `$("youtube-picker")` change listeners with a single `loadAccountPicker()` function and one listener.

Find:

```javascript
async function loadPickers() {
  const [{ users: twUsers }, { users: ytUsers }] = await Promise.all([
    ...
  ]);
  // ... entire dual-picker setup
}

$("twitch-picker").addEventListener("change", (e) => { ... });
$("youtube-picker").addEventListener("change", (e) => { ... });
```

Replace with:

```javascript
const ACCOUNT_KEY = "watchtime_merged_account";

async function loadAccountPicker() {
  const { accounts } = await api("/settings/user-accounts");
  const select = $("account-picker");
  select.innerHTML = "";

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All accounts";
  select.appendChild(all);

  for (const a of accounts) {
    const platforms = [];
    if (a.twitch_user) platforms.push("Twitch");
    if (a.youtube_user) platforms.push("YouTube");
    const opt = document.createElement("option");
    opt.value = String(a.id);
    opt.textContent = `${a.label} (${platforms.join("+")})`;
    opt.dataset.twitchUser = a.twitch_user || "";
    opt.dataset.youtubeUser = a.youtube_user || "";
    select.appendChild(opt);
  }

  const saved = localStorage.getItem(ACCOUNT_KEY);
  if (saved && accounts.find(a => String(a.id) === saved)) {
    select.value = saved;
    const opt = select.options[select.selectedIndex];
    state.twUser = opt.dataset.twitchUser || null;
    state.ytUser = opt.dataset.youtubeUser || null;
  } else {
    state.twUser = null;
    state.ytUser = null;
  }
}

$("account-picker").addEventListener("change", (e) => {
  const opt = e.target.options[e.target.selectedIndex];
  if (e.target.value === "") {
    state.twUser = null;
    state.ytUser = null;
    localStorage.removeItem(ACCOUNT_KEY);
  } else {
    state.twUser = opt.dataset.twitchUser || null;
    state.ytUser = opt.dataset.youtubeUser || null;
    localStorage.setItem(ACCOUNT_KEY, e.target.value);
  }
  refresh();
});
```

Also REMOVE the old `TW_ACCOUNT_KEY` and `YT_ACCOUNT_KEY` constants (no longer used by merged view; they remain in twitch.js and youtube.js).

Find in `boot()`:

```javascript
async function boot() {
  await loadPickers();
  ...
}
```

Change to:

```javascript
async function boot() {
  await loadAccountPicker();
  ...
}
```

- [ ] **Step 3: Verify updateMerged still works**

`updateMerged()` reads `state.twUser` and `state.ytUser`. The new picker sets these the same way the old dual-picker did. If twUser is null but ytUser is set, `/stats/{window}` is called with no filter (correct — shows all Twitch data) and `/stats/youtube/{window}?user=...` is filtered. No code change needed inside `updateMerged()`.

- [ ] **Step 4: Commit**

```bash
git add api/static/index.html api/static/app.js
git commit -m "feat: merged view uses single account picker driven by user_accounts"
```

---

## Task 5: Manual verification

**Files:** none (manual test)

- [ ] **Step 1: Deploy and test**

```bash
cd api && python -m pytest -p no:homeassistant -q
```
Expected: 68/69 (1 pre-existing failure).

Deploy to Proxmox:
```bash
ssh root@192.168.1.100
cd /path/to/twitch-watchtime
git pull
docker compose up -d --build
```

- [ ] **Step 2: Manual UI test**

1. Open `https://192.168.1.100:8765/settings` — hard refresh (Ctrl+Shift+R)
2. Add account: label "Me", twitch "jwsoat", youtube "JwsoatVideo"
3. Verify row appears in "Your accounts" table
4. Open `/` — picker dropdown should show "All accounts" + "Me (Twitch+YouTube)"
5. Select "Me" — merged table should filter to only your watch time on both platforms
6. Refresh page — picker should remember "Me" selection

---

## Self-Review

**Spec coverage:**
- ✅ user_accounts table → Task 1
- ✅ CRUD endpoints with at-least-one-platform validation → Task 2
- ✅ Settings page "Your accounts" card → Task 3
- ✅ Merged view single labeled picker → Task 4
- ✅ /twitch and /youtube pickers untouched → no task needed (don't modify twitch.js/youtube.js)

**Type consistency:**
- `accounts[]` shape: `{id, label, twitch_user, youtube_user}` — used identically in API, settings.js, app.js
- `state.twUser` / `state.ytUser` set by picker change → consumed by `updateMerged()` (unchanged)
- `UNIQUE(twitch_user, youtube_user)` requires `IS ?` (not `= ?`) in idempotency SELECT — explicitly noted in Task 2

**No placeholders.**
