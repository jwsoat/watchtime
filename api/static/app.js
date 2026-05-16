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

// ---------- Refresh (filled in by later tasks) ----------
async function refresh() {
  // Implemented incrementally in Tasks 16-19.
}

// ---------- Init ----------
if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
