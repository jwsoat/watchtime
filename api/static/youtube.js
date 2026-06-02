const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const YT_ACCOUNT_KEY = "watchtime_yt_account";
const WINDOW_PARAMS = { today: "today", last7days: "week", last30days: "month", alltime: "all" };
const WINDOW_TO_PARAM = Object.fromEntries(
  Object.entries(WINDOW_PARAMS).map(([k, v]) => [v, k])
);

const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  user: null,
  window: "today",
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path, { headers: { "X-API-Key": state.apiKey } });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(STORAGE_KEY);
    state.apiKey = null;
    showGate("Invalid API key.");
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function withUser(url) {
  if (!state.user) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}user=${encodeURIComponent(state.user)}`;
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
    await api("/stats/youtube/users");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadAccountPicker() {
  const { users } = await api("/stats/youtube/users");
  const select = $("account-picker");
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All accounts";
  select.appendChild(all);
  for (const u of users) {
    const opt = document.createElement("option");
    opt.value = u.user;
    opt.textContent = `Viewing: ${u.user}`;
    select.appendChild(opt);
  }
  const saved = localStorage.getItem(YT_ACCOUNT_KEY);
  const defaultUser = saved !== null ? saved : (users.length > 0 ? users[0].user : "");
  select.value = defaultUser;
  state.user = defaultUser || null;
}

$("account-picker").addEventListener("change", (e) => {
  state.user = e.target.value || null;
  localStorage.setItem(YT_ACCOUNT_KEY, state.user ?? "");
  refresh();
});

function applyWindowFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, win] of Object.entries(WINDOW_PARAMS)) {
    if (params.has(key)) {
      state.window = win;
      document.querySelectorAll(".pill").forEach(p =>
        p.classList.toggle("active", p.dataset.window === win));
      break;
    }
  }
}

function setWindowUrl(win) {
  const key = WINDOW_TO_PARAM[win];
  if (!key) return;
  history.replaceState(null, "", `?${key}`);
}

function fmtDuration(seconds) {
  if (!seconds) return "0 seconds";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (h > 0) return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
  if (m > 0) return s === 0 ? plural(m, "minute") : `${plural(m, "minute")} ${plural(s, "second")}`;
  return plural(s, "second");
}

const AVATAR_COLORS = ["#FF4444", "#FF8C00", "#FFD700", "#48dbfb", "#1dd1a1", "#f368e0", "#5f27cd", "#ff6b6b"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

async function updateTopChannels() {
  const data = await api(withUser(`/stats/youtube/${state.window}`));
  const channels = data.channels.slice(0, 10);
  const max = channels[0]?.seconds || 1;
  const root = $("top-channels");
  root.innerHTML = "";
  channels.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(c.channel)}">${c.channel[0].toUpperCase()}</div>
      <div class="name">${c.channel}</div>
      <div class="value mono">${fmtDuration(c.seconds)}</div>
      <div class="bar"><span style="width:${(c.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (channels.length === 0) root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
}

async function updateTopPlaylists() {
  const data = await api(withUser(`/stats/youtube/playlists?window=${state.window}`));
  const playlists = data.playlists.slice(0, 10);
  const max = playlists[0]?.seconds || 1;
  const root = $("top-playlists");
  root.innerHTML = "";
  playlists.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(p.playlist_id)}">${p.playlist_id[0].toUpperCase()}</div>
      <div class="name">${p.playlist_id}</div>
      <div class="value mono">${fmtDuration(p.seconds)}</div>
      <div class="bar"><span style="width:${(p.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (playlists.length === 0) root.innerHTML = '<div style="color:var(--muted)">No playlist data yet.</div>';
}

async function updateHero() {
  const [todayData, allData] = await Promise.all([
    api(withUser("/stats/youtube/today")),
    api(withUser("/stats/youtube/all")),
  ]);
  const todaySecs = todayData.channels.reduce((s, c) => s + c.seconds, 0);
  $("today-value").textContent = fmtDuration(todaySecs);
  const top = todayData.channels[0];
  $("top-channel").textContent = top ? top.channel : "—";
  $("top-seconds").textContent = top ? fmtDuration(top.seconds) : "0 seconds";
  $("qs-total").textContent = fmtDuration(allData.channels.reduce((s, c) => s + c.seconds, 0));
  $("qs-channels").textContent = allData.channels.length.toString();
}

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.window = pill.dataset.window;
    setWindowUrl(state.window);
    updateTopChannels();
    updateTopPlaylists();
  });
});

async function refresh() {
  try {
    await Promise.all([updateHero(), updateTopChannels(), updateTopPlaylists()]);
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

async function boot() {
  await loadAccountPicker();
  applyWindowFromUrl();
  await refresh();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, POLL_MS);
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
