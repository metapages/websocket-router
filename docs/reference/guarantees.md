# Guarantees & limits

The precise contract. Build against this rather than against observed
behaviour.

## What is guaranteed

**Sender exclusion.** A message sent over a websocket is never delivered back
to the socket that sent it. Enforced by socket identity, never by anything in
the payload.

**Payload fidelity.** Messages are delivered byte for byte. The router does
not parse, validate, transform, truncate or re-encode. A text frame arrives as
a text frame and a binary frame arrives as a binary frame. The only messages
that do not arrive untouched are the ones that do not arrive at all —
[`ping`-prefixed keepalives](/guide/messages#the-reserved-ping-prefix).

**Per-sender ordering to a given receiver.** Two messages from the same sender
arrive at any particular receiver in the order they were sent.

**Exactly-once delivery.** A message reaches each eligible socket exactly
once, however many sockets are on the channel.

**Immediate channels.** No provisioning. A channel is live the moment a client
connects to the name.

**Binary and text are both first-class.** Neither is converted to the other.

## What is not guaranteed

**Delivery.** Best-effort only. No acknowledgements, no retries, no error to
the sender when delivery fails. A message sent to a channel with no listeners
is discarded silently.

**Ordering between different senders.** Two clients sending concurrently may
be observed in either order, and two receivers may observe them in
*different* orders. There is no global sequence.

**Durability.** Nothing is stored, ever. No history, no replay, no catch-up
for late joiners.

**Survival across restarts.** A deploy or crash closes every connection with
code 1001 ("going away"). Reconnecting clients get a working channel again,
but missed messages are gone. This is routine, not exceptional — clients must
reconnect.

**Reach across hosts.** Two hosts are two independent routers. A channel on
one is unrelated to the same name on the other. See
[Architecture](/guide/architecture#the-consequence-a-host-is-a-router).

**Latency bounds.** Typically well under a millisecond plus network, but
nothing is promised and nothing is prioritised.

**Backpressure.** Nothing throttles senders. A slow receiver is dropped from
individual messages rather than slowing anyone else down — see below.

## Limits

| | |
| --- | --- |
| Channel name length | minimum 6 characters; no maximum beyond URL limits |
| Message size | `1 MiB` by default, changeable live from the [admin panel](/guide/admin), hard ceiling `16 MiB` |
| Frame type | text and binary both routed |
| Unflushed data per socket | 8 MiB, after which messages to that socket are dropped |
| Messages per second | not rate limited; you are expected to be reasonable |
| Clients per channel | not limited; fan-out cost grows linearly |
| Concurrent channels | not limited |
| Message retention | none |

### On the two size limits

The **configurable** limit (admin panel, persisted) is the policy you choose.
Exceeding it closes the socket with code **1009** (`Message Too Big`) or
answers a `POST` with **413**.

The **hard** ceiling (`WS_HARD_MAX_MESSAGE_BYTES`) is enforced by the
websocket library before a frame is ever assembled in memory. It exists
because one process has no second instance to absorb a hostile payload, and
the configurable limit cannot be raised above it.

### On the backpressure drop

Once a socket has more than 8 MiB queued and unflushed, further messages to
*that socket* are dropped and a warning is logged.

Delivery is best-effort by design, and with one process a single client that
stops reading would otherwise grow the heap until the box dies. Dropping for
that one socket keeps every other client on the channel unaffected. The
sender is not told, consistent with everything else here.

## Security model

The complete model, stated plainly:

- **The channel name is the only secret.** Anyone who knows it has full read
  and write access.
- **Names never expire and cannot be revoked.** Rotating means agreeing on a
  new one.
- **No authentication, no authorization, no per-client identity.**
- **Transport is encrypted** (`wss://`, `https://`), but the router process
  sees plaintext.
- **CORS is open to every origin**, deliberately: clients are arbitrary pages.
- **Names appear in URLs**, so they leak through history, referrers,
  screenshots and screen shares.
- **Payloads are never logged.** Channel names are, because they are the
  routing key an operator needs.
- **The admin panel is a separate secret** and does not exist unless
  `ADMIN_PASSWORD` is set. It has no route that can read channel traffic.

Concretely: fine for a presentation remote, a workshop demo, a dashboard of
non-sensitive telemetry, or peer components inside one product. Not fine, on
its own, for personal data, credentials, or anything with a compliance
requirement. For those, either put your own authenticated service in front of
it, or encrypt payloads client-side so the router only ever moves ciphertext.

## Failure behaviour

| Failure | Result |
| --- | --- |
| Process restarts | Every socket closes with 1001. Clients must reconnect. |
| Process crashes | pm2 restarts it; it gives up after 10 rapid failures rather than crash-looping. |
| Slow client | Messages to it are dropped past 8 MiB unflushed. Nobody else is affected. |
| Channel name too short | Upgrade refused with HTTP 400 before the socket is accepted. |
| Reserved path | Upgrade refused with HTTP 404. |
| Oversize frame | Socket closed with 1009. |
| Oversize `POST` | `413`, message discarded. |
| `POST` to an empty channel | `200 OK`; the message is discarded. |
| Certificate renewal fails | Logged and retried; the existing certificate keeps serving. |
| First certificate issuance fails | The process does not start. There is nothing to serve. |

## Version compatibility

There is no protocol version and no negotiation. The wire format is "a
websocket, and bytes". Any change to that would be a new endpoint rather than
a silent change to this one.

Note for anyone who used the Redis-era deployment: the client-visible contract
is unchanged except that binary frames are now routed instead of dropped, and
a configurable size limit now exists. Nothing that worked before stops
working.
