// Generic dashboard for the additional video sources (x, facebook, instagram,
// plex). The platform is taken from the URL path (/x, /facebook, ...), and all
// data comes from /stats/media/{platform}/*.

const PLATFORM = (location.pathname.replace(/^\//, "").split("/")[0] || "x");

const PLATFORM_META = {
  x:         { label: "X", accent: "#1d9bf0", grad: "linear-gradient(135deg,#1d9bf0,#0f1419)" },
  facebook:  { label: "Facebook", accent: "#1877f2", grad: "linear-gradient(135deg,#1877f2,#0a2540)" },
  instagram: { label: "Instagram", accent: "#e1306c", grad: "linear-gradient(135deg,#feda75,#d62976,#962fbf)" },
  plex:      { label: "Plex", accent: "#e5a00d", grad: "linear-gradient(135deg,#e5a00d,#1a1a1a)" },
};
const META = PLATFORM_META[PLATFORM] || PLATFORM_META.x;

document.body.classList.add("media-page");
document.documentElement.style.setProperty("--media-accent", META.accent);
document.documentElement.style.setProperty("--media-grad", META.grad);
document.title = `${META.label} Watchtime`;
document.getElementById("page-title").textContent = `${META.label} Watchtime`;
document.getElementById("gate-title").textContent = `${META.label} Watchtime`;
// Mark the active nav link.
document.querySelectorAll(".topnav a[data-platform]").forEach((a) => {
  if (a.dataset.platform === PLATFORM) a.classList.add("active");
});

const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const ACCOUNT_KEY = `watchtime_media_account_${PLATFORM}`;
const WINDOW_PARAMS = { today: "today", last7days: "week", last30days: "month", alltime: "all" };
const WINDOW_LABELS = { today: "Today", week: "Last 7 Days", month: "Last 30 Days", all: "All-Time" };
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
const base = (suffix) => `/stats/media/${PLATFORM}/${suffix}`;

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
    await api(base("users"));
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadAccountPicker() {
  const { users } = await api(base("users"));
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
  const defaultUser = saved !== null ? saved : (users.length > 0 ? users[0].user : "");
  select.value = defaultUser;
  state.user = defaultUser || null;
}

$("account-picker").addEventListener("change", (e) => {
  state.user = e.target.value || null;
  localStorage.setItem(ACCOUNT_KEY, state.user ?? "");
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

const AVATAR_COLORS = ["#1d9bf0", "#1877f2", "#e1306c", "#e5a00d", "#9146FF", "#7B1FA2", "#f368e0", "#ff6b6b"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

async function updateHero() {
  const [todayData, allData, nowData] = await Promise.all([
    api(withUser(base("today"))),
    api(withUser(base("all"))),
    api(withUser(base("now"))),
  ]);

  const todaySecs = todayData.channels.reduce((s, c) => s + c.seconds, 0);
  $("today-value").textContent = fmtDuration(todaySecs);

  const top = todayData.channels[0];
  $("top-channel").textContent = top ? top.channel : "—";
  $("top-seconds").textContent = top ? fmtDuration(top.seconds) : "0 seconds";

  $("qs-total").textContent = fmtDuration(allData.channels.reduce((s, c) => s + c.seconds, 0));
  $("qs-channels").textContent = allData.channels.length.toString();

  if (nowData.channel) {
    $("live-indicator").classList.remove("hidden");
    $("live-label").textContent = nowData.media_user
      ? `${nowData.media_user}'s now watching`
      : "Now watching";
    $("live-channel").textContent = nowData.channel;
    $("live-title").textContent = nowData.title || "";
  } else {
    $("live-indicator").classList.add("hidden");
  }
}

function updateWindowLabels() {
  const label = WINDOW_LABELS[state.window] || "Today";
  $("top-channels-label").textContent = `Top accounts — ${label}`;
  $("top-videos-label").textContent = `Top videos — ${label}`;
}

async function updateTopChannels() {
  const data = await api(withUser(base(state.window)));
  const channels = data.channels.slice(0, 10);
  const max = channels[0]?.seconds || 1;
  const root = $("top-channels");
  root.innerHTML = "";
  channels.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(c.channel)}">${c.channel[0].toUpperCase()}<img src="/avatars/${PLATFORM}/${encodeURIComponent(c.channel)}" alt="" onerror="this.remove()"></div>
      <div class="name">${c.channel}</div>
      <div class="value mono">${fmtDuration(c.seconds)}</div>
      <div class="bar"><span style="width:${(c.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (channels.length === 0) root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
}

async function updateTopVideos() {
  const data = await api(withUser(base(`videos?window=${state.window}`)));
  const videos = data.videos.slice(0, 10);
  const max = videos[0]?.seconds || 1;
  const root = $("top-videos");
  root.innerHTML = "";
  videos.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(v.title)}">▶</div>
      <div class="name">${v.title}</div>
      <div class="value mono">${fmtDuration(v.seconds)}</div>
      <div class="bar"><span style="width:${(v.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (videos.length === 0) root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
}

let dailyChart = null;

async function updateDailyChart() {
  const data = await api(withUser(base("daily?days=30")));
  const labels = data.days.map(d => d.day.slice(5));
  const values = data.days.map(d => d.seconds / 3600);

  if (dailyChart) {
    dailyChart.data.labels = labels;
    dailyChart.data.datasets[0].data = values;
    dailyChart.update();
    return;
  }
  const ctx = $("daily-chart").getContext("2d");
  dailyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: META.accent, borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#adadb8", maxRotation: 0 }, grid: { display: false } },
        y: {
          ticks: { color: "#adadb8", callback: (v) => v + "h" },
          grid: { color: "#2f2f35" },
          beginAtZero: true,
        },
      },
    },
  });
}

async function updateLongestDay() {
  const data = await api(withUser(base("daily?days=365")));
  const longest = data.days.reduce((max, d) => (d.seconds > max ? d.seconds : max), 0);
  $("qs-longest").textContent = fmtDuration(longest);
}

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.window = pill.dataset.window;
    setWindowUrl(state.window);
    updateWindowLabels();
    updateTopChannels();
    updateTopVideos();
  });
});

async function refresh() {
  try {
    await Promise.all([
      updateHero(),
      updateTopChannels(),
      updateTopVideos(),
      updateDailyChart(),
      updateLongestDay(),
    ]);
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

async function boot() {
  await loadAccountPicker();
  applyWindowFromUrl();
  updateWindowLabels();
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
