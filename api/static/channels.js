// ---------- Constants ----------
const STORAGE_KEY = "watchtime_api_key";
const ACCOUNT_KEY = "watchtime_account";

const WINDOW_LABELS = { today: "Today", week: "Last 7 Days", month: "Last 30 Days", all: "All-Time" };
const WINDOWS = Object.keys(WINDOW_LABELS);

// ---------- State ----------
const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  user: null,         // selected account login, or null = all accounts
  window: "today",    // 'today' | 'week' | 'month' | 'all'
  limit: 50,          // 50 | 100 | 200 | 250 | 'all'
  platform: "twitch", // 'twitch' | 'youtube' | 'merged'
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

// ---------- URL params ----------
// /channels?platform=twitch&window=week&limit=100 [&user=login]
function applyStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const p = params.get("platform");
  if (p === "youtube" || p === "merged" || p === "twitch") state.platform = p;
  const w = params.get("window");
  if (WINDOWS.includes(w)) state.window = w;
  const l = params.get("limit");
  if (l === "all" || ["50", "100", "200", "250"].includes(l)) state.limit = l;
  const u = params.get("user");
  if (u) state.user = u;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.platform !== "twitch") params.set("platform", state.platform);
  if (state.window !== "today") params.set("window", state.window);
  if (state.limit !== 50) params.set("limit", String(state.limit));
  if (state.user) params.set("user", state.user);
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : "?");
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
    await api(usersEndpoint());
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
function usersEndpoint() {
  if (state.platform === "youtube") return "/stats/youtube/users";
  // Merged endpoints resolve a user_accounts *label* server-side, not a
  // login — sending a twitch login there 404s ("Merged account not found").
  if (state.platform === "merged") return "/settings/user-accounts";
  return "/stats/users";
}

function statsEndpoint() {
  if (state.platform === "youtube") return `/stats/youtube/${state.window}`;
  if (state.platform === "merged") return `/stats/merged/channels?window=${state.window}`;
  return `/stats/${state.window}`;
}

async function loadAccountPicker() {
  const data = await api(usersEndpoint());
  // /stats/* return {users:[{user,...}]}; /settings/user-accounts returns
  // {accounts:[{label,...}]} — merged filters by label.
  const users = data.users ||
    (data.accounts || []).map(a => ({ user: a.label })).filter(u => u.user);
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

  select.value = state.user || "";
  if (state.user && select.value !== state.user) {
    // requested user isn't in the list; fall back to all accounts
    state.user = null;
    syncUrl();
  }
}

$("account-picker").addEventListener("change", (e) => {
  state.user = e.target.value || null;
  localStorage.setItem(ACCOUNT_KEY, state.user ?? "");
  syncUrl();
  refresh();
});

// ---------- Formatters ----------
function fmtDuration(seconds) {
  if (!seconds) return "0 seconds";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (h > 0) {
    return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
  }
  if (m > 0) {
    return s === 0 ? plural(m, "minute") : `${plural(m, "minute")} ${plural(s, "second")}`;
  }
  return plural(s, "second");
}

// ---------- Rendering ----------
const AVATAR_COLORS = ["#9146FF", "#00f5d4", "#ff6b6b", "#feca57", "#5f27cd", "#48dbfb", "#1dd1a1", "#f368e0"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function limitLabel() {
  return state.limit === "all" ? "All" : state.limit;
}

function updateLabels() {
  document.title = `Top ${limitLabel()} channels — ${WINDOW_LABELS[state.window]}`;
  $("page-title").textContent = `Top channels — ${WINDOW_LABELS[state.window]}`;
  $("list-label").textContent = `Top ${limitLabel()} — ${WINDOW_LABELS[state.window]}`;
}

function setActiveControls() {
  document.querySelectorAll(".pill[data-window]").forEach(p =>
    p.classList.toggle("active", p.dataset.window === state.window));
  document.querySelectorAll(".pill.length").forEach(p =>
    p.classList.toggle("active", String(p.dataset.limit) === String(state.limit)));
}

async function refresh() {
  setActiveControls();
  updateLabels();
  try {
    const data = await api(withUser(statsEndpoint()));
    const rows = state.platform === "merged" ? data.rows : data.channels;
    const list = state.limit === "all" ? rows : rows.slice(0, Number(state.limit));
    const max = list[0]?.seconds || 1;
    const root = $("channels");
    root.innerHTML = "";
    if (list.length === 0) {
      root.innerHTML = '<div style="color:var(--muted)">Nothing watched in this range.</div>';
      return;
    }
    list.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "ranked-row";
      let avatarImg = "";
      let name = c.channel;
      if (state.platform === "merged") {
        const primary = c.primary;
        avatarImg = `<img src="/avatars/${primary.platform}/${encodeURIComponent(primary.channel)}" alt="" onerror="this.remove()">`;
        const badges = c.platforms.map(p =>
          `<span class="platform-badge ${p}">${(PLATFORM_BADGES[p] || p.toUpperCase())}</span>`
        ).join(" ");
        name = `${c.label} ${badges}`;
      } else {
        const host = state.platform === "youtube" ? "youtube" : "twitch";
        avatarImg = `<img src="/avatars/${host}/${encodeURIComponent(c.channel)}" alt="" onerror="this.remove()">`;
      }
      row.innerHTML = `
        <div class="rank mono">#${i + 1}</div>
        <div class="avatar" style="background:${avatarColor(c.channel || c.label)}">${(c.channel || c.label)[0].toUpperCase()}${avatarImg}</div>
        <div class="name">${name}</div>
        <div class="value mono">${fmtDuration(c.seconds)}</div>
        <div class="bar"><span style="width:${(c.seconds / max * 100).toFixed(1)}%"></span></div>
      `;
      root.appendChild(row);
    });
  } catch (e) {
    console.warn("refresh failed", e);
    $("channels").innerHTML =
      '<div style="color:var(--muted)">Failed to load — check the console and try again.</div>';
  }
}

const PLATFORM_BADGES = {
  twitch: "TW", youtube: "YT", x: "X",
  facebook: "FB", instagram: "IG", plex: "PLEX", tiktok: "TT",
  "mobile-android": "DROID",
};

// ---------- Controls ----------
document.querySelectorAll(".pill[data-window]").forEach((pill) => {
  pill.addEventListener("click", () => {
    state.window = pill.dataset.window;
    syncUrl();
    refresh();
  });
});

document.querySelectorAll(".pill.length").forEach((pill) => {
  pill.addEventListener("click", () => {
    state.limit = pill.dataset.limit === "all" ? "all" : Number(pill.dataset.limit);
    syncUrl();
    refresh();
  });
});

// ---------- Boot ----------
async function boot() {
  applyStateFromUrl();
  document.body.classList.toggle("yt-page", state.platform === "youtube");
  await loadAccountPicker();
  await refresh();
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
