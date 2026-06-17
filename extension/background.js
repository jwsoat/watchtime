// Service worker: receive heartbeats, queue them, batch-flush to API.

const QUEUE_KEY = "hb_queue";
const FLUSH_ALARM = "flush";
const FLUSH_INTERVAL_MINUTES = 0.5;  // 30 seconds — MV3 minimum
const MAX_QUEUE = 5000;

// Recreate alarm if the service worker was evicted and restarted
chrome.alarms.get(FLUSH_ALARM, (alarm) => {
  if (!alarm) chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_INTERVAL_MINUTES });
});

async function getSettings() {
  const { apiUrl, apiKey, clientId } = await chrome.storage.local.get(
    ["apiUrl", "apiKey", "clientId"]
  );
  return { apiUrl, apiKey, clientId };
}

async function ensureClientId() {
  let { clientId } = await chrome.storage.local.get("clientId");
  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return clientId;
}

async function enqueue(hb) {
  const clientId = await ensureClientId();
  hb.client_id = clientId;
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  queue.push(hb);
  // Hard cap so we don't grow unbounded if the API is offline for weeks
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function flushQueue(queueKey, endpoint) {
  const { apiUrl, apiKey } = await getSettings();
  if (!apiUrl || !apiKey) return;

  const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
  if (queue.length === 0) return;

  const batch = queue.slice(0, 500);

  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ heartbeats: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { [queueKey]: latest = [] } = await chrome.storage.local.get(queueKey);
    await chrome.storage.local.set({ [queueKey]: latest.slice(batch.length) });
  } catch (err) {
    console.warn(`[watchtime] flush failed for ${endpoint}:`, err.message);
  }
}

async function flush() {
  await flushQueue(QUEUE_KEY, "/heartbeats");
  await flushQueue("yt_queue", "/youtube/heartbeats");
  await flushQueue("media_queue", "/media/heartbeats");
}

async function enqueueYoutube(hb) {
  const clientId = await ensureClientId();
  hb.client_id = clientId;
  const { yt_queue: queue = [] } = await chrome.storage.local.get("yt_queue");
  queue.push(hb);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  await chrome.storage.local.set({ yt_queue: queue });
}

// Generic queue for the additional video sources (x, facebook, instagram).
// Each heartbeat keeps its own `platform` field so the backend can route it.
async function enqueueMedia(hb) {
  const clientId = await ensureClientId();
  hb.client_id = clientId;
  const { media_queue: queue = [] } = await chrome.storage.local.get("media_queue");
  queue.push(hb);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  await chrome.storage.local.set({ media_queue: queue });
}

const MEDIA_PLATFORMS = new Set(["x", "facebook", "instagram"]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "heartbeat") {
    const { platform } = msg.payload;
    if (platform === "youtube") {
      const { platform: _p, ...hb } = msg.payload;
      enqueueYoutube(hb).then(() => sendResponse({ ok: true }));
    } else if (MEDIA_PLATFORMS.has(platform)) {
      // Keep `platform` in the payload — the /media endpoint needs it.
      enqueueMedia({ ...msg.payload }).then(() => sendResponse({ ok: true }));
    } else {
      const { platform: _p, ...hb } = msg.payload;
      enqueue(hb).then(() => sendResponse({ ok: true }));
    }
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, {
    periodInMinutes: FLUSH_INTERVAL_MINUTES,
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, {
    periodInMinutes: FLUSH_INTERVAL_MINUTES,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flush();
});
