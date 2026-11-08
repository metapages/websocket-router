# Use cases

Everything below is the same primitive — fan-out to a shared name — used in
different shapes. They are worth reading even if none is exactly your problem,
because the shapes recur.

## Phone as a controller

The original motivation. A laptop drives a projector; a phone in someone's hand
should drive the laptop.

1. The laptop page generates a random channel and renders it as a QR code.
2. Someone scans it and their phone opens a page on the same channel.
3. The phone streams orientation, touch or button events into the channel.
4. The laptop applies them.

```js
// phone
addEventListener("deviceorientation", (e) => {
  send(JSON.stringify({ type: "tilt", alpha: e.alpha, beta: e.beta }));
});

// laptop
onMessage((data) => {
  const msg = JSON.parse(data);
  if (msg.type === "tilt") applyTilt(msg);
});
```

No pairing protocol, no app install, no server of your own. Works for slide
clickers, gamepads, remote laser pointers, and audience polls.

## Wiring components together

Two iframes, two tabs, or two entirely separate applications that share nothing
but a channel name. Because senders never see their own messages, both sides can
run identical code and simply react to whatever arrives.

This is the [metaframe](/guide/metapages) case: a channel becomes a pipe between
composable UI pieces that were never written to know about each other.

## Telemetry and live dashboards

A device, a cron job or a CI step POSTs readings; any number of dashboards
subscribe.

```sh
while true; do
  curl -sX POST "$ROUTER/$CHANNEL" \
    -d "{\"cpu\": $(get_cpu), \"at\": $(date +%s)}"
  sleep 1
done
```

The producer needs nothing but `curl`, and dashboards can come and go freely.
Nothing is stored, so a dashboard that opens later starts from the next reading
— usually exactly what you want for live metrics.

## Bridging a local process to the public internet

A script on your laptop and a page hosted anywhere agree on a channel name and
are connected. No tunnel, no ngrok, no port forwarding, no inbound firewall rule
— both sides make outbound connections.

```js
// on your laptop, node bridge.mjs
const ws = new WebSocket(`wss://router.metapage.io/${channel}`);
ws.onmessage = async (e) => {
  const result = await runLocally(JSON.parse(e.data));
  ws.send(JSON.stringify(result));
};
```

Good for driving local hardware from a hosted UI, exposing a local model or
dataset to a demo, and remote-controlling a build.

## Presence and collaborative touches

Cursors, selections, typing indicators, "three people are here". Small, live,
and worthless the moment they are stale — which is exactly the class of state
that suits an ephemeral router.

See the [presence pattern](/guide/patterns#presence) for an implementation.

## Nudging running apps

A webhook fires, a job finishes, a deploy completes: POST once and every open
tab reacts immediately, without polling.

```sh
# last line of a CI job
curl -X POST "$ROUTER/$CHANNEL" -d '{"type":"build","status":"green"}'
```

## Multiplayer prototypes and workshops

Room-based games, shared whiteboards, classroom exercises. The setup cost is a
random string, so you can hand a room out as a link and spend your time on the
actual idea instead of the plumbing.

## Where to use something else

Be deliberate about the boundary:

| You need                       | Use instead                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Late joiners to see history    | A database, or a peer that replays state on request                                               |
| Guaranteed delivery            | A real queue (SQS, NATS, Kafka)                                                                   |
| Per-user authorization         | Your own server, with the router as transport underneath                                          |
| Conflict-free shared documents | A CRDT library — which you can happily [transport over a channel](/guide/patterns#crdt-transport) |
| High-volume binary streams     | WebRTC, or a direct connection                                                                    |
