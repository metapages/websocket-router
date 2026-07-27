# Messages

## Payloads are opaque

The router never parses what you send. A message is a string, it is forwarded
byte for byte, and it arrives as the same string. JSON, CSV, base64, a bare
number, a single emoji — all equally valid, because the router has no opinion.

Most applications settle on JSON with a `type` field, which costs nothing and
makes it possible to add message kinds later:

```js
send(JSON.stringify({ type: "cursor", x: 120, y: 44 }));
```

::: warning Text frames only
Binary websocket frames (`ArrayBuffer`, `Blob`) are **dropped, not routed** —
the redis hop between server instances carries text. Send binary as base64 or a
data URL.

```js
const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
send(JSON.stringify({ type: "frame", base64 }));
```

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

Idle websockets get closed by intermediaries — browsers, proxies, load
balancers, and Deno Deploy itself. Send `ping` on an interval to keep the
connection warm:

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

- **From one sender to one receiver: order is preserved.** Messages travel a
  single path, whether that is a direct socket-to-socket hop within one instance
  or a redis publish between two.
- **Between different senders: no ordering at all.** Two clients sending
  simultaneously may be observed in either order, and two receivers may observe
  them in _different_ orders.
- **A sender's local peers and its remote peers are separate paths.** Local
  delivery happens synchronously; remote delivery goes through redis. Clients on
  the sender's own instance usually see a message a fraction earlier than
  clients elsewhere.

Do not build anything that depends on a global sequence. If you need one, put a
counter or a timestamp in the payload and reconcile client-side.

## Delivery

Best effort, no acknowledgements, no retries:

- Sent to a channel nobody is listening on: discarded, silently.
- A peer disconnects mid-flight: that copy is lost, and other peers still get
  theirs.
- Redis is briefly unavailable: local peers still receive, remote peers do not.
  The failure is logged server-side, and the sender is not told.

For anything that must not be lost, implement application-level acknowledgement
— see [request/response](/guide/patterns#request-response).

## Size and rate

There is no configured message size limit and no rate limiting, but there are
practical ceilings you should respect:

- Every message crosses redis, so large payloads consume the whole cluster's
  bandwidth, not just your channel's.
- Deno Deploy has its own request and memory limits.
- Nothing applies backpressure. A fast sender with a slow receiver buffers in
  the server process.

Keep messages small — kilobytes, not megabytes — and put large blobs in object
storage, sending a URL over the channel instead.
