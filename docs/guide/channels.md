# Channels

A channel is a name. There is no create step, no delete step, and no registry.
The channel exists while at least one client is connected to it and stops
existing when the last one leaves.

## Addressing

The channel name is the **last path segment** of the URL:

| URL                               | Channel       |
| --------------------------------- | ------------- |
| `wss://host/room-8f2a1c`          | `room-8f2a1c` |
| `wss://host/a/b/room-8f2a1c`      | `room-8f2a1c` |
| `wss://host/room-8f2a1c?debug=1`  | `room-8f2a1c` |
| `wss://host/room-8f2a1c#anything` | `room-8f2a1c` |

Three consequences worth internalising:

::: warning Leading path segments are ignored
`wss://host/alice/secret` and `wss://host/bob/secret` are **the same channel**.
Nested paths do not namespace anything. If you want structure in your names, put
it in the segment itself: `team-alice--room-secret`.
:::

- **Query strings do not distinguish channels.** They are available to the
  server but play no part in routing, so `?user=alice` is a label for your own
  code, not an isolation mechanism.
- **Fragments never reach the server at all.** `#state` is browser-local by
  definition.

For HTTP POST the channel must be a **single** path segment —
`POST /room-8f2a1c` works, `POST /a/b/room-8f2a1c` does not route.

## Naming rules

- **Minimum six characters.** Shorter names are rejected: the websocket is
  accepted and then immediately closed with code `1008`.
- **URL-safe characters only**, since the name lives in a path segment. Stick to
  `A–Z a–z 0–9 - _ .` and you will never think about encoding.
- **Case sensitive.** `Room-A` and `room-a` are different channels.
- No other restriction. Names are not reserved, registered or rate limited.

::: danger The name is the password
Anyone who knows or guesses the channel name can read everything on it and write
anything to it. There is no other authentication. Generate names with a CSPRNG
and treat them exactly as you would treat a bearer token.

```js
// good: 128 bits of entropy
const channel = crypto.randomUUID();

// bad: guessable, enumerable, or shared in a URL people can screenshot
const channel = `user-${userId}`;
```

:::

## Lifecycle

1. The first client connects. The server instance registers the socket and
   subscribes to the redis channel of the same name.
2. More clients connect, to this instance or any other. Each instance keeps
   exactly one redis subscription per channel, regardless of how many local
   sockets it has.
3. The last client on an instance disconnects. That instance unsubscribes.
4. When no instance anywhere has a listener, nothing about the channel exists.
   Redis pub/sub keeps no state for channels with no subscribers.

Because channels are pure convention, **a message sent to a channel with no
listeners is silently discarded**. There is no error, no buffering, and no way
to find out afterwards. If a client needs the current state on joining, it has
to ask for it — see [request/response](/guide/patterns#request-response).

## Discovering who is there

There is no membership API, no join/leave event, and no way to count listeners.
If your app needs presence, build it in the payload layer:
[presence](/guide/patterns#presence) shows a heartbeat approach that is about
fifteen lines.

## The channel web page

Opening a channel URL in a browser —
`https://websocket-router.metapage.deno.net/room-8f2a1c` — serves a small page
rather than a websocket. It renders a QR code of the channel URL and acts as a
[metaframe](/guide/metapages) bridged onto the channel, which makes "scan this
to connect your phone" a one-step affair.

Add `?hidden=true` to suppress the QR code.

That page is a convenience, not part of the protocol. Your own clients never
need to load it.
