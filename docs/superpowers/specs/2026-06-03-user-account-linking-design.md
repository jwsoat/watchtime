# User Account Linking Design

**Date:** 2026-06-03
**Branch:** add-youtube (continues)
**Status:** Approved

## Overview

Add a way for the user to declare their identity across platforms — "my Twitch login is X, my YouTube login is Y." The merged dashboard then exposes a single account picker listing labeled identities; selecting one filters both platforms simultaneously.

This is distinct from the existing `channel_links` feature, which maps Twitch **creators** to YouTube **creators**. This new feature maps Twitch **viewers** (the user) to YouTube **viewers** (the same user).

## 1. Database

New table added via `init_db()`:

```sql
CREATE TABLE IF NOT EXISTS user_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT NOT NULL,
    twitch_user   TEXT,
    youtube_user  TEXT,
    UNIQUE(twitch_user, youtube_user)
);
```

- `label` — human name like "Me", "Roommate"
- `twitch_user` / `youtube_user` — nullable; an entry may have only one platform
- At least one of the two must be non-null (enforced in API layer, not schema, to keep schema simple)

## 2. API Endpoints

All require API key.

| Method | Path | Body / Notes |
|--------|------|-------|
| GET | `/settings/user-accounts` | Returns `{accounts: [{id, label, twitch_user, youtube_user}]}` |
| POST | `/settings/user-accounts` | `{label, twitch_user?, youtube_user?}` — at least one user field required; 400 if both null; both lowercased before insert; idempotent on duplicate (returns existing id) |
| DELETE | `/settings/user-accounts/{id}` | Returns `{ok: True}`; 404 if id doesn't exist |

## 3. Settings Page

Add a second card above the existing "Channel links" card:

**"Your accounts"** section:
- Description: "Tell the dashboard which Twitch and YouTube accounts are you, so you can filter the merged view by identity."
- Table: Label | Twitch user | YouTube user | Delete
- Add form: Label input, Twitch handle input, YouTube handle input, Add button
- Either Twitch or YouTube handle may be left blank — but at least one must be filled

## 4. Merged View Picker

Replace the two separate pickers on `/` with a single account picker:

- First option: "All accounts" (default — passes no `user=` filter)
- Subsequent options: one per row in `user_accounts`, label format `"Me (Twitch+YouTube)"` / `"Me (Twitch only)"` / `"Me (YouTube only)"` depending on which fields are populated
- When user selects an account: `state.twUser = account.twitch_user`, `state.ytUser = account.youtube_user`. If either is null, the corresponding platform filter is omitted (shows all data for that platform).

`/twitch` and `/youtube` pickers stay as-is (single platform, only that platform's users).

## Out of Scope

- Auto-detection of which Twitch/YouTube users are "me" — user must declare manually
- Per-account theming or avatars on the merged picker
- Multiple Twitch accounts per label (one row = one Twitch + one YouTube max)
