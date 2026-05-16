async function load() {
  const { apiUrl, apiKey, clientId, hb_queue } = await chrome.storage.local.get(
    ["apiUrl", "apiKey", "clientId", "hb_queue"]
  );
  document.getElementById("apiUrl").value = apiUrl || "";
  document.getElementById("apiKey").value = apiKey || "";
  document.getElementById("clientId").textContent = clientId || "(not yet assigned)";
  document.getElementById("queueLen").textContent =
    hb_queue ? hb_queue.length : 0;
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiUrl: document.getElementById("apiUrl").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim(),
  });
  alert("Saved.");
});

load();
