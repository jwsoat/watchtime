const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const TW_ACCOUNT_KEY = "watchtime_account";
const YT_ACCOUNT_KEY = "watchtime_yt_account";
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

// ---------- Account pickers ----------

async function loadPickers() {
  const [{ users: twUsers }, { users: ytUsers }] = await Promise.all([
    api("/stats/users"),
    api("/stats/youtube/users"),
  ]);

  const twSelect = $("twitch-picker");
  twSelect.innerHTML = "";
  const twAll = document.createElement("option");
  twAll.value = "";
  twAll.textContent = "All Twitch accounts";
  twSelect.appendChild(twAll);
  for (const u of twUsers) {
    const opt = document.createElement("option");
    opt.value = u.user;
    opt.textContent = `Twitch: ${u.user}`;
    twSelect.appendChild(opt);
  }
  const savedTw = localStorage.getItem(TW_ACCOUNT_KEY);
  if (savedTw && twUsers.find(u => u.user === savedTw)) {
    twSelect.value = savedTw;
    state.twUser = savedTw;
  }

  const ytSelect = $("youtube-picker");
  ytSelect.innerHTML = "";
  const ytAll = document.createElement("option");
  ytAll.value = "";
  ytAll.textContent = "All YouTube accounts";
  ytSelect.appendChild(ytAll);
  for (const u of ytUsers) {
    const opt = document.createElement("option");
    opt.value = u.user;
    opt.textContent = `YouTube: ${u.user}`;
    ytSelect.appendChild(opt);
  }
  const savedYt = localStorage.getItem(YT_ACCOUNT_KEY);
  if (savedYt && ytUsers.find(u => u.user === savedYt)) {
    ytSelect.value = savedYt;
    state.ytUser = savedYt;
  }
}

$("twitch-picker").addEventListener("change", (e) => {
  state.twUser = e.target.value || null;
  localStorage.setItem(TW_ACCOUNT_KEY, state.twUser ?? "");
  refresh();
});

$("youtube-picker").addEventListener("change", (e) => {
  state.ytUser = e.target.value || null;
  localStorage.setItem(YT_ACCOUNT_KEY, state.ytUser ?? "");
  refresh();
});

// ---------- Window ----------

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

// ---------- Formatters ----------

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

// ---------- Merge ----------

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
  const twParam = state.twUser ? `?user=${encodeURIComponent(state.twUser)}` : "";
  const ytParam = state.ytUser ? `?user=${encodeURIComponent(state.ytUser)}` : "";

  const [twData, ytData, linksData] = await Promise.all([
    api(`/stats/${state.window}${twParam}`),
    api(`/stats/youtube/${state.window}${ytParam}`),
    api("/settings/channel-links"),
  ]);

  const rows = buildMergedRows(twData.channels, ytData.channels, linksData.links);
  const max = rows[0]?.seconds || 1;
  const root = $("merged-channels");
  root.innerHTML = "";

  rows.forEach((row, i) => {
    const badges = row.platforms.map(p =>
      `<span class="platform-badge ${p}">${p === "twitch" ? "TW" : "YT"}</span>`
    ).join(" ");
    const el = document.createElement("div");
    el.className = "ranked-row";
    el.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(row.avatar)}">${row.avatar[0].toUpperCase()}</div>
      <div class="name">${row.label} ${badges}</div>
      <div class="value mono">${fmtDuration(row.seconds)}</div>
      <div class="bar"><span style="width:${(row.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(el);
  });

  if (rows.length === 0) {
    root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
  }
}

// ---------- Refresh ----------

async function refresh() {
  try {
    await updateMerged();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

// ---------- Boot ----------

async function boot() {
  await loadPickers();
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
