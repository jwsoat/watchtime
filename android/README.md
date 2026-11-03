# Watchtime Agent — native Android client (`mobile-android` platform)

A self-contained APK that reports Android app usage to watchtime as the
`mobile-android` platform. It is the native replacement for the Tasker project in
[`../tasker/`](../tasker/): same API, same heartbeat shape, same 10-second cadence,
no Tasker required.

While a tracked app is in the foreground the app POSTs a heartbeat every 10s
(`state: "active"`, `tab_visible: true`). When the user leaves it, or the screen
goes off, it sends one final `state: "passive"` beat so the session closes at the
right time. `channel` is the app's display name (stored lowercased by the API), so
per-platform dashboards rank **apps** — TikTok, Twitch, Netflix, YouTube…

## Install

The built APK is `app/build/outputs/apk/release/app-release.apk`
(`nz.jwsoat.watchtime`, min SDK 26 / Android 8, target SDK 35 / Android 15).

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
# or copy the APK to the device and open it (allow "install unknown apps")
```

## First-run setup (3 permissions)

Open **Watchtime Agent** and work top to bottom:

1. **Server URL** — `https://stats.jwsoat.co.nz` (already the default) and the
   **API key** used by the rest of watchtime. Tap **Test beat**: it must report
   `HTTP 200`. A test beat appears as `test app` until you tick real apps.
2. **Usage access** — *Settings → Special app access → Usage access → Watchtime
   Agent → Allow*. This is the foreground-app signal; without it the service
   cannot tell which app is on screen (it shows "Usage access missing" in the
   notification instead of silently reporting nothing).
3. **Battery optimisation** — tap the button and allow unrestricted battery use.
   Without it Android may freeze the watcher overnight.
   *Notifications* is prompted on Android 13+; the persistent notification is what
   keeps the service alive.

Then tick every app whose watch time should count, flip **Run in background** on,
and open a tracked app for ~30s. Verify server-side:

```bash
curl -H "X-API-Key: <key>" https://stats.jwsoat.co.nz/stats/media/mobile-android/today
```

## Provisioning from adb (tablet fleets)

The activity accepts config via intent extras, so a device can be set up with no
taps:

```bash
adb shell am start -n nz.jwsoat.watchtime/.MainActivity \
  -e base_url https://stats.jwsoat.co.nz \
  -e api_key <key> \
  -e track com.zhiliaoapp.musically,com.netflix.mediaclient,com.google.android.youtube \
  -e autostart true
```

`track` is a comma-separated package list (replaces the current set). Usage access
and battery exemption still need `adb shell appops set nz.jwsoat.watchtime
GET_USAGE_STATS allow` (or a tap), plus the system battery dialog on most OEMs.

## Heartbeat sent

```json
{"heartbeats":[{"ts":1760400000,"platform":"mobile-android",
 "channel":"TikTok","title":null,"video_id":null,"state":"active",
 "tab_visible":true,"client_id":"android-74e3f3a7ad","media_user":null,
 "display_name":"TikTok"}]}
```

- `client_id` is minted once per install (`android-<10 hex>`) and shown in the UI.
- `state: "active"` every 10s while tracked + screen on; one `"passive"` beat when
  the session ends (app switch, screen off, or service stop).
- Offline beats are queued locally (bounded at 2000) and flushed with their
  original timestamps as soon as the server is reachable again.

## What each permission is for

| Permission | Why |
|---|---|
| `PACKAGE_USAGE_STATS` (special access) | foreground-app detection — the only API that reports which app is on screen |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` | keeps the 5s watcher alive with a persistent notification (Android 14+ requires a type; `specialUse` has no 6-hour `dataSync` cap) |
| `POST_NOTIFICATIONS` | the ongoing "Tracking X" notification |
| `RECEIVE_BOOT_COMPLETED` | restart after reboot / app update |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | survive Doze on the OEM's battery manager |
| `INTERNET` / `ACCESS_NETWORK_STATE` | POSTing heartbeats |
| `QUERY_ALL_PACKAGES` | the app picker must list other installed apps on API 30+ |

`usesCleartextTraffic` is enabled so a LAN dev server (`http://192.168.x.x:8766`)
works during testing; production should use the HTTPS Caddy domain.

## Build

```bash
# needs JDK 17+ and an Android SDK with platform 35 + build-tools 35
cd android
JAVA_HOME=... ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleRelease
```

There is no gradle wrapper committed; either add one (`gradle wrapper`) or run the
cached distribution directly:

```bash
~/.gradle/wrapper/dists/gradle-8.14.3-all/*/gradle-8.14.3/bin/gradle assembleRelease
```

Release signing reads `keystore.properties` (`storeFile`, `storePassword`,
`keyAlias`, `keyPassword`), which is gitignored, as is `local.properties`
(`sdk.dir=...`). The APK is signed with the local key in
`watchtime-release.jks` — keep that file to ship updates, or the install will be
rejected as a different signer.

## Limits (same as the Tasker build)

- **No in-app content**: Android gives a background observer no per-video info, so
  `title`/`video_id` are always null and `/stats/media/mobile-android/videos` stays
  empty. The ranking is app usage.
- **`media_user` is always null** — single-user device; account filtering doesn't
  apply to this platform.
- Overlap with browser tracking counts twice (e.g. TikTok in Chrome and on the
  phone), same as Plex. The Merged view rolls them up by creator links only.
- OEM battery managers (Xiaomi/Huawei/Samsung) can still kill the service; the
  15-minute self-check restarts it when Android permits a background FGS start,
  and the app also restarts on reboot.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Notification says "Usage access missing" | special access reset after an OS update — re-grant it |
| Beats sent = 0, status shows `HTTP 401` | wrong API key |
| Status shows `HTTP 0 ConnectException` | server unreachable — beats are queued and flushed later (watch "queued") |
| Nothing tracked while an app is open | that app isn't ticked in **Tracked apps** |
| Stops overnight | battery optimisation still on, or the OEM killed it; check the app's status line |
| Dashboard empty but "beats sent" climbs | wrong server URL (heartbeats landing somewhere else) or `platform` filtered oddly — check the ingest route in the server access log |
