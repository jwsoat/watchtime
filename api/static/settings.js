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

$("auto-link-btn").addEventListener("click", async () => {
  const status = $("auto-link-status");
  status.textContent = "Working...";
  try {
    const res = await apiReq("POST", "/settings/user-accounts/auto-link");
    status.textContent = `Created ${res.created}, skipped ${res.skipped} (already linked) — ${res.total_pairs} pairs found.`;
    loadAccounts().catch(console.error);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

let _allChannels = { twitch: [], youtube: [] };

async function loadChannelSuggestions() {
  _allChannels = await apiReq("GET", "/stats/channels");
  updateChannelDatalist();
}

function updateChannelDatalist() {
  const platform = $("input-avatar-platform").value;
  const dl = $("channel-suggestions");
  dl.innerHTML = (_allChannels[platform] || [])
    .map(ch => `<option value="${escapeHtml(ch)}">`)
    .join("");
}

$("input-avatar-platform").addEventListener("change", updateChannelDatalist);

async function loadCustomAvatars() {
  const { avatars } = await apiReq("GET", "/avatars/custom");
  const tbody = $("avatars-tbody");
  if (!avatars.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted); padding:12px 0">No custom avatars set.</td></tr>';
    return;
  }
  tbody.innerHTML = avatars.map(a => `
    <tr>
      <td><span class="platform-badge ${a.platform}">${a.platform === "twitch" ? "TW" : "YT"}</span></td>
      <td>${escapeHtml(a.channel)}</td>
      <td><img src="/avatars/${a.platform}/${encodeURIComponent(a.channel)}?t=${Date.now()}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;vertical-align:middle" onerror="this.style.display='none'"></td>
      <td><button class="del-btn" data-platform="${a.platform}" data-channel="${escapeHtml(a.channel)}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/avatars/${btn.dataset.platform}/${encodeURIComponent(btn.dataset.channel)}`);
      loadCustomAvatars().catch(console.error);
    });
  });
}

$("add-avatar-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const platform = $("input-avatar-platform").value;
  const channel = $("input-avatar-channel").value.trim().toLowerCase();
  const fileInput = $("input-avatar-file");
  const status = $("avatar-upload-status");
  if (!channel || !fileInput.files.length) return;
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  status.textContent = "Uploading...";
  try {
    const res = await fetch(`/avatars/${platform}/${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: { "X-API-Key": state.apiKey },
      body: formData,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.textContent = "Uploaded.";
    $("input-avatar-channel").value = "";
    fileInput.value = "";
    loadCustomAvatars().catch(console.error);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

$("export-json-btn").addEventListener("click", async () => {
  try {
    const data = await apiReq("GET", "/settings/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `watchtime-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  }
});

$("backup-db-btn").addEventListener("click", async () => {
  try {
    const res = await fetch("/settings/backup", {
      headers: { "X-API-Key": state.apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `watchtime-backup-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Backup failed: ${err.message}`);
  }
});

$("import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = $("import-file");
  const mode = $("import-mode").value;
  const status = $("import-status");
  if (!fileInput.files.length) return;

  if (mode === "replace" && !confirm(
    "Replace mode will DELETE all existing data before importing. This cannot be undone. Continue?"
  )) return;

  status.textContent = "Importing...";
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  try {
    const res = await fetch(`/settings/import?mode=${mode}`, {
      method: "POST",
      headers: { "X-API-Key": state.apiKey },
      body: formData,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    const summary = Object.entries(result.imported)
      .map(([t, n]) => `${t}: ${n}`)
      .join(", ");
    status.textContent = `Done (${result.mode}). ${summary}`;
    fileInput.value = "";
    boot();
  } catch (err) {
    status.textContent = `Import failed: ${err.message}`;
  }
});

async function loadGdriveStatus() {
  try {
    const data = await apiReq("GET", "/settings/gdrive/status");
    $("gdrive-not-configured").classList.toggle("hidden", data.configured);
    $("gdrive-disconnected").classList.toggle("hidden", !data.configured || data.connected);
    $("gdrive-connected").classList.toggle("hidden", !data.connected);
    if (data.connected) {
      const tbody = $("gdrive-backups-tbody");
      if (!data.backups.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted)">No backups yet.</td></tr>';
      } else {
        tbody.innerHTML = data.backups.map(b => {
          const date = b.createdTime ? new Date(b.createdTime).toLocaleString() : "—";
          const size = b.size ? `${(parseInt(b.size) / 1024 / 1024).toFixed(2)} MB` : "—";
          return `<tr><td>${escapeHtml(b.name)}</td><td>${date}</td><td>${size}</td></tr>`;
        }).join("");
      }
    }
  } catch (err) {
    console.warn("gdrive status failed", err);
  }
}

$("gdrive-connect-btn").addEventListener("click", () => {
  window.open(`/settings/gdrive/connect?x-api-key=${encodeURIComponent(state.apiKey)}`, "_blank");
});

$("gdrive-backup-btn").addEventListener("click", async () => {
  const status = $("gdrive-backup-status");
  status.textContent = "Uploading backup...";
  try {
    const res = await apiReq("POST", "/settings/gdrive/backup");
    const rotated = res.rotated_out.length ? ` Rotated out: ${res.rotated_out.join(", ")}` : "";
    status.textContent = `Backed up ${res.uploaded.name}.${rotated}`;
    loadGdriveStatus();
  } catch (err) {
    status.textContent = `Backup failed: ${err.message}`;
  }
});

$("gdrive-disconnect-btn").addEventListener("click", async () => {
  if (!confirm("Disconnect Google Drive? Existing backups on Drive are kept.")) return;
  await apiReq("DELETE", "/settings/gdrive/disconnect");
  loadGdriveStatus();
});

async function boot() {
  await Promise.all([loadLinks(), loadAccounts(), loadCustomAvatars(), loadChannelSuggestions(), loadGdriveStatus()]);
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
