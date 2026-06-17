// Runs on facebook.com.
// Detects the currently-playing video, its author (channel), the video id and
// (best-effort) the logged-in account. Facebook's DOM is heavily obfuscated and
// changes often, so attribution is a best guess: playback time is reliable,
// author/title may be null.

const HEARTBEAT_MS = 10 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

let lastActivity = Date.now();
["mousemove", "keydown", "click", "wheel", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
});

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

function getVideoInfo(video) {
  // Video id from a watch / video permalink in or around the post.
  let videoId = null;
  const urlMatch = location.pathname.match(/\/(?:watch\/?\?v=|videos\/|reel\/)(\d+)/) ||
                   location.search.match(/[?&]v=(\d+)/);
  if (urlMatch) videoId = urlMatch[1];

  const post = video.closest('[role="article"]') || document;
  if (!videoId) {
    const vidLink = post.querySelector('a[href*="/videos/"], a[href*="/watch/?v="], a[href*="/reel/"]');
    const href = vidLink?.getAttribute("href") || "";
    const m = href.match(/(\d{6,})/);
    if (m) videoId = m[1];
  }

  // Author: a Facebook post header carries a profile/page link with a strong
  // name. Prefer a link with an aria-label or non-empty text content.
  let channel = null;
  const authorLink = post.querySelector('h2 a, h3 a, h4 a, [role="link"][aria-label]');
  if (authorLink) {
    const name = (authorLink.getAttribute("aria-label") || authorLink.textContent || "").trim();
    if (name) channel = name.toLowerCase().slice(0, 128);
  }

  let title = null;
  if (video.getAttribute("aria-label")) title = video.getAttribute("aria-label").trim().slice(0, 512);
  return { channel, videoId, title };
}

function detectFacebookUser() {
  try {
    const acct = document.querySelector('[aria-label^="Your profile"], [aria-label^="Account"]');
    const label = acct?.getAttribute("aria-label") || "";
    const m = label.match(/Your profile,?\s*(.+)$/);
    if (m) return m[1].trim().toLowerCase();
  } catch {}
  return null;
}

let tickInterval = null;
let firstTick = null;
function stopTicking() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
}

function tick() {
  if (!chrome.runtime?.id) { stopTicking(); return; }

  const video = getPlayingVideo();
  if (!video) return;

  const { channel, videoId, title } = getVideoInfo(video);
  if (!channel) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    platform: "facebook",
    channel,
    title,
    video_id: videoId,
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    media_user: detectFacebookUser(),
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
