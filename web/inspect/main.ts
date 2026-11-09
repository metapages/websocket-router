/**
 * Connection inspector.
 *
 * Answers one question: what is connected to this router, and what is it
 * saying? The server tells it which channels have connections and since
 * when; everything about the traffic itself is learned the ordinary way, by
 * subscribing to a channel as a read-only client. The server keeps no
 * message history, so this page shows what happens from the moment you open
 * a channel onward -- which is the honest thing for it to show, rather than
 * a buffer the router would have to pay for whether anyone was watching or
 * not.
 *
 * Nothing is subscribed to until you ask. Listing is a cheap HTTP read;
 * watching costs a websocket on a live channel, and opening one per listed
 * channel the moment the page loaded meant arriving at a diagnostic tool
 * that had already connected to everything in production.
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

const POLL_MS = 3000;
/** Ages tick; only runs while something is open, so an idle list is static. */
const TICK_MS = 1000;
/** Display cap. Copying always yields the whole payload, never this. */
const PREVIEW_CHARS = 2000;
const COPIED_MS = 1600;

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
  /** The full message. Truncation happens at render, never here. */
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

/**
 * Channels the operator has opened, which is the only thing that ever causes
 * a subscription. Kept separately from `watchers` because a socket can drop
 * while a channel is still open on screen, and the intent to watch has to
 * outlive the socket that served it.
 */
const opened = new Set<string>();

const watchUrl = (channel: string): string => {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  // `observe` marks the socket read-only on the server: it receives
  // everything on the channel, is excluded from the subscriber count, and
  // anything it sends is dropped. Looking must not change what is watched.
  return `${scheme}//${location.host}/${encodeURIComponent(channel)}` +
    `?observe=${encodeURIComponent(KEY)}`;
};

const startWatching = (channel: string, carry?: Watcher): void => {
  const socket = new WebSocket(watchUrl(channel));
  socket.binaryType = "arraybuffer";

  const watcher: Watcher = {
    socket,
    // A reconnect keeps what was already seen. Losing the last message
    // because the socket blipped would look like the channel went quiet.
    last: carry?.last ?? null,
    messages: carry?.messages ?? 0,
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
 * Close sockets for channels that have gone, and reopen any that dropped
 * while still open on screen.
 *
 * Doing this on the poll is also the reconnect path: a socket that died is
 * just one that needs opening again, so there is no backoff timer and no
 * reconnect loop able to run faster than the poll.
 */
const reconcileWatchers = (channels: ChannelDetail[]): void => {
  const present = new Set(channels.map((channel) => channel.name));

  for (const name of [...opened]) {
    if (present.has(name)) continue;
    // The card is gone, so there is no open state left to represent. Forget
    // it rather than silently resubscribing if the name comes back.
    opened.delete(name);
    stopWatching(name);
  }

  for (const name of opened) {
    const existing = watchers.get(name);
    if (existing && existing.state !== "closed") continue;
    if (existing) watchers.delete(name);
    startWatching(name, existing);
  }
};

// ---------------------------------------------------------------------------
// copying
// ---------------------------------------------------------------------------

/** Which copy button last succeeded, so render can acknowledge it. */
let copied: { token: string; at: number } | null = null;

const copy = (text: string, token: string): void => {
  const acknowledge = () => {
    copied = { token, at: Date.now() };
    render(true);
  };

  // The async clipboard API needs a secure context. Production is https and
  // localhost counts as one, but a plain-http deployment behind a proxy does
  // not -- hence the fallback, which is deprecated but universally present.
  void navigator.clipboard?.writeText(text).then(acknowledge).catch(() => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    try {
      document.execCommand("copy");
      acknowledge();
    } finally {
      scratch.remove();
    }
  });
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

/** A copy button. `token` identifies it only so the tick can say "copied". */
const copyButton = (token: string, label = "copy"): string => {
  const done = copied !== null && copied.token === token &&
    Date.now() - copied.at < COPIED_MS;
  return (
    `<button type="button" class="copy${done ? " done" : ""}" ` +
    `data-copy="${escapeHtml(token)}" title="Copy to clipboard">` +
    `${done ? "copied ✓" : escapeHtml(label)}</button>`
  );
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

/**
 * Whether redrawing the list right now would destroy what the operator is
 * doing.
 *
 * Rebuilding `#channels` replaces every node in it, which wipes a selection
 * in progress -- so dragging across a payload to copy it used to collapse,
 * jump, or swallow the whole page, because the nodes the selection was
 * anchored to stopped existing halfway through the drag. The copy buttons
 * are the better path, but selecting text must still work, so a redraw waits
 * for the pointer to come up and the selection to be dropped. There is
 * nothing to lose by waiting: the data is still polled, and the header keeps
 * saying the page is alive.
 */
let pointerDown = false;

const selectionInList = (): boolean => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const anchor = selection.anchorNode;
  return anchor !== null && $("channels").contains(anchor);
};

const lastMessageHtml = (channel: ChannelDetail): string => {
  const watcher = watchers.get(channel.name);
  if (!watcher) return "";

  if (watcher.last === null) {
    const label = watcher.state === "closed"
      ? "disconnected; retrying"
      : watcher.state === "connecting"
      ? "connecting…"
      : "connected, nothing sent yet";
    return `<div class="last idle">${label}</div>`;
  }

  const last = watcher.last;
  const truncated = last.text !== null && last.text.length > PREVIEW_CHARS;
  const body = last.text === null
    ? `&lt;binary, ${bytes(last.binaryBytes ?? 0)}&gt;`
    : escapeHtml(
      truncated ? `${last.text.slice(0, PREVIEW_CHARS)}…` : last.text,
    );

  return (
    `<div class="pane-head">` +
    `<span class="meta">last message · #${last.count} · ` +
    `${since(Date.now() - last.at)} ago · ${bytes(last.bytes)}` +
    (truncated ? " · shown truncated" : "") +
    `</span>` +
    (last.text === null
      ? ""
      : copyButton(`payload:${channel.name}`, "copy payload")) +
    `</div>` +
    `<div class="last">${body}</div>`
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
      `<td class="copy-cell">` +
      copyButton(`socket:${channel.name}:${connection.id}`) +
      `</td>` +
      `</tr>`,
    )
    .join("");

  return (
    `<div class="pane-head">` +
    `<span class="meta">connections</span>` +
    copyButton(`sockets:${channel.name}`, "copy all as JSON") +
    `</div>` +
    `<table class="connections"><thead><tr>` +
    `<th>socket</th><th>up</th><th>address</th><th>origin</th>` +
    `<th>user agent</th><th></th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
};

const sortChannels = (channels: ChannelDetail[]): ChannelDetail[] => {
  const mode = ($("sort") as HTMLSelectElement).value;
  const copyOf = [...channels];
  if (mode === "name") {
    copyOf.sort((a, b) => a.name.localeCompare(b.name));
  } else if (mode === "age") {
    copyOf.sort((a, b) => a.since - b.since);
  } else if (mode === "recent") {
    const at = (channel: ChannelDetail) => watchers.get(channel.name)?.last?.at ?? 0;
    copyOf.sort((a, b) => at(b) - at(a));
  } else {
    copyOf.sort((a, b) => b.subscribers - a.subscribers || a.since - b.since);
  }
  return copyOf;
};

const channelHtml = (channel: ChannelDetail, now: number): string => {
  const open = opened.has(channel.name);
  const watcher = watchers.get(channel.name);

  const state = !open
    ? ""
    : watcher?.state === "open"
    ? `<span class="pill live">watching · ${watcher.messages} msg</span>`
    : watcher?.state === "closed"
    ? `<span class="pill warn">reconnecting</span>`
    : `<span class="pill">connecting…</span>`;

  return (
    `<article class="channel${open ? " open" : ""}">` +
    `<div class="channel-head">` +
    `<h2><button type="button" class="toggle" data-channel="${escapeHtml(channel.name)}" ` +
    `aria-expanded="${open ? "true" : "false"}">` +
    `<span class="caret" aria-hidden="true">${open ? "▾" : "▸"}</span>` +
    `<span class="name">${escapeHtml(channel.name)}</span></button></h2>` +
    `<div class="head-actions">` +
    copyButton(`name:${channel.name}`, "copy key") +
    `<a href="/${encodeURIComponent(channel.name)}" target="_blank" rel="noreferrer noopener">open page ↗</a>` +
    `</div>` +
    `</div>` +
    `<div class="facts">` +
    `<span class="pill">up ${since(now - channel.since)}</span>` +
    `<span class="pill">${channel.subscribers} connection${channel.subscribers === 1 ? "" : "s"}</span>` +
    (channel.observers > 0 ? `<span class="pill">${channel.observers} watching</span>` : "") +
    state +
    `</div>` +
    (open
      ? connectionsHtml(channel, now) + lastMessageHtml(channel)
      : "") +
    `</article>`
  );
};

const render = (force = false): void => {
  if (latest === null) return;
  // Ages are drawn against the server's idea of now, corrected for this
  // browser's clock.
  const now = Date.now() - clockSkewMs;
  const channels = sortChannels(latest.channels);
  const connections = channels.reduce((total, channel) => total + channel.subscribers, 0);
  const held = !force && (pointerDown || selectionInList());

  $("summary").textContent =
    `${channels.length} channel${channels.length === 1 ? "" : "s"} · ` +
    `${connections} connection${connections === 1 ? "" : "s"} · ` +
    `router up ${since(latest.uptimeSeconds * 1000)}` +
    (opened.size > 0 ? ` · watching ${opened.size}` : "") +
    (latest.truncated ? " · list truncated" : "") +
    (held ? " · redraw paused while you have text selected" : "");

  if (held) return;

  if (channels.length === 0) {
    $("channels").innerHTML =
      `<p class="empty">Nothing is connected right now. ` +
      `This list refreshes every ${POLL_MS / 1000} seconds.</p>`;
    return;
  }

  $("channels").innerHTML = channels
    .map((channel) => channelHtml(channel, now))
    .join("");
};

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/**
 * One delegated listener, because the list's nodes are replaced on every
 * redraw and handlers bound to them would not survive it.
 */
$("channels").addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;

  const toggle = target?.closest<HTMLElement>("[data-channel]");
  if (toggle) {
    const name = toggle.dataset["channel"];
    if (name === undefined) return;
    if (opened.has(name)) {
      opened.delete(name);
      stopWatching(name);
    } else {
      opened.add(name);
      startWatching(name);
    }
    render(true);
    return;
  }

  const button = target?.closest<HTMLElement>("[data-copy]");
  if (!button) return;
  const token = button.dataset["copy"];
  if (token === undefined) return;

  // Copy from state, never from the DOM: the DOM holds a truncated preview,
  // and what is wanted is the whole payload.
  const [kind, ...rest] = token.split(":");
  const channelName = rest.slice(0, kind === "socket" ? -1 : undefined).join(":");
  const channel = latest?.channels.find((entry) => entry.name === channelName);

  if (kind === "name") {
    copy(channelName, token);
  } else if (kind === "payload") {
    const text = watchers.get(channelName)?.last?.text;
    if (typeof text === "string") copy(text, token);
  } else if (kind === "sockets" && channel) {
    copy(JSON.stringify(channel.connections, null, 2), token);
  } else if (kind === "socket" && channel) {
    const id = rest[rest.length - 1];
    const connection = channel.connections.find((entry) => entry.id === id);
    if (connection) copy(JSON.stringify(connection, null, 2), token);
  }
});

addEventListener("pointerdown", () => {
  pointerDown = true;
});
for (const type of ["pointerup", "pointercancel"]) {
  addEventListener(type, () => {
    pointerDown = false;
  });
}

$("sort").addEventListener("change", () => render(true));

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
    reconcileWatchers(data.channels);
    render();
  } catch (failure) {
    error.textContent = `Could not read the channel list: ${(failure as Error).message}`;
    error.hidden = false;
  }
};

void poll();
setInterval(() => void poll(), POLL_MS);
// Messages do not arrive on the poll clock, so an open channel is redrawn
// more often than it. A list with nothing open has nothing to animate, so it
// is left alone -- which also leaves it selectable.
setInterval(() => {
  // Clear the "copied ✓" acknowledgement once, rather than leaving a
  // one-second redraw running for the rest of the session.
  if (copied !== null && Date.now() - copied.at >= COPIED_MS) {
    copied = null;
    render();
    return;
  }
  if (opened.size > 0) render();
}, TICK_MS);

// This file imports nothing, and without an export tsc treats it as a global
// script whose top-level `const`s collide with the admin panel's. Vite emits
// a module either way; this only tells the type checker so.
export {};
