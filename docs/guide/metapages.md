# Metapages & metaframes

The router grew out of [metapage](https://metapage.io), and the channel web page
doubles as a ready-made metaframe. If you are not building metapages, you can
skip this page entirely — nothing here is required to use the router.

## The channel page is a metaframe

Loading a channel URL in a browser serves a small page that:

- renders a QR code of the channel URL, so a phone can join by scanning it,
- opens a reconnecting websocket to that channel,
- forwards **metaframe inputs** onto the channel as JSON, and
- turns **JSON messages from the channel** into metaframe outputs.

In other words, dropping `https://router.metapage.io/<channel>`
into a metapage gives you a pipe. Anything piped into that metaframe appears on
the channel; anything on the channel appears on its outputs.

Two metaframes on the same channel are connected, even in different metapages,
different browsers, or on different devices.

```
metaframe A ──inputs──▶ [ channel ] ──outputs──▶ metaframe B
metaframe B ──inputs──▶ [ channel ] ──outputs──▶ metaframe A
```

Because the router never echoes to the sender, a metaframe piped into itself
does not loop.

## Payload shape

Metaframe inputs are sent as a JSON object of the whole input set:

```json
{ "y": 0.42, "label": "sensor-3" }
```

Incoming messages are parsed and applied as outputs when they are a JSON object.
Non-JSON messages are ignored by the metaframe bridge but are still delivered to
any raw websocket client on the same channel — so you can mix a metaframe and a
plain client freely, as long as the metaframe side speaks JSON objects.

## URL options

| Option            | Where        | Effect                                                      |
| ----------------- | ------------ | ----------------------------------------------------------- |
| `?hidden=true`    | query string | Do not render the QR code                                   |
| `#?forward=<url>` | hash         | Also relay every incoming message to a second websocket URL |

`forward` chains channels together. It accepts an `http(s)` or `ws(s)` URL and
converts the scheme automatically, which makes a one-line bridge between two
channels:

```
https://router.metapage.io/channel-a#?forward=https://router.metapage.io/channel-b
```

Messages arriving on `channel-a` are republished onto `channel-b`.

::: warning Do not create a cycle
Forwarding `a → b` while also forwarding `b → a` produces an infinite loop. The
sender-exclusion rule does not save you here, because the forwarder is a
distinct client on each channel.
:::

## A test metapage

Open the channel page outside an iframe and it renders a **Test application**
link. That link opens a prebuilt metapage wiring a random data generator through
several router metaframes and passthrough viewers — useful for confirming end to
end that routing, duplication and forwarding all behave.

## Using a channel directly from your own metaframe

You do not have to use the provided page. Any metaframe can talk to a channel
itself:

```js
import { Metaframe } from "https://cdn.jsdelivr.net/npm/@metapages/metapage@0.15.0/+esm";

const mf = new Metaframe();
const ws = new WebSocket(`wss://router.metapage.io/${channel}`);

mf.onInputs((inputs) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(inputs));
});

ws.addEventListener("message", (event) => {
  try {
    mf.setOutputs(JSON.parse(event.data));
  } catch {
    // not JSON, not for us
  }
});
```

This gives you control over throttling, filtering and message types, which the
generic page deliberately does not impose.
