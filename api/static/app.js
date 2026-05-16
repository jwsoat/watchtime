// ---------- Constants ----------
const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const ACCOUNT_KEY = "watchtime_account";

// ---------- State ----------
const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  user: null,         // selected account login, or null = all accounts
  window: "today",    // 'today' | 'week' | 'all'
  pollTimer: null,
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

// ---------- API helper ----------
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

function userParam() {
  return state.user ? `?user=${encodeURIComponent(state.user)}` : "";
}

function withUser(url) {
  if (!state.user) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}user=${encodeURIComponent(state.user)}`;
}

// ---------- Auth gate ----------
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
    await api("/stats/users");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {
    // showGate already invoked by api() on 401/403
  }
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

// ---------- Account picker ----------
async function loadAccountPicker() {
  const { users } = await api("/stats/users");
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

  const saved = localStorage.getItem(ACCOUNT_KEY);
  const defaultUser = saved !== null
    ? saved
    : (users.length > 0 ? users[0].user : "");
  select.value = defaultUser;
  state.user = defaultUser || null;
}

$("account-picker").addEventListener("change", (e) => {
  state.user = e.target.value || null;
  localStorage.setItem(ACCOUNT_KEY, state.user ?? "");
  refresh();
});

// ---------- Boot ----------
async function boot() {
  await loadAccountPicker();
  await refresh();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, POLL_MS);
}

// ---------- Formatters ----------
function fmtDuration(seconds) {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtRelative(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ---------- Hero ----------
async function updateHero() {
  const [todayTotal, topToday, now] = await Promise.all([
    api(withUser("/stats/total?window=today")),
    api(withUser("/stats/top_channel?window=today")),
    api(withUser("/stats/now")),
  ]);
  $("today-value").textContent = fmtDuration(todayTotal.seconds);
  $("top-channel").textContent = topToday.channel || "—";
  $("top-seconds").textContent = fmtDuration(topToday.seconds);

  if (now && now.channel) {
    $("live-indicator").classList.remove("hidden");
    $("live-channel").textContent = now.channel;
  } else {
    $("live-indicator").classList.add("hidden");
  }
}

// ---------- Pills ----------
document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.window = pill.dataset.window;
    updateTopChannels();
  });
});

// ---------- Top channels ----------
const AVATAR_COLORS = ["#9146FF", "#00f5d4", "#ff6b6b", "#feca57", "#5f27cd", "#48dbfb", "#1dd1a1", "#f368e0"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

async function updateTopChannels() {
  const data = await api(withUser(`/stats/${state.window}`));
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
  if (channels.length === 0) {
    root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
  }
}

// ---------- Refresh ----------
async function refresh() {
  try {
    await Promise.all([
      updateHero(),
      updateTopChannels(),
    ]);
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

// ---------- Init ----------
if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
