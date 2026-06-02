const STORAGE_KEY = "watchtime_api_key";
const $ = (id) => document.getElementById(id);
const state = { apiKey: localStorage.getItem(STORAGE_KEY) || null };

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function apiReq(method, path, body) {
  const opts = {
    method,
    headers: { "X-API-Key": state.apiKey, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(STORAGE_KEY);
    state.apiKey = null;
    showGate("Invalid API key.");
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showGate(errMsg = "") {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("gate-err").textContent = errMsg;
  $("gate-input").value = "";
  $("gate-input").focus();
}

function hideGate() {
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("gate-submit").addEventListener("click", async () => {
  const key = $("gate-input").value.trim();
  if (!key) return;
  state.apiKey = key;
  try {
    await apiReq("GET", "/settings/channel-links");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadLinks() {
  const { links } = await apiReq("GET", "/settings/channel-links");
  const tbody = $("links-tbody");
  if (!links.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted); padding:12px 0">No links yet.</td></tr>';
    return;
  }
  tbody.innerHTML = links.map(l => `
    <tr>
      <td>${escapeHtml(l.twitch_channel)}</td>
      <td>${escapeHtml(l.youtube_channel)}</td>
      <td><button class="del-btn" data-id="${l.id}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/channel-links/${btn.dataset.id}`);
      loadLinks().catch(console.error);
    });
  });
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const twitch = $("input-twitch").value.trim().toLowerCase();
  const youtube = $("input-youtube").value.trim().toLowerCase();
  if (!twitch || !youtube) return;
  await apiReq("POST", "/settings/channel-links", {
    twitch_channel: twitch,
    youtube_channel: youtube,
  });
  $("input-twitch").value = "";
  $("input-youtube").value = "";
  loadLinks().catch(console.error);
});

async function boot() {
  await loadLinks();
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
