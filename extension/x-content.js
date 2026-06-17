// Runs on x.com / twitter.com.
// Detects the currently-playing video, its author (channel), tweet id and the
// logged-in account. X is a single-page app with frequently-changing,
// obfuscated markup, so detection is best-effort: playback time is reliable,
// author/title attribution is a best guess and may occasionally be null.

const HEARTBEAT_MS = 10 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

let lastActivity = Date.now();
["mousemove", "keydown", "click", "wheel", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
});

// Pick the playing video that is most visible in the viewport (feeds autoplay
// several at once; we attribute time to the one actually on screen).
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

// From a video element, find the enclosing tweet and pull author handle + id.
function getTweetInfo(video) {
  const article = video.closest("article") || document;
  // A status link looks like /<handle>/status/<id>.
  const statusLink = article.querySelector('a[href*="/status/"]');
  let channel = null;
  let videoId = null;
  if (statusLink) {
    const m = statusLink.getAttribute("href").match(/^\/([^/]+)\/status\/(\d+)/);
    if (m) { channel = m[1].toLowerCase(); videoId = m[2]; }
  }
  // URL fallback on a standalone status page.
  if (!channel) {
    const m = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (m) { channel = m[1].toLowerCase(); videoId = m[2]; }
  }
  let title = null;
  const tweetText = article.querySelector('[data-testid="tweetText"]');
  if (tweetText?.textContent) title = tweetText.textContent.trim().slice(0, 512);
  return { channel, videoId, title };
}

function detectXUser() {
  try {
    const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (btn) {
      // The button contains the @handle somewhere in its text.
      const m = btn.textContent.match(/@([A-Za-z0-9_]+)/);
      if (m) return m[1].toLowerCase();
    }
  } catch {}
  try {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = link?.getAttribute("href") || "";
    const m = href.match(/^\/([^/]+)/);
    if (m) return m[1].toLowerCase();
  } catch {}
  return null;
}

let xUserFallback = null;
chrome.storage.local.get("xUser", ({ xUser: u }) => { xUserFallback = u || null; });

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

  const { channel, videoId, title } = getTweetInfo(video);
  if (!channel) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    platform: "x",
    channel,
    title,
    video_id: videoId,
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    media_user: detectXUser() || xUserFallback,
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
