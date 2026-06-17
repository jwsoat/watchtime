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

const FB_RESERVED = new Set([
  "watch", "reel", "reels", "videos", "video", "stories", "story",
  "groups", "events", "marketplace", "gaming", "messages", "friends",
  "saved", "settings", "help", "policies", "ads", "business", "pages",
  "search", "home", "notifications", "profile.php", "people",
]);

function fbExtractHandle(href) {
  // Accept /<handle>/ or absolute facebook.com/<handle>/. Ignore reserved
  // top-level paths and links with extra path segments (those are post URLs,
  // not profiles).
  const m = href.match(
    /^(?:https?:\/\/(?:[a-z.]+\.)?facebook\.com)?\/([^/?#]+)\/?(?:[?#].*)?$/i
  );
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (FB_RESERVED.has(h)) return null;
  // Real handles don't start with a dot or contain query-looking chars.
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  return h;
}

function getVideoInfo(video, selfUser) {
  // Video id from URL.
  let videoId = null;
  const urlMatch = location.pathname.match(/\/(?:videos|reel|reels|watch)\/(\d+)/) ||
                   location.search.match(/[?&]v=(\d+)/);
  if (urlMatch) videoId = urlMatch[1];

  // Walk up from the playing video, scanning each ancestor for the post's
  // author.
  const UI_LABELS = /^(see |view |like|comment|share|follow|more|options|play|pause|mute|unmute|fullscreen|skip|for you|following|explore|home|reels?|videos?|watch|trending)$|^(see |view |like|comment|share)/i;
  let channel = null;
  let displayName = null;

  function pickDisplayName(handleHref) {
    if (!handleHref) return null;
    // Find another <a> in the same scope sharing the same href that has
    // non-empty text content — that's the human-readable creator name.
    const matches = document.querySelectorAll(`a[href="${handleHref}"]`);
    for (const a of matches) {
      const txt = (a.textContent || "").trim();
      if (txt && !UI_LABELS.test(txt) && txt.length <= 128) return txt;
    }
    return null;
  }

  let node = video.parentElement;
  while (node && node !== document.body && !channel) {
    const ownerLink = node.querySelector(
      'a[aria-label*="owner profile" i], a[aria-label*="creator profile" i]'
    );
    if (ownerLink) {
      const href = ownerLink.getAttribute("href") || "";
      const h = fbExtractHandle(href);
      if (h && h !== selfUser) {
        channel = h;
        displayName = pickDisplayName(href);
        break;
      }
    }
    const links = node.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const h = fbExtractHandle(href);
      if (h && h !== selfUser) {
        channel = h;
        const txt = (a.textContent || "").trim();
        if (txt && !UI_LABELS.test(txt) && txt.length <= 128) displayName = txt;
        if (!displayName) displayName = pickDisplayName(href);
        break;
      }
    }
    if (!channel) {
      for (const a of links) {
        const label = a.getAttribute("aria-label");
        if (!label) continue;
        const name = label.split(",")[0].trim();
        if (!name || UI_LABELS.test(name)) continue;
        const lc = name.toLowerCase();
        if (lc !== selfUser) {
          channel = lc.slice(0, 128);
          displayName = name.slice(0, 128);
          break;
        }
      }
    }
    node = node.parentElement;
  }

  // Single video page fallback: og:title carries the author name.
  if (!channel) {
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
    const m = og.match(/^([^|]+?)\s+\|/);
    if (m) channel = m[1].trim().toLowerCase().slice(0, 128);
  }

  let title = null;
  if (video.getAttribute("aria-label")) title = video.getAttribute("aria-label").trim().slice(0, 512);
  return { channel, videoId, title, displayName };
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

let fbUserFallback = null;
chrome.storage.local.get("facebookUser", ({ facebookUser: u }) => { fbUserFallback = u || null; });

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

  const selfUser = detectFacebookUser() || fbUserFallback;
  const { channel, videoId, title, displayName } = getVideoInfo(video, selfUser);
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
    media_user: selfUser,
    display_name: displayName,
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
