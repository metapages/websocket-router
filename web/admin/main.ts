/**
 * Admin panel.
 *
 * Deliberately framework-free: it shows four numbers, edits one setting and
 * tails a log. Everything it needs is in the DOM already; adding a framework
 * would cost more bytes than the whole page.
 */

type Settings = { maxMessageBytes: number };
type Limits = { maxMessageBytes: { min: number; max: number } };
type LogEntry = { time: number; level: string; msg: string; [key: string]: unknown };

type Stats = {
  uptimeSeconds: number;
  router: {
    channels: number;
    connections: number;
    messagesRouted: number;
    bytesRouted: number;
    topChannels: { name: string; subscribers: number }[];
  };
  memory: { rss: number; heapUsed: number };
  node: string;
  pid: number;
  user: { uid: number | null; gid: number | null };
  tls: { enabled: boolean; domains: string[] };
};

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/admin/api${path}`, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : {},
    ...init,
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("not authenticated");
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body;
};

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

const bytes = (value: number): string => {
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? scaled : scaled.toFixed(1)} ${UNITS[unit]}`;
};

const duration = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

let pollTimer: number | undefined;

const showLogin = () => {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
  $("panel").hidden = true;
  $("login").hidden = false;
  ($("password") as HTMLInputElement).focus();
};

const showPanel = () => {
  $("login").hidden = true;
  $("panel").hidden = false;
  void refreshAll();
  pollTimer = window.setInterval(() => void refreshAll(), 3000);
};

const renderStats = (stats: Stats) => {
  $("uptime").textContent = `up ${duration(stats.uptimeSeconds)} · node ${stats.node} · pid ${stats.pid}` +
    (stats.user.uid !== null ? ` · uid ${stats.user.uid}` : "");

  const cards: [string, string][] = [
    ["Channels", String(stats.router.channels)],
    ["Connections", String(stats.router.connections)],
    ["Messages routed", stats.router.messagesRouted.toLocaleString()],
    ["Bytes routed", bytes(stats.router.bytesRouted)],
    ["Memory (RSS)", bytes(stats.memory.rss)],
    ["TLS", stats.tls.enabled ? stats.tls.domains.join(", ") || "on" : "off"],
  ];

  $("stats").innerHTML = cards
    .map(
      ([label, value]) =>
        `<div class="card"><div class="value">${escapeHtml(value)}</div>` +
        `<div class="label">${escapeHtml(label)}</div></div>`,
    )
    .join("");
};

const IGNORED_LOG_KEYS = new Set(["time", "level", "msg", "pid", "hostname"]);

const renderLogs = (entries: LogEntry[], files: { name: string; size: number }[]) => {
  const target = $("logs");
  const follow = ($("log-follow") as HTMLInputElement).checked;
  const wasAtBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 40;

  target.innerHTML = entries
    .map((entry) => {
      const stamp = new Date(entry.time).toISOString().slice(11, 23);
      const extra = Object.entries(entry)
        .filter(([key]) => !IGNORED_LOG_KEYS.has(key))
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        .join(" ");
      return (
        `<span class="line"><span class="t">${stamp}</span> ` +
        `<span class="lvl lvl-${escapeHtml(entry.level)}">${escapeHtml(entry.level.padEnd(5))}</span> ` +
        `${escapeHtml(entry.msg)}` +
        (extra ? ` <span class="extra">${escapeHtml(extra)}</span>` : "") +
        `</span>`
      );
    })
    .join("");

  if (follow && wasAtBottom) target.scrollTop = target.scrollHeight;

  $("log-files").textContent = files.length
    ? `${files.length} log file(s): ${files.map((f) => `${f.name} (${bytes(f.size)})`).join(", ")}`
    : "no log files yet";
};

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

let settingsDirty = false;

const refreshSettings = async () => {
  const { settings, limits } = await api<{ settings: Settings; limits: Limits }>("/settings");
  if (settingsDirty) return;

  const input = $("max-message") as HTMLInputElement;
  const unit = $("max-message-unit") as HTMLSelectElement;
  // Show the largest unit that divides cleanly, so 1048576 reads as "1 MiB".
  const divisor = [1048576, 1024, 1].find(
    (candidate) => settings.maxMessageBytes % candidate === 0,
  ) ?? 1;
  unit.value = String(divisor);
  input.value = String(settings.maxMessageBytes / divisor);
  input.max = String(limits.maxMessageBytes.max);
};

const refreshLogs = async () => {
  const level = ($("log-level") as HTMLSelectElement).value;
  const source = ($("log-source") as HTMLSelectElement).value;
  const limit = ($("log-limit") as HTMLSelectElement).value;
  const data = await api<{ entries: LogEntry[]; files: { name: string; size: number }[] }>(
    `/logs?limit=${limit}&source=${source}&level=${level}`,
  );
  renderLogs(data.entries, data.files);
};

const refreshAll = async () => {
  try {
    const [stats] = await Promise.all([
      api<Stats>("/stats"),
      refreshSettings(),
      refreshLogs(),
    ]);
    renderStats(stats);
  } catch {
    // showLogin() already ran for a 401; anything else is transient and the
    // next poll will pick it up.
  }
};

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const error = $("login-error");
  const password = ($("password") as HTMLInputElement).value;
  error.hidden = true;

  void (async () => {
    try {
      await api("/login", { method: "POST", body: JSON.stringify({ password }) });
      ($("password") as HTMLInputElement).value = "";
      showPanel();
    } catch (failure) {
      error.textContent = (failure as Error).message;
      error.hidden = false;
    }
  })();
});

$("logout").addEventListener("click", () => {
  void api("/logout", { method: "POST" }).finally(showLogin);
});

$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const status = $("settings-status");
  const value = Number(($("max-message") as HTMLInputElement).value);
  const unit = Number(($("max-message-unit") as HTMLSelectElement).value);

  void (async () => {
    try {
      const { settings } = await api<{ settings: Settings }>("/settings", {
        method: "PUT",
        body: JSON.stringify({ maxMessageBytes: Math.round(value * unit) }),
      });
      settingsDirty = false;
      status.textContent = `Saved. Limit is now ${bytes(settings.maxMessageBytes)}.`;
      status.className = "status ok";
    } catch (failure) {
      status.textContent = (failure as Error).message;
      status.className = "status bad";
    }
  })();
});

$("max-message").addEventListener("input", () => {
  // Stop the 3s poll from overwriting what is being typed.
  settingsDirty = true;
});

for (const id of ["log-level", "log-source", "log-limit"]) {
  $(id).addEventListener("change", () => void refreshLogs());
}

void (async () => {
  const { authenticated } = await api<{ authenticated: boolean }>("/session").catch(() => ({
    authenticated: false,
  }));
  if (authenticated) showPanel();
  else showLogin();
})();
