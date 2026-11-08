# Production notes

Things worth deciding before you put a channel in front of real users.

## Treat channel names as credentials

There is no authentication. Anyone with the name has full read and write access,
forever, because names never expire.

- Generate them with a CSPRNG: `crypto.randomUUID()` in a browser,
  `crypto.randomUUID()` in Node and the browser, `secrets.token_urlsafe(32)` in Python.
- Never derive them from something enumerable — a user id, an email, an
  incrementing number, a date.
- Remember they end up in URLs, so they leak through screenshots, screen shares,
  browser history, referrer headers and chat logs. That is usually fine for a
  presentation; it is not fine for anything regulated.
- Rotate by simply agreeing on a new name. There is nothing to revoke.

If you need real authorization, put your own service in front and have it hand
out short-lived channel names to authenticated users. The router then becomes a
transport detail rather than the security boundary.

## Do not put sensitive data on a channel

Transport is TLS-encrypted end to end, but the router process sees plaintext and
For anything sensitive, encrypt in the client and let the router
move ciphertext it cannot read:

```js
// both peers already share a key, out of band
send(JSON.stringify({ iv, ciphertext }));
```

## Always reconnect

Sockets drop: deploys restart every instance, mobile networks change, laptops
sleep, proxies time out idle connections. A client without reconnection logic
will silently stop working and users will call it a bug in your app.

Reconnect with backoff, and re-request state after reconnecting — you were
disconnected, so you missed things, and nothing is replayed for you.

```js
ws.addEventListener("open", () => {
  emit("get-state", {}); // catch up on whatever happened while we were away
});
```

## Send keepalives

Idle connections get closed by intermediaries. A `ping` every 30 seconds is
cheap insurance:

```js
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send("ping");
}, 30_000);
```

## Throttle high-frequency sources

Pointer moves, device orientation and animation frames all fire far faster than
anyone can perceive. Coalesce to 10–20 Hz before sending. Every message crosses
is delivered to every peer, so the cost is multiplied by the number of
listeners.

## Keep payloads small

Kilobytes, not megabytes. Put large or binary content in object storage and send
a URL. Remember [binary frames are not routed](/guide/messages) — base64 costs
33% on top of an already large payload.

## Design for messages that never arrive

There are no acknowledgements. Design so that a lost message is recoverable:

- Prefer **idempotent state updates** ("the value is now 42") over
  **increments** ("add one"), so a repeat or a loss self-corrects on the next
  update.
- Re-send current state periodically if it matters, rather than only on change.
- Use [request/response with a timeout](/guide/patterns#request-response) when
  you genuinely need to know something got through.

## Ignore what you do not recognise

Channels are shared with older versions of your own app, other tabs, and
anything else that has the name. Parse defensively, ignore unknown message
types, and never assume a payload is well-formed JSON.

## Watch out for the `ping` prefix

Any message starting with `ping` is swallowed by the server as a keepalive and
never reaches the channel. If you are relaying user-supplied text, wrap it in
JSON rather than sending it raw. See
[messages](/guide/messages#the-reserved-ping-prefix).

## Have a fallback

The router has no SLA and channels are ephemeral. For anything that must keep
working, make the realtime path an enhancement over a polling or on-demand path
rather than the only way your app gets data.
