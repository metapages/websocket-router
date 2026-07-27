# Introduction

The websocket router is a **shared address space for realtime messages**.

You connect a websocket to a URL. Anything you send is delivered to every other
client connected to that same URL, and to nobody else. That is the whole idea.

```
                      wss://…/my-channel
   client A  ──send──▶   ┌──────────┐   ──────▶  client B
                         │  router  │
   client C  ◀───────────└──────────┘   ◀──send── client D

   every message reaches every listener on the channel
   except the one that sent it
```

## Why it exists

Most realtime work does not need a realtime _platform_. It needs two things to
be introduced to each other:

- a phone and the laptop driving a projector,
- a browser tab and a script on your machine,
- two iframes that have never heard of one another,
- a sensor and a dashboard.

Doing that properly normally means standing up a server, choosing a protocol,
modelling rooms and members, handling auth, and deploying it. That is a lot of
scaffolding for "send this blob over there."

The router removes all of it. A channel is a name. A client is a websocket. A
message is bytes whose meaning you decided. There is nothing else to learn and
nothing to provision.

## The one rule

> A message goes to **every listener on the channel except the sender**.

That asymmetry is the important design decision. Because senders never receive
their own messages, every client can run the same code — broadcast freely, react
to everything that arrives — without needing sender ids, echo suppression, or
loop detection. Symmetric peers become the easy case rather than the hard one.

The one exception is [HTTP POST](/reference/api#post-channel): a POST has no
socket to exclude, so it reaches _everyone_ on the channel.

## What it deliberately is not

It is a router, not a message broker and not a database.

- Messages are **not stored**. If nobody is listening when you send, the message
  is gone. There is no queue, no replay and no history for late joiners.
- Delivery is **best-effort**. There are no acknowledgements and no retries.
- There are **no accounts**. The channel name is the only thing keeping other
  people out, so treat it like a password.
- Payloads are **never inspected**. The router does not parse, validate or
  transform anything you send.

If you need durability, ordering across senders, or real authorization, the
router is the wrong layer — but it is often a fine transport underneath
something that provides those.

See [Guarantees & limits](/reference/guarantees) for the precise list.

## Is it right for what you are building?

**A good fit when**

- state is live and disposable — cursors, gestures, sensor readings, "who's
  here"
- the participants are peers rather than clients of a server
- you want zero setup for a demo, a prototype, a workshop, or a metapage
- the channel name can be a shared secret between the participants

**A bad fit when**

- a client that joins late needs to know what it missed
- you need to know a message definitely arrived
- different users must not be able to reach each other's data even if they guess
  a name
- payloads are large or high-volume enough to need flow control

## Where to go next

- [Quickstart](/guide/quickstart) — a working channel in a few lines.
- [Channels](/guide/channels) — naming, addressing, and the security model.
- [Use cases](/guide/use-cases) — what this shape is actually good for.
- [API reference](/reference/api) — every endpoint, precisely.
