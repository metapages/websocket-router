# Contributing

## What you need

- **Node.js 22+** — the server runtime and the build toolchain
- **[just](https://github.com/casey/just)** — the command runner
- **Docker** — the test suite runs in containers

```sh
git clone https://github.com/metapages/websocket-router
cd websocket-router
just install
just dev          # http://localhost:3077
```

`just dev` builds the browser bundles, then runs `vite build --watch` and
`tsx watch` side by side with the admin panel enabled (password `dev`). A
change under `web/` is rebuilt and picked up without a restart; a change under
`src/` restarts the server. No configuration file is needed — every setting
has a working default.

Use `just prod` to check anything that differs in production: precompressed
assets, the built docs at `/docs`, and the fact that `NODE_ENV=production`
turns off the dev-only channel-template reload.

`just` on its own lists every recipe.

## Commands

| | |
| --- | --- |
| `just dev` | Watches `web/` and `src/`; rebuilds and restarts as needed |
| `just dev-once` | The source server, no watchers |
| `just prod` | Full build, `NODE_ENV=production`, as production runs it |
| `just build` | Server, browser bundles, precompressed variants |
| `just build-all` | The above plus the docs. What `deploy.sh` runs. |
| `just check` | Type check server, browser and test sources |
| `just test` | The integration suite in docker-compose |
| `just test-acme` | Certificate issuance against pebble |
| `just test-all` | Both |
| `just test-local` | The suite on the host — faster, narrower |
| `just test-watch` | Watch mode |
| `just docs-dev` | Live-reloading documentation |
| `just ci` | Everything CI enforces |

## How the tests work

**Nothing is mocked.** Every test starts a real `node dist/server/index.js`
process with an environment, and drives it over real sockets. The suite builds
first, so you are always testing the artefact that ships.

That choice is deliberate. The things this project can get wrong are the
things only a real process has: TLS, privilege level, precompressed files on
disk, log rotation in a worker thread, the process lifecycle. A unit test with
a mocked socket would pass while all of them were broken.

### The two environments

```sh
just test        # docker-compose: the default, and what CI runs
just test-local  # the host: faster to iterate
```

`just test-local` skips two things it cannot cover:

- **Non-root operation.** The compose service runs as uid 10001, and the
  admin stats test asserts `uid != 0` when `EXPECT_NON_ROOT=1`.
- **Certificate issuance**, which needs pebble.

Iterate with `just test-local`, then confirm with `just test` before pushing.

### The ACME suite

`just test-acme` brings up [pebble](https://github.com/letsencrypt/pebble) —
Let's Encrypt's own test ACME server — plus `challtestsrv` for DNS, and runs a
real issuance: order, HTTP-01 challenge, certificate written to disk, https
listener, wss round trip over it.

Mocking `acme-client` instead would test the mock. What can actually break is
the challenge route, the on-disk key handling, the certificate hot-swap and
the port-80 redirect, and only a real CA exercises those.

Two things about the setup are worth knowing before you debug it:

- `test/fixtures/pebble.minica.pem` signs **pebble's own listener**, not the
  certificates pebble issues. Issued certificates chain to a root pebble
  generates on each start and serves from its management API at `/roots/0`.
  Confusing the two produces an unknown-issuer error that looks like a router
  bug. See `test/fixtures/README.md`.
- pebble validates on port 5002, so the test sets
  `ACME_SKIP_CHALLENGE_VERIFICATION=true`. acme-client's own pre-flight check
  always uses port 80 and could never succeed there. **Production leaves that
  off** — the pre-flight catches a closed port before an order is submitted.

### Layout

```
test/
  helpers/
    server.ts    starts and stops real server processes
    client.ts    a websocket that records what it receives, by frame type
    admin.ts     a cookie-jar client for the admin API
  integration/
    routing.test.ts   the delivery contract
    limits.test.ts    message size, and changing it live
    admin.test.ts     authentication, settings, logs, stats
    http.test.ts      routes, compression, caching, traversal
    logging.test.ts   log structure and rotation
    acme.test.ts      certificates (compose only)
  fixtures/
```

### Writing a test

Use `randomChannel()` for a fresh name per test — tests share a server process
and would otherwise interfere. `TestClient` records text and binary
separately, so assert on counts rather than "did something arrive":

```ts
const channel = randomChannel();
const [a, b] = await Promise.all([
  TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
  TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
]);

a.send("hello");
await b.waitForTotal(1);

expect(b.text).toEqual(["hello"]);
expect(a.total).toBe(0);   // sender exclusion

await closeAll([a, b]);
```

Prefer `waitForTotal` over a fixed sleep. Use `settle()` only when you need to
prove something did **not** arrive, where there is nothing to wait for.

Set `TEST_SERVER_LOGS=1` to see what the servers under test are printing.

### Keep it deterministic

Tests run one file at a time, one worker, because each binds real ports.
Parallelism here buys only flakiness.

If you add load-generating tests, generate volume cheaply — `POST` to an empty
channel is one log line per request. An earlier version of the rotation tests
opened hundreds of websockets and became flaky through resource pressure
rather than through any real bug.

## Conventions

**Comments explain why, not what.** The code says what it does; a comment
earns its place by recording a constraint, a rejected alternative, or a
non-obvious consequence. Several in this codebase exist because a plausible
simpler version was actually wrong.

**Typed strictly.** `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` are all on. `just check` type-checks the server,
the browser bundles and the tests as three separate projects.

**The delivery contract is the contract.** If a change alters anything in
[Guarantees & limits](/reference/guarantees), that document changes in the
same commit, and a test pins the new behaviour.

## CI

Every push to a branch and every pull request runs `just ci`: type checks, the
full build including docs, and the integration suite. The ACME suite runs too,
in its own job.

## Submitting

1. Branch off `main`.
2. `just ci` passes locally.
3. Update the docs in the same commit if behaviour changed.
4. Open a pull request describing what changed and why. For anything touching
   the delivery contract, say so explicitly.
