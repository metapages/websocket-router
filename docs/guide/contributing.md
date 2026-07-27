# Contributing

## Setup

```sh
git clone https://github.com/metapages/websocket-router
cd websocket-router
just            # lists every command
```

You need [Deno](https://deno.land) 2.x, [just](https://github.com/casey/just),
Docker (for the test redis) and Node.js 20+ (for the docs).

## Before you push

```sh
just ci
```

That runs, in order, exactly what CI runs:

| Step                      | What it enforces                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `just fmt-check`          | `deno fmt --check` over the whole repository — TypeScript, JavaScript, JSON, CSS, HTML and Markdown |
| `just lint`               | `deno lint`                                                                                         |
| `just check`              | `deno check` on the server entrypoint                                                               |
| `just docs-not-committed` | That build output has not been committed                                                            |
| `just docs-build`         | The docs build, including vitepress' dead-link check                                                |
| `just test`               | The integration suite against a disposable redis                                                    |

If formatting fails, `just fmt` fixes it. Formatting is enforced rather than
suggested, so a CI failure on formatting is never a judgement call.

## Continuous integration

`.github/workflows/ci.yml` runs on **every push to a branch other than `main`**,
on pull requests targeting `main`, and on demand via workflow dispatch. There are
two jobs:

- **quality** — formatting, lint, type check, docs build. Fast, no services.
- **integration** — the full test suite against a redis service container.

## The test suite

`test/integration/` starts **real server processes** against a **real redis** and
drives them over **real websockets**. Nothing is mocked, because the behaviour
worth testing — fan-out across instances — only exists when there are several
processes and a redis between them.

```sh
just test                    # disposable redis in docker, then the suite
just test-only               # against whatever REDIS_URL points at
TEST_SERVER_LOGS=1 just test # stream the servers' own output
just test-only --filter "no duplicates"
```

`test/integration/harness.ts` provides:

- `startCluster(n)` — spawns `n` `src/serve.ts` processes on consecutive ports,
  waits for each `/healthcheck`, and captures their output for failure reports.
- `TestClient` — a websocket that records every message it receives, so tests
  assert on exact delivery _counts_ rather than just "something arrived".
- `randomChannel()` — a fresh channel per step, so steps never interfere.
- `settle()` — a pause long enough for a message to complete the
  client → server → redis → server → client round trip, and for any unwanted
  duplicate to have shown up.

### What it covers

The suite is one `Deno.test` with independent steps, so the cluster starts once:

- the HTTP surface — healthcheck, landing page, `/docs`, channel pages
- sender exclusion, on one instance and across instances
- **exactly-once delivery** with many sockets per instance (the regression that
  motivated the single-subscription-per-channel design)
- channel isolation, and the fact that leading path segments do not namespace
- `POST` fan-out to every listener, and `POST` to an empty channel
- the reserved `ping` prefix, and that pings never reach the channel
- byte-for-byte payload fidelity, including unicode, empty strings, `:`
  sequences and 100 KB messages
- binary frames being dropped without killing the connection
- per-sender ordering over 250 messages, locally and across instances
- concurrent senders, asserting per-sender order within an unordered whole
- rejection of short channel names with close code `1008`
- disconnects, rapid reconnects, and channel reuse after everybody leaves
- eight concurrent channels staying separate under load

### Writing a new test

Add a step inside the existing `Deno.test`, and follow the conventions:

```ts
await step("what should be true", async () => {
  const channel = randomChannel();
  const clients = await connectAll([
    { url: `${i0.ws}/${channel}`, label: "sender@i0" },
    { url: `${i1.ws}/${channel}`, label: "receiver@i1" },
  ]);
  const [sender, receiver] = clients;
  await settle(); // let the redis subscriptions establish

  sender.send("payload");
  await receiver.waitForMessage("payload");
  await settle(); // let any duplicate arrive before asserting counts

  assertEquals(receiver.countOf("payload"), 1);
  assertEquals(sender.received, []);

  await closeAll(clients);
});
```

Two rules that keep the suite from flaking:

1. **`settle()` after connecting**, before sending. A socket is open before the
   server has finished subscribing to redis, so a message sent immediately can
   legitimately be missed.
2. **`settle()` before asserting an absence.** "Nothing arrived" is only
   meaningful after enough time for something to have arrived.

## Code conventions

- Formatting is whatever `deno fmt` produces. Do not argue with it.
- The router core is `src/handlerWs.ts`. Keep it small and keep it readable —
  it is the file every contributor reads first.
- Comments should explain _why_, especially where the code looks odd. The
  instance-id prefix and the single-subscription-per-channel rule both look
  arbitrary until you know what they prevent.
- New behaviour needs a test in `test/integration/`, and a documentation change
  if it is visible to clients.

## Documentation

The docs are a separate npm project in `docs/`, built by vitepress and served by
the router at `/docs`. It uses Node rather than Deno on purpose: vitepress does
not build under Deno's isolated npm layout, because rollup cannot resolve the
`vue/server-renderer` subpath from `node_modules/.deno/`.

```sh
just docs-dev     # live reload while writing
just docs-build   # what CI checks
```

Vitepress fails the build on dead internal links, so `just docs-build` is a real
check rather than a formality.

`docs/package.json` carries an `overrides` block forcing patched `vite` and
`esbuild`. Vitepress 1.6.4 asks for versions with published advisories — all of
them dev-server issues that cannot reach production, since production serves
prebuilt static files — and vitepress 2 is still alpha. Remove the block when it
ships.

::: warning `docs/.vitepress/dist` is gitignored build output
It is built at deploy time and never committed. It still reaches production
because the `deploy.include` list in `deno.json` names the path explicitly:
`deno deploy` honours `.gitignore`, but an explicitly included **plain path**
(never a glob) is turned into a `!` negation and overrides it.

If you change where the docs are built, change `deploy.include` too, or `/docs`
will silently disappear from production. `just deploy` verifies the live
deployment afterwards precisely so that cannot go unnoticed.
:::
