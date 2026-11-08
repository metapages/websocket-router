# Connection inspector

Something is connected to your router and you want to know what it is.

The [admin panel](/guide/admin) tells you *how many* channels and connections
there are. The inspector tells you **which**: every channel with a live
connection, how long each socket has been up, where it came from, and — by
subscribing to the channel like any other client — what it is sending, as it
sends it.

It is off unless you set `INSPECT_KEY`.

## Turning it on

```sh
openssl rand -hex 16        # 32 characters; anything over 16 will do
```

Put it in the environment file and deploy:

```sh
# /opt/websocket-router/env
INSPECT_KEY=4f8a2c91e7b3d6054a1f8e2c7b9d3056
```

The inspector is then at `https://your-router/4f8a2c91e7b3d6054a1f8e2c7b9d3056`.

From CI instead, which is the usual way, set it once as a repository secret:

```sh
gh secret set INSPECT_KEY
```

`deploy.sh` writes it into the host's environment file on every deploy, so
rotating it is a push. See [the workflows
README](https://github.com/metapages/websocket-router/blob/main/.github/workflows/README.md).

To check it arrived without opening it, the admin panel's **Inspector** card
reads `on` or `off`. `deploy/status.sh` prints the same thing per host.

## The path is the password

There is no login form. The URL is the entire credential, which has two
consequences worth being deliberate about.

**It cannot be found by probing.** Every path this router does not claim is a
channel, so a wrong guess is served an ordinary channel page — exactly what
`/anything-else` returns. There is nothing that answers differently to a
near miss, no 401, and no login to attack.

**A URL is the one credential browsers write down.** It goes in the address
bar, the history and, by default, the `Referer` header. The inspector's
responses are therefore `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`, and its page loads nothing cross-origin. Treat
the link like a password anyway: do not paste it into a chat you would not
paste a password into.

**What it lists are other people's credentials.** A channel name is the only
thing protecting a channel — see [Channels](/guide/channels) — so a list of
channel names is a list of keys to every conversation on the router. Anyone
holding `INSPECT_KEY` can read and write every channel that is in use, by
connecting to it normally. That is a far stronger capability than the admin
panel has, and it is the reason this is a long random key rather than a
memorable path.

It is a different secret from `ADMIN_PASSWORD` on purpose. The panel reads
logs and changes settings; the inspector only watches. Wanting to hand someone
the second is not a reason to hand them the first.

::: tip Rotating
Change `INSPECT_KEY` and deploy. The old path becomes an ordinary channel name
again the moment the process restarts.
:::

## What it shows

One card per channel, busiest first:

| | |
| --- | --- |
| **Title** | the channel name — the thing a client connected to |
| **up** | since the oldest connection on that channel arrived |
| **connections** | how many sockets, excluding anyone watching |
| **last message** | the most recent message seen *since you opened the page* |
| **table** | per socket: id, how long it has been up, address, `Origin`, `User-Agent` |

`Origin` and `User-Agent` are usually the answer to "what is this?". A browser
tab opened from a metapage sends both; a script using a bare websocket library
sends neither, which is itself a clue.

The socket id is the same short id that appears in the logs, so a connection
in the inspector can be followed into `just logs <host>`.

## Messages are not stored

The server keeps no message history — not for the inspector, not for anyone.
The page subscribes to each listed channel over the normal websocket API and
shows what arrives from that moment on. Open it after something interesting
happened and you have missed it.

That is a deliberate trade. A buffer deep enough to be useful would have to be
paid for on every channel whether or not anyone was ever going to look, and
the router's whole shape — [one process, no
broker](/guide/architecture) — comes from not paying for things nobody asked
for.

## Watching does not change what is watched

An inspector socket is marked at the handshake (`?observe=<key>`), and the
server treats it differently from every other client:

- it is **excluded from every count**, in the inspector and in the admin
  panel, so looking at a channel does not make it appear busier;
- a channel kept open only by watchers **stops being listed**, so the
  inspector cannot make an empty channel look occupied;
- **it may not send.** Anything an observing socket sends is dropped by the
  server, not merely omitted by the page. A read-only tool that can write is
  a tool that can corrupt the thing it was brought in to diagnose.

The one exception is a `ping` keepalive, which is answered as usual so the
socket can stay open.

Other clients cannot tell they are being watched: there is no notification,
and the subscriber count they would see does not change.

## Limits

- **50 channels are watched at once**, the busiest first. The list itself goes
  up to 200 channels; above that it says `list truncated`.
- **Each host is its own router.** The inspector shows the host you loaded it
  from, and nothing about the others. With more than one host in
  `DEPLOY_HOSTS`, open each one's own URL.
- A restart clears everything, because there was nothing stored to clear.
