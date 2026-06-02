const STORAGE_KEY = "watchtime_api_key";
const $ = (id) => document.getElementById(id);
const state = { apiKey: localStorage.getItem(STORAGE_KEY) || null };

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function apiReq(method, path, body) {
  const opts = {
    method,
    headers: { "X-API-Key": state.apiKey, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
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
    await apiReq("GET", "/settings/channel-links");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadLinks() {
  const { links } = await apiReq("GET", "/settings/channel-links");
  const tbody = $("links-tbody");
  if (!links.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted); padding:12px 0">No links yet.</td></tr>';
    return;
  }
  tbody.innerHTML = links.map(l => `
    <tr>
      <td>${escapeHtml(l.twitch_channel)}</td>
      <td>${escapeHtml(l.youtube_channel)}</td>
      <td><button class="del-btn" data-id="${l.id}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/channel-links/${btn.dataset.id}`);
      loadLinks().catch(console.error);
    });
  });
}

async function loadAccounts() {
  const { accounts } = await apiReq("GET", "/settings/user-accounts");
  const tbody = $("accounts-tbody");
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted); padding:12px 0">No accounts configured.</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(a => `
    <tr>
      <td>${escapeHtml(a.label)}</td>
      <td>${a.twitch_user ? escapeHtml(a.twitch_user) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${a.youtube_user ? escapeHtml(a.youtube_user) : '<span style="color:var(--muted)">—</span>'}</td>
      <td><button class="del-acct-btn" data-id="${a.id}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-acct-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/user-accounts/${btn.dataset.id}`);
      loadAccounts().catch(console.error);
    });
  });
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const twitch = $("input-twitch").value.trim().toLowerCase();
  const youtube = $("input-youtube").value.trim().toLowerCase();
  if (!twitch || !youtube) return;
  await apiReq("POST", "/settings/channel-links", {
    twitch_channel: twitch,
    youtube_channel: youtube,
  });
  $("input-twitch").value = "";
  $("input-youtube").value = "";
  loadLinks().catch(console.error);
});

$("add-account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("input-label").value.trim();
  const twitch = $("input-account-twitch").value.trim().toLowerCase();
  const youtube = $("input-account-youtube").value.trim().toLowerCase();
  if (!label) return;
  if (!twitch && !youtube) {
    alert("Provide at least a Twitch or YouTube handle.");
    return;
  }
  const body = { label };
  if (twitch) body.twitch_user = twitch;
  if (youtube) body.youtube_user = youtube;
  try {
    await apiReq("POST", "/settings/user-accounts", body);
  } catch (err) {
    alert(`Failed: ${err.message}`);
    return;
  }
  $("input-label").value = "";
  $("input-account-twitch").value = "";
  $("input-account-youtube").value = "";
  loadAccounts().catch(console.error);
});

async function boot() {
  await loadLinks();
  await loadAccounts();
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
