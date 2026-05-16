const STORAGE_KEY = "watchtime_api_key";
const SCOREBOARD_MS = 30_000;
const PANEL_MS = 15_000;

const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  user: new URLSearchParams(location.search).get("user") || null,
  panelIdx: 0,
};

const $ = (id) => document.getElementById(id);

async function api(path) {
  const url = state.user
    ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(state.user)}`
    : path;
  const res = await fetch(url, { headers: { "X-API-Key": state.apiKey } });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(STORAGE_KEY);
    state.apiKey = null;
    showGate();
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showGate() {
  $("gate").classList.remove("hidden");
  $("tv-page").classList.add("hidden");
  $("gate-input").focus();
}
function hideGate() {
  $("gate").classList.add("hidden");
  $("tv-page").classList.remove("hidden");
}

$("gate-submit").addEventListener("click", async () => {
  const key = $("gate-input").value.trim();
  if (!key) return;
  state.apiKey = key;
  try {
    await api("/stats/total?window=today");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch { /* showGate already shown */ }
});
$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

function fmtDuration(seconds) {
  if (!seconds) return "0h 0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------- Default user selection ----------
async function pickDefaultUser() {
  if (state.user) return;  // explicit ?user=
  try {
    const { users } = await api("/stats/users");
    if (users.length > 0) state.user = users[0].user;
  } catch { /* ignore */ }
}

// ---------- Scoreboard ----------
async function updateScoreboard() {
  const [today, top, now] = await Promise.all([
    api("/stats/total?window=today"),
    api("/stats/top_channel?window=today"),
    api("/stats/now"),
  ]);
  $("tv-today").textContent = fmtDuration(today.seconds);
  $("tv-top").textContent = top.channel ? `${top.channel} — ${fmtDuration(top.seconds)}` : "—";
  if (now && now.channel) {
    $("tv-now").classList.remove("idle");
    $("tv-now-text").innerHTML = `<span style="color:var(--live)">●</span> ${now.channel}`;
  } else {
    $("tv-now").classList.add("idle");
    $("tv-now-text").textContent = "IDLE";
  }
}

async function boot() {
  await pickDefaultUser();
  await updateScoreboard();
  setInterval(updateScoreboard, SCOREBOARD_MS);
  startPanels();
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}

function startPanels() {
  // Implemented in Task 21
}
