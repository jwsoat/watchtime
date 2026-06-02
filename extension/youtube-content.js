// Runs on youtube.com pages.
// Detects channel, video state, playlist, and logged-in user.

const HEARTBEAT_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

let lastActivity = Date.now();

["mousemove", "keydown", "click", "wheel", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
});

function getVideoId() {
  return new URLSearchParams(location.search).get("v");
}

function getPlaylistId() {
  return new URLSearchParams(location.search).get("list") || null;
}

function getChannelFromDom() {
  const selectors = [
    "ytd-channel-name yt-formatted-string a",
    "#channel-name yt-formatted-string a",
    "#owner #channel-name a",
    "ytd-video-owner-renderer #channel-name a",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim().toLowerCase();
  }
  // Fallback: /@handle in URL on channel pages
  const match = location.pathname.match(/^\/@([^/]+)/);
  if (match) return match[1].toLowerCase();
  return null;
}

function getVideoTitle() {
  const el = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
          || document.querySelector("#title h1 yt-formatted-string");
  return el ? el.textContent.trim().slice(0, 512) : null;
}

function getVideoState() {
  const video = document.querySelector("video");
  if (!video || video.readyState < 1) return { present: false };
  return { present: true, paused: video.paused };
}

function detectYoutubeUser() {
  try {
    if (typeof ytcfg !== "undefined") {
      const name = ytcfg.data_?.LOGGED_IN_ACCOUNT_NAME;
      if (name) return name.toLowerCase();
    }
  } catch {}
  try {
    const el = document.querySelector("yt-user-info #account-name");
    if (el?.textContent?.trim()) return el.textContent.trim().toLowerCase();
  } catch {}
  try {
    const label = document.querySelector("#avatar-btn")?.getAttribute("aria-label") || "";
    const m = label.match(/Google Account:\s*([^(]+)/);
    if (m) return m[1].trim().toLowerCase();
  } catch {}
  return null;
}

let ytUserFallback = null;
chrome.storage.local.get("youtubeUser", ({ youtubeUser: u }) => { ytUserFallback = u || null; });

let tickInterval = null;
let firstTick = null;

function stopTicking() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
}

function tick() {
  if (!chrome.runtime?.id) { stopTicking(); return; }

  const videoId = getVideoId();
  if (!videoId) return;

  const video = getVideoState();
  if (!video.present || video.paused) return;

  const channel = getChannelFromDom();
  if (!channel) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    channel,
    title: getVideoTitle(),
    video_id: videoId,
    playlist_id: getPlaylistId(),
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    youtube_user: detectYoutubeUser() || ytUserFallback,
    platform: "youtube",
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
