// Runs on instagram.com.
// Detects the currently-playing video (feed video / reel), its author
// (channel), the post/reel id and the logged-in account. Instagram's markup is
// heavily obfuscated and randomized, so attribution is best-effort: playback
// time is reliable, author/title may occasionally be null.

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

const RESERVED = new Set([
  "reel", "reels", "p", "explore", "stories", "direct", "accounts",
  "about", "tv", "s", "challenge", "tags",
]);

function getPostInfo(video) {
  // Reel / post id from URL: /reel/<id>/ or /p/<id>/
  let videoId = null;
  const urlMatch = location.pathname.match(/\/(reel|p|tv)\/([^/]+)/);
  if (urlMatch) videoId = urlMatch[2];

  // Author handle: look for a profile link near the video. Profile links are
  // /<username>/ with no reserved first segment.
  const container = video.closest("article") || video.closest("div[role='dialog']") || document;
  let channel = null;
  const links = container.querySelectorAll('a[href^="/"]');
  for (const a of links) {
    const m = a.getAttribute("href").match(/^\/([^/?#]+)\/?$/);
    if (m && !RESERVED.has(m[1])) { channel = m[1].toLowerCase(); break; }
  }
  // On a profile page the username is the first path segment.
  if (!channel) {
    const m = location.pathname.match(/^\/([^/]+)\/?$/);
    if (m && !RESERVED.has(m[1])) channel = m[1].toLowerCase();
  }

  let title = null;
  if (video.getAttribute("aria-label")) title = video.getAttribute("aria-label").trim().slice(0, 512);
  return { channel, videoId, title };
}

function detectInstagramUser() {
  try {
    // The bottom nav / sidebar profile link points at the logged-in user.
    const link = document.querySelector('a[href^="/"][role="link"] img[alt*="profile picture"]');
    if (link) {
      const alt = link.getAttribute("alt") || "";
      const m = alt.match(/^([A-Za-z0-9._]+)'s profile picture/);
      if (m) return m[1].toLowerCase();
    }
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

  const { channel, videoId, title } = getPostInfo(video);
  if (!channel) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    platform: "instagram",
    channel,
    title,
    video_id: videoId,
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    media_user: detectInstagramUser(),
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
