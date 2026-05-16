// Runs on twitch.tv pages.
// Job: figure out (a) what channel is on screen, (b) whether the video is
// playing, (c) whether the user is active, and tell the background worker.

const HEARTBEAT_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

let lastActivity = Date.now();

["mousemove", "keydown", "click", "wheel", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => { lastActivity = Date.now(); },
    { passive: true });
});

function getChannelFromUrl() {
  // Twitch channel URLs: twitch.tv/<channel>, twitch.tv/<channel>/...
  // Excludes /directory, /videos, /p/ etc.
  const path = location.pathname.split("/").filter(Boolean);
  if (path.length === 0) return null;
  const first = path[0].toLowerCase();
  const blocked = new Set([
    "directory", "videos", "p", "settings", "subscriptions",
    "wallet", "inventory", "drops", "friends", "search",
    "downloads", "turbo", "prime", "jobs", "about",
  ]);
  if (blocked.has(first)) return null;
  // /<channel>/video/... is a VOD — still counts as that channel
  return first;
}

function getCategory() {
  // Twitch category link: <a data-a-target="stream-game-link" ...>Game</a>
  const el = document.querySelector('[data-a-target="stream-game-link"]');
  return el ? el.textContent.trim().slice(0, 128) : null;
}

function getTitle() {
  const el = document.querySelector('[data-a-target="stream-title"]')
         || document.querySelector('h2[data-a-target="stream-title"]');
  return el ? el.textContent.trim().slice(0, 512) : null;
}

function getTwitchUser() {
  // Twitch stores the logged-in user as JSON in localStorage under
  // "twilight.user". When logged out or unparseable, return null —
  // heartbeats then bucket as "anonymous" server-side.
  try {
    const raw = localStorage.getItem("twilight.user");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const login = parsed?.login;
    return typeof login === "string" && login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

function getVideoState() {
  // Twitch can have multiple <video> elements (picture-in-picture, ads).
  // Pick the largest visible one.
  const videos = [...document.querySelectorAll("video")]
    .filter(v => v.readyState > 0);
  if (videos.length === 0) return { present: false };
  const main = videos.sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
  )[0];
  return {
    present: true,
    paused: main.paused,
    muted: main.muted,
    width: main.clientWidth,
  };
}

function tick() {
  const channel = getChannelFromUrl();
  if (!channel) return;

  const video = getVideoState();
  if (!video.present || video.paused) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  let state;
  if (!tabVisible) {
    // Tab not focused but video still playing → audio-only listening
    state = "audio_only";
  } else if (idle) {
    state = "passive";
  } else {
    state = "active";
  }

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    channel,
    category: getCategory(),
    title: getTitle(),
    state,
    tab_visible: tabVisible,
    twitch_user: getTwitchUser(),
  };

  chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
}

setInterval(tick, HEARTBEAT_MS);
// Also tick shortly after load so we don't wait a full minute for the first hb
setTimeout(tick, 5000);
