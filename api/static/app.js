const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const ACCOUNT_KEY = "watchtime_merged_account";
const WINDOW_PARAMS = { today: "today", last7days: "week", last30days: "month", alltime: "all" };
const WINDOW_TO_PARAM = Object.fromEntries(
  Object.entries(WINDOW_PARAMS).map(([k, v]) => [v, k])
);

const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  twUser: null,
  ytUser: null,
  accountLabel: null,
  window: "today",
  pollTimer: null,
};

const PLATFORM_BADGE = {
  twitch: "TW", youtube: "YT", x: "X",
  facebook: "FB", instagram: "IG", plex: "PLEX",
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

function withTwUser(url) {
  if (!state.twUser) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}user=${encodeURIComponent(state.twUser)}`;
}

function withYtUser(url) {
  if (!state.ytUser) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}user=${encodeURIComponent(state.ytUser)}`;
}

// Merged endpoints resolve a user_accounts *label* server-side.
function withMergedUser(url) {
  if (!state.accountLabel) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}user=${encodeURIComponent(state.accountLabel)}`;
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
    await api("/stats/users");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadAccountPicker() {
  const { accounts } = await api("/settings/user-accounts");
  const select = $("account-picker");
  select.innerHTML = "";

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All accounts";
  select.appendChild(all);

  for (const a of accounts) {
    const platforms = [];
    if (a.twitch_user) platforms.push("Twitch");
    if (a.youtube_user) platforms.push("YouTube");
    const opt = document.createElement("option");
    opt.value = String(a.id);
    opt.textContent = `${a.label} (${platforms.join("+")})`;
    opt.dataset.twitchUser = a.twitch_user || "";
    opt.dataset.youtubeUser = a.youtube_user || "";
    opt.dataset.label = a.label;
    select.appendChild(opt);
  }

  const saved = localStorage.getItem(ACCOUNT_KEY);
  if (saved && accounts.find(a => String(a.id) === saved)) {
    select.value = saved;
    const opt = select.options[select.selectedIndex];
    state.twUser = opt.dataset.twitchUser || null;
    state.ytUser = opt.dataset.youtubeUser || null;
    state.accountLabel = opt.dataset.label || null;
  } else {
    state.twUser = null;
    state.ytUser = null;
    state.accountLabel = null;
  }
}

$("account-picker").addEventListener("change", (e) => {
  const opt = e.target.options[e.target.selectedIndex];
  if (e.target.value === "") {
    state.twUser = null;
    state.ytUser = null;
    state.accountLabel = null;
    localStorage.removeItem(ACCOUNT_KEY);
  } else {
    state.twUser = opt.dataset.twitchUser || null;
    state.ytUser = opt.dataset.youtubeUser || null;
    state.accountLabel = opt.dataset.label || null;
    localStorage.setItem(ACCOUNT_KEY, e.target.value);
  }
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

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.window = pill.dataset.window;
    setWindowUrl(state.window);
    updateMerged();
  });
});

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

const AVATAR_COLORS = ["#9146FF", "#FF4444", "#00f5d4", "#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#f368e0"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

async function updateHero() {
  const [today, now] = await Promise.all([
    api(withMergedUser("/stats/merged/channels?window=today")),
    api(withMergedUser("/stats/now?platform=merged")),
  ]);

  $("today-value").textContent = fmtDuration(today.total_seconds);

  const top = today.rows[0];
  $("top-channel").textContent = top ? top.label : "—";
  $("top-seconds").textContent = top ? fmtDuration(top.seconds) : "0 seconds";

  if (now && now.channel) {
    $("live-indicator").classList.remove("hidden");
    const who = now.twitch_user;
    $("live-label").textContent = who ? `${who}'s now watching` : "Now watching";
    $("live-channel").textContent = now.display_name || now.channel;
    $("live-title").textContent = now.title || "";
    $("live-category").textContent = now.category || "";
  } else {
    $("live-indicator").classList.add("hidden");
  }
}

async function updateQuickStats() {
  const [all, daily] = await Promise.all([
    api(withMergedUser("/stats/merged/channels?window=all")),
    api(withMergedUser("/stats/merged/daily?days=365")),
  ]);

  $("qs-total").textContent = fmtDuration(all.total_seconds);
  $("qs-channels").textContent = all.rows.length.toString();

  const longest = daily.days.reduce((max, d) => (d.seconds > max ? d.seconds : max), 0);
  $("qs-longest").textContent = fmtDuration(longest);
}

let dailyChart = null;

async function updateDailyChart() {
  const daily = await api(withMergedUser("/stats/merged/daily?days=30"));
  const labels = daily.days.map(d => d.day.slice(5));
  const values = daily.days.map(d => d.seconds / 3600);

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
      datasets: [{ data: values, backgroundColor: "#9146FF", borderRadius: 4 }],
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

async function updateMerged() {
  const data = await api(withMergedUser(`/stats/merged/channels?window=${state.window}`));
  const rows = data.rows;
  const max = rows[0]?.seconds || 1;
  const leftRoot = $("merged-left");
  const rightRoot = $("merged-right");
  leftRoot.innerHTML = "";
  rightRoot.innerHTML = "";

  rows.slice(0, 40).forEach((row, i) => {
    const rank = i + 1;
    const badges = row.platforms.map(p =>
      `<span class="platform-badge ${p}">${PLATFORM_BADGE[p] || p.toUpperCase()}</span>`
    ).join(" ");
    const primary = row.primary;
    const el = document.createElement("div");
    el.className = "ranked-row";
    el.innerHTML = `
      <div class="rank mono">#${rank}</div>
      <div class="avatar" style="background:${avatarColor(row.label)}">${row.label[0].toUpperCase()}<img src="/avatars/${primary.platform}/${encodeURIComponent(primary.channel)}" alt="" onerror="this.remove()"></div>
      <div class="name">${row.label} ${badges}</div>
      <div class="value mono">${fmtDuration(row.seconds)}</div>
      <div class="bar"><span style="width:${(row.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    (rank <= 20 ? leftRoot : rightRoot).appendChild(el);
  });

  if (!rows.length) {
    leftRoot.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
    rightRoot.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
  }
}

async function refresh() {
  try {
    await Promise.all([
      updateHero(),
      updateMerged(),
      updateDailyChart(),
      updateQuickStats(),
    ]);
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
