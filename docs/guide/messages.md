# Messages

## Payloads are opaque

The router never parses what you send. A message is forwarded byte for byte
and arrives unchanged. JSON, CSV, protobuf, a PNG, a bare number, a single
emoji — all equally valid, because the router has no opinion.

Most applications settle on JSON with a `type` field, which costs nothing and
makes it possible to add message kinds later:

```js
send(JSON.stringify({ type: "cursor", x: 120, y: 44 }));
```

## Binary frames

Binary websocket frames are routed as binary. A frame sent as binary arrives
as binary, and a frame sent as text arrives as text; neither is converted to
the other.

```js
const ws = new WebSocket("wss://router.metapage.io/a-name-nobody-will-guess");
// Otherwise the browser hands you a Blob.
ws.binaryType = "arraybuffer";

ws.onmessage = (event) => {
  if (typeof event.data === "string") {
    handleText(event.data);
  } else {
    handleBytes(new Uint8Array(event.data));
  }
};

ws.onopen = () => ws.send(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
```

Send a binary body over HTTP with `Content-Type: application/octet-stream`;
any other content type is routed as text.

```sh
curl -X POST https://router.metapage.io/a-name-nobody-will-guess \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @frame.png
```

::: tip No need to base64 any more
Earlier versions dropped binary frames, because every message crossed a redis
hop that carried text only, and the advice here was to base64-encode. That
redis hop is gone — see
[Architecture](/guide/architecture#what-changed-and-why). Base64 still works,
but it costs you 33% in size for nothing.
:::

::: warning The `ping` prefix is text-only
A **binary** frame whose bytes happen to spell `ping` is payload and is
routed normally. Only text frames are treated as keepalives.
:::

## Who receives what

| Sent via        | Received by                                         |
| --------------- | --------------------------------------------------- |
| `ws.send(...)`  | Every listener on the channel **except the sender** |
| `POST /channel` | Every listener on the channel, with no exception    |

Both cross server instances. It does not matter whether your peers landed on the
same process as you.

## The reserved `ping` prefix

::: danger This one will bite you if you send plain text
Any message **beginning with the four characters `ping`** is treated as a
keepalive. The server replies to the sender with

```
client ping: pong from server
```

and **does not forward it to the channel at all**.

So `ws.send("ping")` is a keepalive, and so — unintentionally — is
`ws.send("pinguin sighted")`.
:::

This is why JSON payloads are recommended: `{"type":"ping..."}` starts with `{`
and is routed normally. If you must send free text, prefix or wrap it:

```js
// safe: never begins with "ping"
send(JSON.stringify({ text: userInput }));
```

Nothing else is reserved. Every other byte sequence is forwarded untouched.

## Keepalives

Idle websockets get closed by intermediaries — browsers, proxies and load
balancers. Send `ping` on an interval to keep the connection warm:

```js
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send("ping");
}, 30_000);
```

The reply arrives as a normal `message` event, so filter it out of your
application handling:

```js
ws.addEventListener("message", (event) => {
  if (event.data === "client ping: pong from server") return;
  handle(event.data);
});
```

## Ordering

- **From one sender to one receiver: order is preserved.** Every message
  travels one path: a direct socket-to-socket write inside a single process.
- **Between different senders: no ordering at all.** Two clients sending
  simultaneously may be observed in either order, and two receivers may observe
  them in _different_ orders.

Do not build anything that depends on a global sequence. If you need one, put a
counter or a timestamp in the payload and reconcile client-side.

## Delivery

Best effort, no acknowledgements, no retries:

- Sent to a channel nobody is listening on: discarded, silently.
- A peer disconnects mid-flight: that copy is lost, and other peers still get
  theirs.
- A peer has stopped reading and has 8 MiB queued: messages to that peer are
  dropped. Other peers are unaffected, the drop is logged server-side, and the
  sender is not told.
- The server restarts: every socket closes with code 1001 and clients
  reconnect. Anything in flight is gone.

For anything that must not be lost, implement application-level acknowledgement
— see [request/response](/guide/patterns#request-response).

## Size and rate

There **is** a message size limit, and it is set per deployment: 1 MiB by
default on the public router, with a 16 MiB hard ceiling. An operator can
change it live from the [admin panel](/guide/admin).

Exceed it and the socket is closed with code **1009** (`Message Too Big`), or
a `POST` is answered with **413**. Handle 1009 as a permanent error for that
message — reconnecting and resending the same payload will close you again.

```js
ws.onclose = (event) => {
  if (event.code === 1009) {
    console.error("payload too large:", event.reason);
    return; // do not retry this message
  }
  reconnect();
};
```

There is no rate limiting, but note:

- Fan-out cost grows linearly with the number of peers on a channel. A 1 MiB
  message to 50 listeners is 50 MiB of egress.
- Nothing applies backpressure to senders. A receiver that stops reading is
  dropped past 8 MiB unflushed rather than buffered indefinitely.

Keep messages small — kilobytes, not megabytes — and put large blobs in object
storage, sending a URL over the channel instead.
