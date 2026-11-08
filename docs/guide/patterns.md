# Patterns

The router gives you one primitive: fan-out to everyone but the sender.
Everything else is a convention in the payload. These are the conventions that
keep reappearing, in the order you are likely to need them.

All examples assume a `send(message)` function and an `onMessage(handler)`
subscription, as built in the
[quickstart](/guide/quickstart#a-complete-two-way-client).

## Typed messages

Start here, always. A `type` field costs one key and buys you the ability to add
message kinds without rewriting anyone's handler.

```js
const handlers = {};
const on = (type, fn) => (handlers[type] = fn);

onMessage((data) => {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return; // not ours — ignore rather than throw
  }
  handlers[msg?.type]?.(msg);
});

const emit = (type, body) => send(JSON.stringify({ type, ...body }));
```

Ignoring messages you do not recognise is important: channels are shared, and a
stray page or an older version of your app may be sending things you have never
seen.

## Identity

The router has no notion of who anyone is, so give each client an id on startup.
It exists only for the lifetime of the tab.

```js
const CLIENT_ID = crypto.randomUUID();
const emit = (type, body) =>
  send(JSON.stringify({ type, from: CLIENT_ID, ...body }));
```

You do not need this to avoid your own echo — the router already does that — but
you do need it to address a specific peer or to attribute state.

## Request/response {#request-response}

Fan-out plus a correlation id gives you RPC. Useful for asking whoever is out
there for the current state.

```js
const pending = new Map();

const request = (type, body, timeoutMs = 5000) => {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no reply to ${type}`));
    }, timeoutMs);
    pending.set(id, (value) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(value);
    });
    emit(type, { ...body, id });
  });
};

on("reply", (msg) => pending.get(msg.id)?.(msg.body));

// responder side
on("get-state", (msg) => emit("reply", { id: msg.id, body: currentState() }));
```

The timeout is not optional. Nobody may be listening, and there is no error when
that happens — silence is the only signal you get.

Note that _every_ peer will answer a request, so the first reply wins and the
rest are dropped by `pending.delete`. If that matters, have responders wait a
short random delay and stay quiet if they see someone else answer first.

## Late joiner state sync

Because there is no history, a client that joins late knows nothing. Ask.

```js
const boot = async () => {
  try {
    applyState(await request("get-state", {}, 2000));
  } catch {
    // nobody home — we are the first, so we define the state
    applyState(initialState());
  }
};
```

This single pattern covers most of what people miss about persistence, and it
degrades sensibly: with no peers you simply start fresh.

## Presence {#presence}

Heartbeat in, expire on silence.

```js
const peers = new Map(); // id -> { lastSeen, meta }
const TIMEOUT = 6000;

setInterval(() => emit("here", { meta: { name: myName } }), 2000);
on(
  "here",
  (msg) => peers.set(msg.from, { lastSeen: Date.now(), meta: msg.meta }),
);

setInterval(() => {
  const cutoff = Date.now() - TIMEOUT;
  for (const [id, peer] of peers) {
    if (peer.lastSeen < cutoff) peers.delete(id);
  }
  render([...peers.values()]);
}, 1000);

// leaving politely makes departures instant instead of taking TIMEOUT
addEventListener("pagehide", () => emit("gone", {}));
on("gone", (msg) => peers.delete(msg.from));
```

Announce yourself immediately on connect as well as on the interval, so peers
learn about you without waiting a full tick.

## Last-write-wins shared state

For small shared objects where perfect consistency is not worth the complexity:

```js
let state = {};
let version = 0;

const update = (patch) => {
  state = { ...state, ...patch };
  version = Date.now();
  emit("state", { state, version });
};

on("state", (msg) => {
  if (msg.version <= version) return; // stale or our own generation
  state = msg.state;
  version = msg.version;
  render(state);
});
```

Concurrent edits mean somebody's change disappears. That is an acceptable trade
for cursors and toggles, and a bad one for documents.

## CRDT transport {#crdt-transport}

For real collaborative editing, do not invent the merge logic. A CRDT library
handles convergence and only needs a way to move updates between peers — which
is exactly what a channel is.

```js
import * as Y from "yjs";

const doc = new Y.Doc();
doc.on("update", (update) => emit("y", { update: toBase64(update) }));
on("y", (msg) => Y.applyUpdate(doc, fromBase64(msg.update)));

// a joiner asks for the full document once, then stays in sync via updates
on(
  "y-request",
  () => emit("y", { update: toBase64(Y.encodeStateAsUpdate(doc)) }),
);
```

Remember to base64 the binary updates —
[binary frames are not routed](/guide/messages).

## Rate limiting yourself

Nothing throttles you, so high-frequency sources should throttle themselves.
Pointer moves at 60 Hz across ten peers is a lot of bandwidth for a cursor.

```js
let queued = null;
const sendThrottled = (msg) => {
  queued = msg;
};
setInterval(() => {
  if (queued) {
    send(JSON.stringify(queued));
    queued = null;
  }
}, 50); // 20 Hz is imperceptible for cursors and 3x cheaper
```

Coalescing — keeping only the newest value — is usually better than dropping or
buffering, because for live state the latest value is the only one that matters.

## One-way command channels

A producer that never wants to hear anything back can skip the websocket
entirely and just POST. Remember that POST reaches _everyone_, including other
producers.

```sh
curl -X POST "$ROUTER/$CHANNEL" -d '{"type":"reload"}'
```
