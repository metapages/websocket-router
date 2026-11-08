# Quickstart

There is nothing to install and nothing to create. Pick a channel name, connect,
and you are done.

## 1. Choose a channel name

The name is the address _and_ the only access control, so make it unguessable.
Six characters is the enforced minimum; a random 32 hex characters is a sensible
default.

```js
const channel = crypto.randomUUID();
```

## 2. Connect

```js
const ws = new WebSocket(
  `wss://router.metapage.io/${channel}`,
);

ws.addEventListener("message", (event) => {
  console.log("from a peer:", event.data);
});

ws.addEventListener("open", () => {
  ws.send("hello everyone else on this channel");
});
```

Open that same snippet in a second tab. Each tab sees the other's message, and
neither sees its own.

::: tip Use `wss://` in production
`ws://` is fine against `localhost`, but browsers refuse insecure websockets
from an `https://` page.
:::

## 3. Send from anywhere else

Any HTTP client can broadcast into a channel. The request body is delivered
verbatim to every listener.

::: code-group

```sh [curl]
curl -X POST \
  https://router.metapage.io/CHANNEL \
  -d '{"temperature": 21.4}'
```

```js [fetch]
await fetch(`https://router.metapage.io/${channel}`, {
  method: "POST",
  body: JSON.stringify({ temperature: 21.4 }),
});
```

```python [python]
import requests

requests.post(
    f"https://router.metapage.io/{channel}",
    data='{"temperature": 21.4}',
)
```

:::

Unlike a websocket send, a POST has no socket to exclude — every listener on the
channel receives it.

## A complete two-way client

Realistic clients reconnect, because networks and server deploys drop sockets.
This is the whole of a production-shaped client:

```js
/**
 * Join a channel. Returns a `send` function; `onMessage` is called for every
 * message from every other client on the channel.
 */
export const joinChannel = (channel, onMessage, origin = location.origin) => {
  const url = new URL(`/${channel}`, origin);
  url.protocol = url.protocol.replace("http", "ws");

  let ws;
  let queue = [];

  const connect = () => {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      queue.splice(0).forEach((message) => ws.send(message));
    });
    ws.addEventListener("message", (event) => onMessage(event.data));
    ws.addEventListener("close", () => setTimeout(connect, 500));
    ws.addEventListener("error", () => ws.close());
  };
  connect();

  return (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
    else queue.push(message);
  };
};
```

```js
const send = joinChannel(channel, (data) => console.log("peer:", data));
send(JSON.stringify({ cursor: { x: 10, y: 20 } }));
```

If you would rather not own that logic,
[`reconnecting-websocket`](https://www.npmjs.com/package/reconnecting-websocket)
is a drop-in `WebSocket` replacement and is what this project's own pages use.

## Running it locally

```sh
git clone https://github.com/metapages/websocket-router
cd websocket-router
just install
just dev        # http://localhost:3077
```

Then connect to `ws://localhost:3077/my-test-channel`. See
[Self-hosting](/guide/self-hosting) for the full setup.

## Next

- [Channels](/guide/channels) — naming rules and the security model.
- [Messages](/guide/messages) — payloads, ordering, and the reserved `ping`
  prefix.
- [Patterns](/guide/patterns) — request/response, presence, and state sync on
  top of raw fan-out.
