const $ = (id) => document.getElementById(id);

const USER_FIELDS = [
  "twitchUser", "youtubeUser", "xUser",
  "facebookUser", "instagramUser", "plexUser",
];

async function load() {
  const stored = await chrome.storage.local.get([
    "apiUrl", "apiKey", "clientId", "hb_queue", "yt_queue", "media_queue",
    ...USER_FIELDS,
  ]);
  $("apiUrl").value = stored.apiUrl || "";
  $("apiKey").value = stored.apiKey || "";
  for (const f of USER_FIELDS) $(f).value = stored[f] || "";
  $("clientId").textContent = stored.clientId || "(not yet assigned)";
  $("queueLen").textContent = stored.hb_queue ? stored.hb_queue.length : 0;
  $("ytQueueLen").textContent = stored.yt_queue ? stored.yt_queue.length : 0;
}

async function refreshQueue() {
  const { hb_queue, yt_queue } = await chrome.storage.local.get(["hb_queue", "yt_queue"]);
  $("queueLen").textContent = hb_queue ? hb_queue.length : 0;
  $("ytQueueLen").textContent = yt_queue ? yt_queue.length : 0;
}

$("save").addEventListener("click", async () => {
  const updates = {
    apiUrl: $("apiUrl").value.trim().replace(/\/$/, ""),
    apiKey: $("apiKey").value.trim(),
  };
  for (const f of USER_FIELDS) updates[f] = $(f).value.trim().toLowerCase();
  await chrome.storage.local.set(updates);
  const msg = $("statusMsg");
  msg.textContent = "Saved.";
  msg.className = "status-msg";
  setTimeout(() => { msg.textContent = ""; }, 2000);
});

load();
setInterval(refreshQueue, 10_000);
