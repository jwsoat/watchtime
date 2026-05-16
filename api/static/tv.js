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

// ---------- Panels ----------
let tvDailyChart = null;

const AVATAR_COLORS = ["#9146FF", "#00f5d4", "#ff6b6b", "#feca57", "#5f27cd", "#48dbfb", "#1dd1a1", "#f368e0"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function renderRankedList(rootId, items, valueFn, labelFn, kind = "channel") {
  const root = $(rootId);
  root.innerHTML = "";
  const max = items[0] ? valueFn(items[0]) : 1;
  items.forEach((it, i) => {
    const seconds = valueFn(it);
    const label = labelFn(it);
    const initial = label[0].toUpperCase();
    const avatarInner = kind === "channel"
      ? `${initial}<img src="https://unavatar.io/twitch/${encodeURIComponent(label)}" alt="" loading="lazy" onerror="this.remove()">`
      : initial;
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(label)}">${avatarInner}</div>
      <div class="name">${label}</div>
      <div class="value mono">${fmtDuration(seconds)}</div>
      <div class="bar"><span style="width:${(seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (items.length === 0) {
    root.innerHTML = '<div style="color:var(--muted);font-size:24px;">No data yet.</div>';
  }
}

async function loadPanel0() {
  const data = await api("/stats/week");
  renderRankedList(
    "tv-week-channels",
    data.channels.slice(0, 5),
    (c) => c.seconds,
    (c) => c.channel,
  );
}

async function loadPanel1() {
  const data = await api("/stats/daily?days=14");
  const labels = data.days.map(d => d.day.slice(5));
  const values = data.days.map(d => d.seconds / 3600);
  const ctx = $("tv-daily").getContext("2d");
  if (tvDailyChart) {
    tvDailyChart.data.labels = labels;
    tvDailyChart.data.datasets[0].data = values;
    tvDailyChart.update();
    return;
  }
  tvDailyChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: "#9146FF", borderRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#efeff1", font: { size: 16 }, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: "#efeff1", font: { size: 16 }, callback: (v) => v + "h" }, grid: { color: "#2f2f35" }, beginAtZero: true },
      },
    },
  });
}

async function loadPanel2() {
  const data = await api("/stats/all");
  renderRankedList(
    "tv-all-channels",
    data.channels.slice(0, 10),
    (c) => c.seconds,
    (c) => c.channel,
  );
}

async function loadPanel3() {
  const data = await api("/stats/categories?window=week");
  renderRankedList(
    "tv-categories",
    data.categories.slice(0, 5),
    (c) => c.seconds,
    (c) => c.category,
    "category",
  );
}

const PANEL_LOADERS = [loadPanel0, loadPanel1, loadPanel2, loadPanel3];

function showPanel(idx) {
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", parseInt(p.dataset.idx) === idx);
  });
  document.querySelectorAll(".dots span").forEach((d, i) => {
    d.classList.toggle("active", i === idx);
  });
  PANEL_LOADERS[idx]().catch((e) => console.warn(`panel ${idx} failed`, e));
}

function startPanels() {
  showPanel(0);
  setInterval(() => {
    state.panelIdx = (state.panelIdx + 1) % 4;
    showPanel(state.panelIdx);
  }, PANEL_MS);
}

// ---------- Cursor auto-hide ----------
let cursorTimer = null;
function showCursor() {
  document.body.style.cursor = "auto";
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => { document.body.style.cursor = "none"; }, 3000);
}
document.addEventListener("mousemove", showCursor);
showCursor();
