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

function extractProfileHandle(href) {
  // Accept "/handle/" or "https://www.instagram.com/handle/" (with optional
  // query / hash). Reject any link that has further path segments.
  const m = href.match(
    /^(?:https?:\/\/(?:www\.)?instagram\.com)?\/([^/?#]+)\/?(?:[?#].*)?$/
  );
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (RESERVED.has(h)) return null;
  return h;
}

function getPostInfo(video, selfUser) {
  // Reel / post id from URL: /reel/<id>/, /reels/<id>/, /p/<id>/, /tv/<id>/.
  let videoId = null;
  const urlMatch = location.pathname.match(/\/(?:reel|reels|p|tv)\/([^/]+)/);
  if (urlMatch) videoId = urlMatch[1];

  let channel = null;

  // Walk up from the playing video and, at each ancestor, look for the
  // uploader's avatar (`img[alt="<handle>'s profile picture"]`). Captions and
  // tagged-user mentions render as profile links too, so matching on `<a>`
  // alone misattributes the post to whoever is mentioned in the caption. The
  // avatar img only appears once per post — in the header — and its alt text
  // is the uploader's handle.
  function handleFromAvatar(root) {
    const imgs = root.querySelectorAll('img[alt$="profile picture"]');
    for (const img of imgs) {
      const alt = img.getAttribute("alt") || "";
      const m = alt.match(/^([A-Za-z0-9._]+)['’]s profile picture/);
      if (m) {
        const h = m[1].toLowerCase();
        if (h !== selfUser) return h;
      }
    }
    return null;
  }

  let node = video.parentElement;
  while (node && node !== document.body && !channel) {
    channel = handleFromAvatar(node);
    if (!channel) node = node.parentElement;
  }

  // Fallback: scan profile links in ancestors of video, but only those
  // ancestors that ALSO contain a profile-picture image (header markup). This
  // avoids caption @mentions, which never sit next to an avatar.
  if (!channel) {
    let n = video.parentElement;
    while (n && n !== document.body && !channel) {
      if (n.querySelector('img[alt$="profile picture"]')) {
        const links = n.querySelectorAll("a[href]");
        for (const a of links) {
          const h = extractProfileHandle(a.getAttribute("href") || "");
          if (h && h !== selfUser) { channel = h; break; }
        }
      }
      n = n.parentElement;
    }
  }

  // Single-reel / single-post page: og:title is "<Name> (@<handle>) on Instagram"
  if (!channel) {
    const og = document.querySelector('meta[property="og:title"]');
    const content = og?.getAttribute("content") || "";
    const m = content.match(/\(@([A-Za-z0-9._]+)\)/);
    if (m) channel = m[1].toLowerCase();
  }

  // Profile page: first path segment IS the uploader.
  if (!channel) {
    const m = location.pathname.match(/^\/([^/]+)\/?$/);
    if (m) {
      const h = m[1].toLowerCase();
      if (!RESERVED.has(h)) channel = h;
    }
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

let igUserFallback = null;
chrome.storage.local.get("instagramUser", ({ instagramUser: u }) => { igUserFallback = u || null; });

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

  const selfUser = detectInstagramUser() || igUserFallback;
  const { channel, videoId, title } = getPostInfo(video, selfUser);
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
    media_user: selfUser,
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
