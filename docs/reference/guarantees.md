# Guarantees & limits

The precise contract. Build against this rather than against observed behaviour.

## What is guaranteed

**Sender exclusion.** A message sent over a websocket is never delivered back to
the socket that sent it. This holds absolutely, including across server
instances, and is enforced by socket identity rather than by anything in the
payload.

**Payload fidelity.** Text messages are delivered byte for byte. The router does
not parse, validate, transform, truncate or re-encode. The only messages that do
not arrive untouched are the ones that do not arrive at all —
[`ping`-prefixed keepalives](/guide/messages#the-reserved-ping-prefix) and
binary frames.

**Per-sender ordering to a given receiver.** Two messages from the same sender
arrive at any particular receiver in the order they were sent.

**Cross-instance reach.** Which instance a client connects to is invisible.
Fan-out spans all instances sharing a redis.

**Exactly-once local delivery.** A message is delivered to each eligible socket
exactly once, however many sockets are on the channel or the instance.

**Immediate channels.** No provisioning. A channel is live the moment a client
connects to the name.

## What is not guaranteed

**Delivery.** Best-effort only. No acknowledgements, no retries, no error to the
sender when delivery fails. A message sent to a channel with no listeners is
discarded silently.

**Ordering between different senders.** Two clients sending concurrently may be
observed in either order, and two receivers may observe them in _different_
orders. There is no global sequence.

**Simultaneous arrival.** Peers on the sender's own instance receive slightly
before peers elsewhere, because local delivery is direct and remote delivery
crosses redis.

**Durability.** Nothing is stored, ever. No history, no replay, no catch-up for
late joiners. Redis pub/sub retains nothing.

**Survival across restarts.** A deploy or crash drops every connection.
Reconnecting clients get a working channel again, but missed messages are gone.

**Latency bounds.** Typically a few milliseconds plus network, but nothing is
promised and nothing is prioritised.

**Backpressure.** Nothing throttles senders. A fast sender with slow receivers
buffers in the server process.

## Limits

|                     |                                                                   |
| ------------------- | ----------------------------------------------------------------- |
| Channel name length | minimum 6 characters; no maximum beyond URL limits                |
| Message size        | no configured limit; keep to kilobytes — everything crosses redis |
| Frame type          | text only; binary frames are dropped                              |
| Messages per second | not rate limited; you are expected to be reasonable               |
| Clients per channel | not limited; fan-out cost grows linearly                          |
| Concurrent channels | not limited                                                       |
| Message retention   | none                                                              |

## Security model

The complete model, stated plainly:

- **The channel name is the only secret.** Anyone who knows it has full read and
  write access.
- **Names never expire and cannot be revoked.** Rotating means agreeing on a new
  one.
- **No authentication, no authorization, no per-client identity.**
- **Transport is encrypted** (`wss://`, `https://`), but the router process and
  redis both see plaintext.
- **CORS is open to every origin**, deliberately: clients are arbitrary pages.
- **Names appear in URLs**, so they leak through history, referrers, screenshots
  and screen shares.

Concretely: fine for a presentation remote, a workshop demo, a dashboard of
non-sensitive telemetry, or peer components inside one product. Not fine, on its
own, for personal data, credentials, or anything with a compliance requirement.
For those, either put your own authenticated service in front of it, or encrypt
payloads client-side so the router only ever moves ciphertext.

## Failure behaviour

| Failure                  | Result                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Redis unreachable        | Clients on the same instance still reach each other. Cross-instance delivery stops. Failures are logged; senders are not told. |
| Redis missing at startup | The process throws and does not start.                                                                                         |
| Instance restarts        | Its sockets close. Other instances are unaffected. Clients must reconnect.                                                     |
| Slow client              | Messages buffer in the server process. No sender is throttled.                                                                 |
| Channel name too short   | Socket accepted, then closed with code `1008`.                                                                                 |
| Binary frame sent        | Dropped silently.                                                                                                              |
| POST to an empty channel | `200 OK`; the message is discarded.                                                                                            |

## Version compatibility

There is no protocol version and no negotiation. The wire format is "a
websocket, and strings". Any change to that would be a new endpoint rather than
a silent change to this one.
