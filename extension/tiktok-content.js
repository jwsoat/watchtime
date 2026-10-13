// Runs on tiktok.com.
// Detects the currently-playing video, its author (@handle), video id and
// best-effort title. TikTok is a single-page app with obfuscated class names,
// so attribution is best-effort: the For You feed shows videos whose author
// is not in the URL, so we walk up from the video element looking for an
// author link (a[href^="/@"]). Playback time is reliable; channel/title may
// occasionally be null on feed pages without resolvable authors.

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

// Walk up from the video looking for an author link (/@handle); TikTok has no
// stable container element to anchor on, so try a few ancestor levels.
function findAuthorLink(video) {
  let node = video;
  for (let i = 0; i < 8 && node; i++) {
    const link = node.querySelector
      ? node.querySelector('a[href^="/@"]')
      : null;
    if (link) return link;
    node = node.parentElement;
  }
  return null;
}

function getVideoInfo(video) {
  let channel = null;
  let videoId = null;

  // URL first: /@<handle>/video/<id>
  let m = location.pathname.match(/^\/@([A-Za-z0-9_.]+)/);
  if (m) channel = m[1].toLowerCase();
  m = location.pathname.match(/\/video\/(\d+)/);
  if (m) videoId = m[1];

  const link = findAuthorLink(video);
  if (link) {
    const href = link.getAttribute("href") || "";
    if (!channel) {
      const hm = href.match(/^\/@([A-Za-z0-9_.]+)/);
      if (hm) channel = hm[1].toLowerCase();
    }
    if (!videoId) {
      const vm = href.match(/\/video\/(\d+)/);
      if (vm) videoId = vm[1];
    }
  }

  // Title: the video's description text. Walk up from the video like the
  // author search, then fall back to document-wide. document.title is
  // deliberately NOT a fallback — on TikTok it's generic tab chrome
  // ("TikTok – Make Your Day"), not the video title; og:title is only
  // marginally better, so keep it last.
  let title = null;
  const DESC_SELECTORS = [
    '[data-e2e="browse-video-desc"]',
    '[data-e2e="video-desc"]',
  ];
  let node = video;
  for (let i = 0; i < 8 && node && !title; i++) {
    for (const sel of DESC_SELECTORS) {
      const el = node.querySelector?.(sel);
      if (el?.textContent?.trim()) { title = el.textContent.trim().slice(0, 512); break; }
    }
    node = node.parentElement;
  }
  // No document-wide desc lookup: the feed preloads neighbouring videos, so a
  // page-wide querySelector could grab the WRONG video's description.
  if (!title) {
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) title = og.content.trim().slice(0, 512);
  }

  return { channel, videoId, title };
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
  if (!channel) return; // feed video with no resolvable author — skip tick

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    platform: "tiktok",
    channel,
    title,
    video_id: videoId,
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    media_user: null, // TikTok web doesn't expose the logged-in account reliably
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
