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
    await apiReq("GET", "/settings/creator-links");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

const PLATFORM_BADGE = {
  twitch: "TW", youtube: "YT", x: "X",
  facebook: "FB", instagram: "IG", plex: "PLEX",
};

async function loadCreators() {
  const { groups } = await apiReq("GET", "/settings/creator-links");
  const tbody = $("creator-tbody");
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted); padding:12px 0">No creator links yet.</td></tr>';
    return;
  }
  tbody.innerHTML = groups.map(g => `
    <tr>
      <td>${escapeHtml(g.label)}</td>
      <td>${g.members.map(m => `
        <span class="platform-badge ${m.platform}" style="margin-right:6px">${PLATFORM_BADGE[m.platform] || m.platform}</span>${escapeHtml(m.channel)}
        <button class="del-btn" data-alias="${m.id}" style="padding:1px 6px;margin:0 10px 4px 4px">×</button>
      `).join("<br>")}</td>
      <td><button class="del-btn" data-group="${g.id}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-btn[data-alias]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/creator-links/alias/${btn.dataset.alias}`);
      loadCreators().catch(console.error);
    });
  });
  tbody.querySelectorAll(".del-btn[data-group]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/creator-links/group/${btn.dataset.group}`);
      loadCreators().catch(console.error);
    });
  });
}

const ACCOUNT_FIELDS = [
  { key: "twitch_user", badge: "TW" },
  { key: "youtube_user", badge: "YT" },
  { key: "x_user", badge: "X" },
  { key: "facebook_user", badge: "FB" },
  { key: "instagram_user", badge: "IG" },
  { key: "plex_user", badge: "PLEX" },
];

async function loadAccounts() {
  const { accounts } = await apiReq("GET", "/settings/user-accounts");
  const tbody = $("accounts-tbody");
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted); padding:12px 0">No accounts configured.</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(a => {
    const chips = ACCOUNT_FIELDS
      .filter(f => a[f.key])
      .map(f => `<span class="platform-badge" style="margin-right:6px">${f.badge}</span>${escapeHtml(a[f.key])}`)
      .join("<br>");
    return `
      <tr>
        <td>${escapeHtml(a.label)}</td>
        <td>${chips || '<span style="color:var(--muted)">—</span>'}</td>
        <td><button class="del-acct-btn" data-id="${a.id}">Delete</button></td>
      </tr>
    `;
  }).join("");
  tbody.querySelectorAll(".del-acct-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/user-accounts/${btn.dataset.id}`);
      loadAccounts().catch(console.error);
    });
  });
}

$("add-creator-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("input-creator-label").value.trim();
  const platform = $("input-creator-platform").value;
  const channel = $("input-creator-channel").value.trim().toLowerCase();
  const status = $("creator-status");
  if (!label || !channel) {
    status.textContent = "Enter a creator name and a channel handle.";
    return;
  }
  try {
    await apiReq("POST", "/settings/creator-links", { label, platform, channel });
    status.textContent = "";
    $("input-creator-channel").value = "";
    loadCreators().catch(console.error);
  } catch (err) {
    status.textContent = err.message.includes("409")
      ? "That channel is already linked to a creator."
      : `Failed: ${err.message}`;
  }
});

const BULK_SAMPLE = {
  groups: [
    {
      label: "MrBeast",
      aliases: [
        { platform: "youtube", channel: "mrbeast" },
        { platform: "x", channel: "mrbeast" },
      ],
    },
    {
      label: "Ludwig",
      aliases: [
        { platform: "twitch", channel: "ludwig" },
        { platform: "youtube", channel: "ludwig" },
      ],
    },
  ],
};

$("bulk-load-sample-btn").addEventListener("click", () => {
  $("bulk-creators-json").value = JSON.stringify(BULK_SAMPLE, null, 2);
});

$("bulk-import-btn").addEventListener("click", async () => {
  const status = $("bulk-import-status");
  const raw = $("bulk-creators-json").value.trim();
  if (!raw) {
    status.textContent = "Paste JSON first.";
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    status.textContent = `Invalid JSON: ${err.message}`;
    return;
  }
  if (!payload || !Array.isArray(payload.groups)) {
    status.textContent = 'Expected { "groups": [...] }';
    return;
  }
  status.textContent = "Importing…";
  try {
    const res = await apiReq("POST", "/settings/creator-links/bulk", payload);
    status.textContent =
      `Done. ${res.groups_created} new creator(s), ` +
      `${res.aliases_added} channel(s) added, ${res.aliases_skipped} skipped.`;
    loadCreators().catch(console.error);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

const ACCOUNT_INPUTS = [
  { input: "input-account-twitch", field: "twitch_user" },
  { input: "input-account-youtube", field: "youtube_user" },
  { input: "input-account-x", field: "x_user" },
  { input: "input-account-facebook", field: "facebook_user" },
  { input: "input-account-instagram", field: "instagram_user" },
  { input: "input-account-plex", field: "plex_user" },
];

$("add-account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("input-label").value.trim();
  if (!label) return;
  const body = { label };
  let any = false;
  for (const { input, field } of ACCOUNT_INPUTS) {
    const v = $(input).value.trim().toLowerCase();
    if (v) {
      body[field] = v;
      any = true;
    }
  }
  if (!any) {
    alert("Provide at least one platform handle.");
    return;
  }
  try {
    await apiReq("POST", "/settings/user-accounts", body);
  } catch (err) {
    alert(`Failed: ${err.message}`);
    return;
  }
  $("input-label").value = "";
  for (const { input } of ACCOUNT_INPUTS) $(input).value = "";
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

async function loadPlexConfig() {
  const cfg = await apiReq("GET", "/settings/plex");
  $("plex-base-url").value = cfg.base_url || "";
  $("plex-token").value = "";
  $("plex-token").placeholder = cfg.has_token
    ? "leave blank to keep saved token"
    : "paste your X-Plex-Token";
  $("plex-channel-from-studio").checked = !!cfg.channel_from_studio;
  const status = $("plex-status");
  if (cfg.configured) {
    status.textContent = "Configured — polling active.";
    status.style.color = "var(--ok, #6a9a78)";
  } else {
    status.textContent = "Not configured.";
    status.style.color = "var(--muted)";
  }
}

$("plex-save-btn").addEventListener("click", async () => {
  const body = {
    base_url: $("plex-base-url").value.trim(),
    token: $("plex-token").value,
    channel_from_studio: $("plex-channel-from-studio").checked,
  };
  const status = $("plex-status");
  status.textContent = "Saving…";
  status.style.color = "var(--muted)";
  try {
    await apiReq("PUT", "/settings/plex", body);
    await loadPlexConfig();
  } catch (err) {
    status.textContent = `Save failed: ${err.message}`;
    status.style.color = "var(--danger, #d07070)";
  }
});

$("plex-test-btn").addEventListener("click", async () => {
  const status = $("plex-status");
  status.textContent = "Testing…";
  status.style.color = "var(--muted)";
  try {
    const r = await apiReq("POST", "/settings/plex/test");
    status.textContent = `OK — ${r.sessions} active session(s) right now.`;
    status.style.color = "var(--ok, #6a9a78)";
  } catch (err) {
    status.textContent = `Test failed: ${err.message}`;
    status.style.color = "var(--danger, #d07070)";
  }
});

$("plex-clear-btn").addEventListener("click", async () => {
  if (!confirm("Clear Plex server URL and token? Polling will stop.")) return;
  await apiReq("DELETE", "/settings/plex");
  await loadPlexConfig();
});

async function boot() {
  await Promise.all([
    loadCreators(),
    loadAccounts(),
    loadCustomAvatars(),
    loadChannelSuggestions(),
    loadGdriveStatus(),
    loadPlexConfig(),
  ]);
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
