// Runs on twitch.tv pages.
// Job: figure out (a) what channel is on screen, (b) whether the video is
// playing, (c) whether the user is active, and tell the background worker.

const HEARTBEAT_MS = 10 * 1000;
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

let twitchUserFallback = null;
chrome.storage.local.get("twitchUser", ({ twitchUser: u }) => { twitchUserFallback = u || null; });

// Auto-detect the logged-in Twitch account from the page so multi-account
// setups work without manually updating the extension options.
function detectLoggedInTwitchUser() {
  // Strategy 1: Twitch's persisted Redux/React state in localStorage
  try {
    const raw = localStorage.getItem("twilight.persist");
    if (raw) {
      const data = JSON.parse(raw);
      const login = data?.root?.currentUser?.login || data?.currentUser?.login;
      if (login && typeof login === "string") return login.toLowerCase();
    }
  } catch {}

  // Strategy 2: Twitch embeds a passport-context script tag with user info
  try {
    const ctx = document.getElementById("passport-context");
    if (ctx) {
      const data = JSON.parse(ctx.textContent);
      if (data?.userLogin) return data.userLogin.toLowerCase();
    }
  } catch {}

  // Strategy 3: DOM — the user menu toggle button exposes the username
  // via a child element Twitch uses for their own test automation.
  try {
    const el = document.querySelector(
      '[data-a-target="user-menu-toggle"] [data-a-target="user-display-name"],' +
      '[data-a-target="user-menu-toggle"] p'
    );
    const name = el?.textContent?.trim();
    if (name) return name.toLowerCase();
  } catch {}

  return null;
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

let tickInterval = null;
let firstTick = null;

function stopTicking() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
}

function tick() {
  // If the extension was reloaded, this content script is orphaned. chrome.runtime.id
  // becomes undefined and any chrome.* call throws "Extension context invalidated".
  // Stop the timers; the next page navigation will inject a fresh script.
  if (!chrome.runtime?.id) {
    stopTicking();
    return;
  }

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
    twitch_user: detectLoggedInTwitchUser() || twitchUserFallback,
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    // Race: id check passed but the context was invalidated between then and now.
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
// Also tick shortly after load so we don't wait a full minute for the first hb
firstTick = setTimeout(tick, 5000);
