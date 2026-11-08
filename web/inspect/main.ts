/**
 * Connection inspector.
 *
 * Answers one question: what is connected to this router, and what is it
 * saying? The server tells it which channels have connections and since
 * when; everything about the traffic itself is learned the ordinary way, by
 * subscribing to each channel as a read-only client. The server keeps no
 * message history, so this page shows what happens from the moment it
 * connects onward -- which is the honest thing for it to show, rather than a
 * buffer the router would have to pay for whether anyone was watching or not.
 *
 * Framework-free, for the same reason the admin panel is: it draws a list.
 */

type ConnectionInfo = {
  id: string;
  connectedAt: number;
  ip?: string;
  origin?: string;
  userAgent?: string;
  observer: boolean;
};

type ChannelDetail = {
  name: string;
  subscribers: number;
  observers: number;
  since: number;
  connections: ConnectionInfo[];
};

type ChannelsResponse = {
  serverTime: number;
  uptimeSeconds: number;
  truncated: boolean;
  channels: ChannelDetail[];
};

/**
 * One websocket per watched channel, so a busy router cannot be watched by
 * accident. Channels are listed busiest first, so the cap drops the quietest.
 */
const MAX_WATCHED = 50;

const POLL_MS = 3000;
const RENDER_MS = 500;
const PREVIEW_CHARS = 400;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

/**
 * The secret path segment this page was served from.
 *
 * Taken from the URL rather than baked into the bundle: the bundle is a
 * public, cacheable asset under /_/, and the key must never be in it.
 */
const KEY = location.pathname.split("/").filter((part) => part.length > 0)[0] ?? "";
const API = `/${KEY}/api/channels`;

// ---------------------------------------------------------------------------
// watching
// ---------------------------------------------------------------------------

type Seen = {
  count: number;
  bytes: number;
  at: number;
  text: string | null;
  binaryBytes: number | null;
};

type Watcher = {
  socket: WebSocket;
  /** Last message seen on this channel, or null if none yet. */
  last: Seen | null;
  messages: number;
  state: "connecting" | "open" | "closed";
};

const watchers = new Map<string, Watcher>();

const watchUrl = (channel: string): string => {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  // `observe` marks the socket read-only on the server: it receives
  // everything on the channel, is excluded from the subscriber count, and
  // anything it sends is dropped. Looking must not change what is watched.
  return `${scheme}//${location.host}/${encodeURIComponent(channel)}` +
    `?observe=${encodeURIComponent(KEY)}`;
};

const startWatching = (channel: string): void => {
  const socket = new WebSocket(watchUrl(channel));
  socket.binaryType = "arraybuffer";

  const watcher: Watcher = {
    socket,
    last: null,
    messages: 0,
    state: "connecting",
  };
  watchers.set(channel, watcher);

  socket.addEventListener("open", () => {
    watcher.state = "open";
  });

  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    watcher.messages += 1;
    const data = event.data;
    if (typeof data === "string") {
      watcher.last = {
        count: watcher.messages,
        bytes: new Blob([data]).size,
        at: Date.now(),
        text: data,
        binaryBytes: null,
      };
      return;
    }
    const size = data instanceof ArrayBuffer ? data.byteLength : 0;
    watcher.last = {
      count: watcher.messages,
      bytes: size,
      at: Date.now(),
      text: null,
      binaryBytes: size,
    };
  });

  const ended = () => {
    watcher.state = "closed";
  };
  socket.addEventListener("close", ended);
  socket.addEventListener("error", ended);
};

const stopWatching = (channel: string): void => {
  const watcher = watchers.get(channel);
  if (!watcher) return;
  watchers.delete(channel);
  watcher.socket.close();
};

/**
 * Open a socket for every listed channel that has none, and close the ones
 * whose channel has gone.
 *
 * Reconciling on each poll is also the reconnect path: a socket that dropped
 * is simply one that needs opening again, so there is no separate backoff
 * timer and no risk of a reconnect loop running faster than the poll.
 */
const reconcileWatchers = (channels: ChannelDetail[]): void => {
  const watching = ($("watch") as HTMLInputElement).checked;
  const wanted = watching
    ? new Set(channels.slice(0, MAX_WATCHED).map((channel) => channel.name))
    : new Set<string>();

  for (const name of [...watchers.keys()]) {
    if (!wanted.has(name)) stopWatching(name);
  }
  for (const name of wanted) {
    const existing = watchers.get(name);
    // Keep whatever has been seen so far: only a socket that is actually
    // gone is replaced, so the last message survives a reconnect.
    if (existing && existing.state !== "closed") continue;
    if (existing) watchers.delete(name);
    startWatching(name);
  }
};

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

/** "4d 3h", "3h 12m", "12m 04s", "7s" — the two largest useful units. */
const since = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
};

const preview = (text: string): string => {
  const trimmed = text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}…`
    : text;
  return escapeHtml(trimmed);
};

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

let latest: ChannelsResponse | null = null;
/**
 * Difference between this browser's clock and the server's, so an age is not
 * computed from two clocks that disagree. A laptop minutes behind the server
 * would otherwise show connections that started in the future.
 */
let clockSkewMs = 0;

const lastMessageHtml = (channel: ChannelDetail): string => {
  const watcher = watchers.get(channel.name);
  if (!watcher) {
    return `<div class="last idle">not watching</div>`;
  }
  if (watcher.state === "connecting" && watcher.last === null) {
    return `<div class="last idle">connecting…</div>`;
  }
  if (watcher.last === null) {
    const label = watcher.state === "closed"
      ? "disconnected; retrying"
      : "connected, nothing sent yet";
    return `<div class="last idle">${label}</div>`;
  }

  const last = watcher.last;
  const body = last.text === null
    ? `&lt;binary, ${bytes(last.binaryBytes ?? 0)}&gt;`
    : preview(last.text);
  return (
    `<div class="last"><span class="meta">` +
    `#${last.count} · ${since(Date.now() - last.at)} ago · ${bytes(last.bytes)}` +
    `</span>\n${body}</div>`
  );
};

const connectionsHtml = (channel: ChannelDetail, now: number): string => {
  const rows = channel.connections
    .map((connection) =>
      `<tr>` +
      `<td>${escapeHtml(connection.id)}</td>` +
      `<td>${since(now - connection.connectedAt)}</td>` +
      `<td>${escapeHtml(connection.ip ?? "—")}</td>` +
      `<td>${escapeHtml(connection.origin ?? "—")}</td>` +
      `<td>${escapeHtml(connection.userAgent ?? "—")}</td>` +
      `</tr>`,
    )
    .join("");

  return (
    `<table class="connections"><thead><tr>` +
    `<th>socket</th><th>up</th><th>address</th><th>origin</th><th>user agent</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
};

/**
 * The order the watch cap is applied in: busiest first, always.
 *
 * Deliberately not the display order. Reconciling against "most recent
 * message" would drop a quiet channel off the end of the cap, which stops it
 * reporting messages, which keeps it quiet -- sockets would churn on every
 * poll and a channel could be starved of attention by having been quiet once.
 */
const byBusiest = (channels: ChannelDetail[]): ChannelDetail[] =>
  [...channels].sort((a, b) => b.subscribers - a.subscribers || a.since - b.since);

const sortChannels = (channels: ChannelDetail[]): ChannelDetail[] => {
  const mode = ($("sort") as HTMLSelectElement).value;
  const copy = [...channels];
  if (mode === "name") {
    copy.sort((a, b) => a.name.localeCompare(b.name));
  } else if (mode === "age") {
    copy.sort((a, b) => a.since - b.since);
  } else if (mode === "recent") {
    const at = (channel: ChannelDetail) => watchers.get(channel.name)?.last?.at ?? 0;
    copy.sort((a, b) => at(b) - at(a));
  } else {
    copy.sort((a, b) => b.subscribers - a.subscribers || a.since - b.since);
  }
  return copy;
};

const render = (): void => {
  if (latest === null) return;
  // Ages are drawn against the server's idea of now, corrected for this
  // browser's clock.
  const now = Date.now() - clockSkewMs;

  const channels = sortChannels(latest.channels);
  const connections = channels.reduce((total, channel) => total + channel.subscribers, 0);

  $("summary").textContent =
    `${channels.length} channel${channels.length === 1 ? "" : "s"} · ` +
    `${connections} connection${connections === 1 ? "" : "s"} · ` +
    `router up ${since(latest.uptimeSeconds * 1000)}` +
    (latest.truncated ? " · list truncated" : "") +
    (watchers.size < channels.length
      ? ` · watching ${watchers.size}`
      : "");

  if (channels.length === 0) {
    $("channels").innerHTML =
      `<p class="empty">Nothing is connected right now. ` +
      `This list refreshes every ${POLL_MS / 1000} seconds.</p>`;
    return;
  }

  $("channels").innerHTML = channels
    .map((channel) => {
      const observers = channel.observers > 0
        ? `<span class="pill">${channel.observers} watching</span>`
        : "";
      return (
        `<article class="channel">` +
        `<div class="channel-head">` +
        `<h2>${escapeHtml(channel.name)}</h2>` +
        `<a href="/${encodeURIComponent(channel.name)}" target="_blank" rel="noreferrer noopener">open page ↗</a>` +
        `</div>` +
        `<div class="facts">` +
        `<span class="pill">up ${since(now - channel.since)}</span>` +
        `<span class="pill">${channel.subscribers} connection${channel.subscribers === 1 ? "" : "s"}</span>` +
        observers +
        `</div>` +
        lastMessageHtml(channel) +
        connectionsHtml(channel, now) +
        `</article>`
      );
    })
    .join("");
};

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

const poll = async (): Promise<void> => {
  const error = $("error");
  try {
    const response = await fetch(API, { credentials: "omit" });
    if (!response.ok) throw new Error(`the router answered ${response.status}`);
    const data = (await response.json()) as ChannelsResponse;
    latest = data;
    clockSkewMs = Date.now() - data.serverTime;
    error.hidden = true;
    reconcileWatchers(byBusiest(data.channels));
    render();
  } catch (failure) {
    error.textContent = `Could not read the channel list: ${(failure as Error).message}`;
    error.hidden = false;
  }
};

$("watch").addEventListener("change", () => {
  if (latest) reconcileWatchers(byBusiest(latest.channels));
  render();
});
$("sort").addEventListener("change", render);

void poll();
window.setInterval(() => void poll(), POLL_MS);
// Message arrival is not on the poll clock, so redraw more often than it: a
// "last message" that only updated every three seconds would look stale on a
// busy channel.
window.setInterval(render, RENDER_MS);

// This file imports nothing, and without an export tsc treats it as a global
// script whose top-level `const`s collide with the admin panel's. Vite emits
// a module either way; this only tells the type checker so.
export {};
