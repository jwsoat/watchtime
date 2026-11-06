// Runs on youtube.com pages.
// Detects channel, video state, playlist, and logged-in user.

const HEARTBEAT_MS = 10 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

let lastActivity = Date.now();

["mousemove", "keydown", "click", "wheel", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
});

function getVideoId() {
  const v = new URLSearchParams(location.search).get("v");
  if (v) return v;
  const path = location.pathname.match(/^\/(?:live|embed|shorts)\/([A-Za-z0-9_-]{6,})/);
  if (path) return path[1];
  return null;
}

function getPlaylistId() {
  return new URLSearchParams(location.search).get("list") || null;
}

function getChannelFromDom() {
  // Prefer @handle from href — needed for unavatar.io avatar lookup.
  // Scope strictly to owner widgets; unscoped ytd-channel-name would match
  // comments, recommended-video cards, or the "About this game" panel
  // (e.g. /@FIFA on gaming videos) and mis-attribute the channel.
  const owner = document.querySelector(
    "ytd-video-owner-renderer, yt-reel-channel-bar-view-model"
  );
  const byLink = owner?.querySelector(
    "a[href^='/@'], a[href^='/channel/']"
  );
  const href = byLink?.getAttribute("href") || "";
  const handle = href.match(/\/@([^/?#]+)/)?.[1];
  if (handle) return handle.toLowerCase();

  const channelId = href.match(/\/channel\/([^/?#]+)/)?.[1];
  if (channelId) return channelId.toLowerCase();

  // Fallback: /@handle in URL on channel pages
  const match = location.pathname.match(/^\/@([^/]+)/);
  if (match) return match[1].toLowerCase();

  // Last resort: display name text
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
  return null;
}

function getVideoTitle() {
  if (location.pathname.startsWith("/shorts/")) {
    const shortsEl = document.querySelector("yt-shorts-video-title-view-model h1");
    return shortsEl ? shortsEl.textContent.trim().slice(0, 512) : null;
  }
  const el = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
          || document.querySelector("#title h1 yt-formatted-string");
  return el ? el.textContent.trim().slice(0, 512) : null;
}

function isShortsPage() {
  return location.pathname.startsWith("/shorts/");
}

// Shorts feed preloads neighbouring shorts, so the FIRST <video> in the DOM is
// often a neighbour, not the one on screen. Mirror the TikTok script's
// approach: pick the playing video with the largest viewport-visible area.
function getPlayingVideo() {
  const videos = [...document.querySelectorAll("video")];
  let best = null;
  let bestArea = 0;
  for (const v of videos) {
    if (v.paused || v.readyState < 2) continue;
    const r = v.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) *
                    Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    if (visible > bestArea) { bestArea = visible; best = v; }
  }
  return best;
}

// Channel/title lookup scoped to the playing video's ancestors. The Shorts
// feed keeps neighbouring shorts in the DOM, so a document-wide query can
// attribute the WRONG short's channel/title — walk up from the video instead.
function getShortsInfoFromVideo(video) {
  let channel = null;
  let title = null;
  let node = video;
  for (let i = 0; i < 10 && node && (!channel || !title); i++) {
    if (!channel) {
      const link = node.querySelector?.('a[href^="/@"], a[href^="/channel/"]');
      const href = link?.getAttribute("href") || "";
      const handle = href.match(/^\/@([^/?#]+)/)?.[1];
      channel = handle
        ? handle.toLowerCase()
        : (href.match(/^\/channel\/([^/?#]+)/)?.[1]?.toLowerCase() || null);
    }
    if (!title) {
      const t = node.querySelector?.("yt-shorts-video-title-view-model h1, h1");
      if (t?.textContent?.trim()) title = t.textContent.trim().slice(0, 512);
    }
    node = node.parentElement;
  }
  return { channel, title };
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

  const isShorts = isShortsPage();

  // On Shorts, drive everything off the most-visible playing video (the feed
  // preloads neighbours, so first-in-DOM / document-wide lookups mis-attribute).
  let shortsInfo = null;
  if (isShorts) {
    const playing = getPlayingVideo();
    if (!playing) return;
    shortsInfo = getShortsInfoFromVideo(playing);
    if (!shortsInfo.channel) return;
  }

  const video = getVideoState();
  if (!video.present || video.paused) return;

  const channel = isShorts ? shortsInfo.channel : getChannelFromDom();
  if (!channel) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    channel,
    title: isShorts ? shortsInfo.title : getVideoTitle(),
    video_id: videoId,
    playlist_id: getPlaylistId(),
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    youtube_user: detectYoutubeUser() || ytUserFallback,
    is_shorts: isShortsPage(),
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
