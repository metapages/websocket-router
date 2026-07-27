# API reference

Base URL of the public instance:

```
https://router.metapage.io
```

CORS is open on every route.

## `WS /:channel`

Join a channel. The channel name is the **last path segment** of the URL.

```
wss://router.metapage.io/room-8f2a1c
```

|                  |                                              |
| ---------------- | -------------------------------------------- |
| **Protocol**     | `wss://` (or `ws://` against a local server) |
| **Subprotocols** | none                                         |
| **Auth**         | none — the channel name is the only secret   |
| **Frames**       | text only; binary frames are dropped         |

### Connecting

```js
const ws = new WebSocket(
  "wss://router.metapage.io/room-8f2a1c",
);
```

The socket is accepted immediately. There is no join handshake and no
confirmation message — once `open` fires you are subscribed.

If the channel name is shorter than **six characters**, the socket is accepted
and then closed with code `1008` and reason `channel name too short`.

### Sending

```js
ws.send("any string you like");
```

Delivered to every other client on the channel, on every server instance. Never
delivered back to the sender.

Two exceptions:

- A message beginning with `ping` is a [keepalive](#keepalives): the server
  replies to the sender and forwards nothing.
- Binary frames are dropped without error.

### Receiving

```js
ws.addEventListener("message", (event) => {
  // event.data is a string, byte-identical to what the peer sent
});
```

You receive every message any _other_ client sends to the channel, plus every
`POST` to it, plus your own `pong` replies.

### Keepalives

| Send                             | Receive                         |
| -------------------------------- | ------------------------------- |
| any message starting with `ping` | `client ping: pong from server` |

The reply goes only to the sender and arrives as an ordinary `message` event.

### Close codes

| Code           | Meaning                                             |
| -------------- | --------------------------------------------------- |
| `1000`         | Normal close, initiated by either side              |
| `1008`         | Channel name shorter than six characters            |
| `1001`, `1006` | Server restart, deploy, or network loss — reconnect |

## `POST /:channel`

Broadcast the request body to a channel from any HTTP client.

```sh
curl -X POST \
  https://router.metapage.io/room-8f2a1c \
  -d '{"temperature": 21.4}'
```

|                  |                                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| **Body**         | Any text. Delivered verbatim; `Content-Type` is ignored.                 |
| **Response**     | `200 OK`, body `OK!`, `text/plain`                                       |
| **Delivered to** | **Every** listener on the channel — there is no sender socket to exclude |

The response only means the router accepted the request. It says nothing about
whether anyone was listening; posting to an empty channel returns `200` and the
message is discarded.

::: warning Single path segment only
`POST /room-8f2a1c` routes. `POST /a/b/room-8f2a1c` does not — it falls through
to the channel page and does not broadcast.
:::

The `ping` prefix is **not** special on this route: `POST` bodies are always
forwarded as-is.

## `GET /:channel`

Serves the channel web page: a QR code of the channel URL plus a metaframe
bridged onto the channel. See [metapages & metaframes](/guide/metapages).

| Query          | Effect               |
| -------------- | -------------------- |
| `?hidden=true` | Suppress the QR code |

## `GET /healthcheck`

```
200 OK
OK
```

Liveness and readiness probe. Returns `200` whenever the process is serving,
including when redis is unavailable — the server still routes between clients on
the same instance in that state.

## `GET /`

The landing page.

## `GET /docs/*`

This documentation. Returns `503` with instructions if the site has not been
built into `docs/.vitepress/dist`.

## Everything at a glance

| Method | Path           | Purpose                         |
| ------ | -------------- | ------------------------------- |
| `GET`  | `/`            | Landing page                    |
| `GET`  | `/docs/*`      | Documentation                   |
| `GET`  | `/healthcheck` | `OK`                            |
| `GET`  | `/:channel`    | Channel page (QR + metaframe)   |
| `POST` | `/:channel`    | Broadcast body to all listeners |
| `WS`   | `/:channel`    | Join the channel                |
