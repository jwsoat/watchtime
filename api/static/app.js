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
    select.appendChild(opt);
  }

  const saved = localStorage.getItem(ACCOUNT_KEY);
  if (saved && accounts.find(a => String(a.id) === saved)) {
    select.value = saved;
    const opt = select.options[select.selectedIndex];
    state.twUser = opt.dataset.twitchUser || null;
    state.ytUser = opt.dataset.youtubeUser || null;
  } else {
    state.twUser = null;
    state.ytUser = null;
  }
}

$("account-picker").addEventListener("change", (e) => {
  const opt = e.target.options[e.target.selectedIndex];
  if (e.target.value === "") {
    state.twUser = null;
    state.ytUser = null;
    localStorage.removeItem(ACCOUNT_KEY);
  } else {
    state.twUser = opt.dataset.twitchUser || null;
    state.ytUser = opt.dataset.youtubeUser || null;
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
  const [twToday, ytToday, twNow, ytNow] = await Promise.all([
    api(withTwUser("/stats/today")),
    api(withYtUser("/stats/youtube/today")),
    api(withTwUser("/stats/now")),
    api(withYtUser("/stats/youtube/now")),
  ]);

  const twSecs = twToday.channels.reduce((s, c) => s + c.seconds, 0);
  const ytSecs = ytToday.channels.reduce((s, c) => s + c.seconds, 0);
  $("today-value").textContent = fmtDuration(twSecs + ytSecs);

  const allToday = [
    ...twToday.channels.map(c => ({ ...c, platform: "twitch" })),
    ...ytToday.channels.map(c => ({ ...c, platform: "youtube" })),
  ].sort((a, b) => b.seconds - a.seconds);
  const top = allToday[0];
  $("top-channel").textContent = top ? top.channel : "—";
  $("top-seconds").textContent = top ? fmtDuration(top.seconds) : "0 seconds";

  const now = twNow.channel ? twNow : (ytNow.channel ? ytNow : null);
  if (now) {
    $("live-indicator").classList.remove("hidden");
    const who = now.twitch_user || now.youtube_user;
    $("live-label").textContent = who ? `${who}'s now watching` : "Now watching";
    $("live-channel").textContent = now.channel;
    $("live-title").textContent = now.title || "";
    $("live-category").textContent = now.category || "";
  } else {
    $("live-indicator").classList.add("hidden");
  }
}

async function updateQuickStats() {
  const [twAll, ytAll, twDaily, ytDaily] = await Promise.all([
    api(withTwUser("/stats/all")),
    api(withYtUser("/stats/youtube/all")),
    api(withTwUser("/stats/daily?days=365")),
    api(withYtUser("/stats/youtube/daily?days=365")),
  ]);

  const totalSecs =
    twAll.channels.reduce((s, c) => s + c.seconds, 0) +
    ytAll.channels.reduce((s, c) => s + c.seconds, 0);
  $("qs-total").textContent = fmtDuration(totalSecs);

  const allChannels = new Set([
    ...twAll.channels.map(c => c.channel),
    ...ytAll.channels.map(c => c.channel),
  ]);
  $("qs-channels").textContent = allChannels.size.toString();

  const dayMap = {};
  for (const d of twDaily.days) dayMap[d.day] = (dayMap[d.day] || 0) + d.seconds;
  for (const d of ytDaily.days) dayMap[d.day] = (dayMap[d.day] || 0) + d.seconds;
  const longest = Object.values(dayMap).reduce((max, s) => (s > max ? s : max), 0);
  $("qs-longest").textContent = fmtDuration(longest);
}

let dailyChart = null;

async function updateDailyChart() {
  const [twDaily, ytDaily] = await Promise.all([
    api(withTwUser("/stats/daily?days=30")),
    api(withYtUser("/stats/youtube/daily?days=30")),
  ]);

  const dayMap = {};
  for (const d of twDaily.days) dayMap[d.day] = (dayMap[d.day] || 0) + d.seconds;
  for (const d of ytDaily.days) dayMap[d.day] = (dayMap[d.day] || 0) + d.seconds;
  const days = Object.keys(dayMap).sort();
  const labels = days.map(d => d.slice(5));
  const values = days.map(d => dayMap[d] / 3600);

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

function buildMergedRows(twChannels, ytChannels, links) {
  const linkMap = {};
  for (const l of links) {
    if (!linkMap[l.twitch_channel]) linkMap[l.twitch_channel] = [];
    linkMap[l.twitch_channel].push(l.youtube_channel);
  }

  const usedYt = new Set();
  const rows = [];

  for (const t of twChannels) {
    const linked = linkMap[t.channel] || [];
    let ytSeconds = 0;
    const ytNames = [];
    for (const ytCh of linked) {
      const ytRow = ytChannels.find(y => y.channel === ytCh);
      if (ytRow) {
        ytSeconds += ytRow.seconds;
        ytNames.push(ytCh);
        usedYt.add(ytCh);
      }
    }
    rows.push({
      label: ytNames.length ? `${t.channel} / ${ytNames.join(", ")}` : t.channel,
      seconds: t.seconds + ytSeconds,
      platforms: ytNames.length ? ["twitch", "youtube"] : ["twitch"],
      avatar: t.channel,
    });
  }

  for (const y of ytChannels) {
    if (!usedYt.has(y.channel)) {
      rows.push({
        label: y.channel,
        seconds: y.seconds,
        platforms: ["youtube"],
        avatar: y.channel,
      });
    }
  }

  rows.sort((a, b) => b.seconds - a.seconds);
  return rows;
}

async function updateMerged() {
  const [twData, ytData, linksData] = await Promise.all([
    api(withTwUser(`/stats/${state.window}`)),
    api(withYtUser(`/stats/youtube/${state.window}`)),
    api("/settings/channel-links"),
  ]);

  const rows = buildMergedRows(twData.channels, ytData.channels, linksData.links);
  const max = rows[0]?.seconds || 1;
  const leftRoot = $("merged-left");
  const rightRoot = $("merged-right");
  leftRoot.innerHTML = "";
  rightRoot.innerHTML = "";

  rows.slice(0, 40).forEach((row, i) => {
    const rank = i + 1;
    const badges = row.platforms.map(p =>
      `<span class="platform-badge ${p}">${p === "twitch" ? "TW" : "YT"}</span>`
    ).join(" ");
    const el = document.createElement("div");
    el.className = "ranked-row";
    el.innerHTML = `
      <div class="rank mono">#${rank}</div>
      <div class="avatar" style="background:${avatarColor(row.avatar)}">${row.avatar[0].toUpperCase()}<img src="/avatars/${row.platforms[0]}/${encodeURIComponent(row.avatar)}" alt="" onerror="this.remove()"></div>
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
