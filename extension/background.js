// Service worker: receive heartbeats, queue them, batch-flush to API.

const QUEUE_KEY = "hb_queue";
const FLUSH_ALARM = "flush";
const FLUSH_INTERVAL_MINUTES = 1;
const MAX_QUEUE = 5000;

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

async function flush() {
  const { apiUrl, apiKey } = await getSettings();
  if (!apiUrl || !apiKey) return;

  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  if (queue.length === 0) return;

  // Take a snapshot — anything added during the request stays queued
  const batch = queue.slice(0, 500);

  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/heartbeats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ heartbeats: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Success — remove the flushed entries
    const { [QUEUE_KEY]: latest = [] } = await chrome.storage.local.get(QUEUE_KEY);
    await chrome.storage.local.set({ [QUEUE_KEY]: latest.slice(batch.length) });
  } catch (err) {
    console.warn("[twitch-watchtime] flush failed, will retry:", err.message);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "heartbeat") {
    enqueue(msg.payload).then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
  }
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
