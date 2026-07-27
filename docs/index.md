---
layout: home

hero:
  name: Websocket Router
  text: A public address space for realtime messages
  tagline: Connect a websocket to any URL. Everything you send goes to every other client on that URL — and to nobody else. No accounts, no SDK, no setup.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: What is this?
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/metapages/websocket-router

features:
  - icon: 🔌
    title: A channel is just a URL
    details: No provisioning step, no create call, no config. Pick a name nobody can guess, connect, and the channel exists for as long as someone is listening.
    link: /guide/channels
    linkText: How channels work
  - icon: ↔️
    title: Everyone but the sender
    details: The single rule of the router. Peers can broadcast into a channel without having to filter out their own echo, which is what makes symmetric peer-to-peer app code trivial.
    link: /guide/messages
    linkText: How messages flow
  - icon: 📨
    title: Bring your own payload
    details: Strings in, the same strings out. JSON, CSV, base64, a single emoji — the router never parses, validates or transforms what you send.
    link: /reference/api
    linkText: The whole API
  - icon: 🌍
    title: Scales past one process
    details: Instances share channels over redis pub/sub, so it does not matter which server your clients happen to land on. Add instances, the routing keeps working.
    link: /guide/architecture
    linkText: Architecture
  - icon: 🧩
    title: Made for gluing things together
    details: Phone to laptop, tab to tab, script to browser, iframe to iframe. Especially good at connecting components that were never designed to know about each other.
    link: /guide/use-cases
    linkText: Use cases
  - icon: ⚖️
    title: Honest about the trade-offs
    details: No persistence, no replay, no delivery guarantees, no auth beyond the secrecy of the channel name. Ephemeral by design, and documented as such.
    link: /reference/guarantees
    linkText: Guarantees & limits
---

## In thirty seconds

```js
const ws = new WebSocket(
  "wss://websocket-router.metapage.deno.net/a-name-nobody-will-guess",
);

// Anything any other client sends to that URL arrives here.
ws.onmessage = (event) => console.log("peer said:", event.data);

// Anything we send goes to all of them — but never back to us.
ws.onopen = () => ws.send(JSON.stringify({ hello: "world" }));
```

And from anything that can make an HTTP request:

```sh
curl -X POST \
  https://websocket-router.metapage.deno.net/a-name-nobody-will-guess \
  -d '{"temperature": 21.4}'
```

That is the entire product surface. The rest of these docs is about what that
turns out to be good for, and where the edges are.
