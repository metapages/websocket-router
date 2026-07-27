# Self-hosting

The router needs two things: a Deno runtime and a redis it can reach. Everything
else is configuration.

## Prerequisites

- [Deno](https://deno.land) 2.x
- [just](https://github.com/casey/just) — the command runner used throughout
- A redis instance (only pub/sub is used, so the smallest tier of anything
  works)
- [Node.js](https://nodejs.org) 20+, if you want to build the documentation

## Local development

```sh
git clone https://github.com/metapages/websocket-router
cd websocket-router

# a throwaway redis
docker run -d --name router-redis -p 6379:6379 redis:7-alpine

just dev
```

`just dev` runs the server with `--watch` on `http://localhost:3077`. Connect a
client to `ws://localhost:3077/my-test-channel` and you are running.

Run `just` on its own to list every available command.

## Configuration

Values come from the environment, or from a `.env` file in the project root,
which `just` loads automatically.

| Variable    | Required | Default                  | Purpose                                                            |
| ----------- | -------- | ------------------------ | ------------------------------------------------------------------ |
| `REDIS_URL` | **yes**  | —                        | Redis connection string. The process throws on startup without it. |
| `PORT`      | no       | `3077`                   | Listen port.                                                       |
| `APP_FQDN`  | no       | `http://localhost:$PORT` | Host used to build the QR code URL on channel pages.               |

```sh
# .env
REDIS_URL=redis://localhost:6379
APP_FQDN=localhost:3077
PORT=3077
```

::: warning `.env` is gitignored, and should stay that way
`REDIS_URL` normally contains a password.
:::

## Building the documentation

The docs are a separate npm project under `docs/`, built by vitepress into
`docs/.vitepress/dist`, which the server mounts at `/docs`.

```sh
just docs-install   # once
just docs-dev       # live-reloading docs at http://localhost:5173/docs/
just docs-build     # produce docs/.vitepress/dist
```

Until you build them, `/docs` returns a page telling you to run
`just docs-build`.

::: tip Built at deploy time, never committed
`docs/.vitepress/dist` is gitignored build output. Deno Deploy has no build step
and honours `.gitignore`, so it reaches production only because the
`deploy.include` list in `deno.json` names the path explicitly — an explicitly
included plain path overrides `.gitignore` for the uploader.

`just deploy` rebuilds it, refuses to deploy without it, and verifies `/docs`
over the network once the deployment is live.
:::

## Running the tests

The integration tests start real server processes against a real redis and drive
them over real websockets. There is no mocking.

```sh
just test        # starts a disposable redis in docker, then runs the suite
just test-only   # reuses whatever REDIS_URL points at
```

See [Contributing](/guide/contributing) for what the suite covers.

## Deploying to Deno Deploy

This project is deployed on [Deno Deploy](https://deno.com/deploy). The deploy
configuration lives in the `deploy` block of `deno.json` — org, app name and the
`src/serve.ts` entrypoint — and takes precedence over anything set in the
dashboard.

```sh
just deploy      # type-checks, builds docs, then deploys
just logs        # tail production logs
just env-list    # show the variables production is using
just env-push    # push ./.env into the application
```

Environment variables are set on the _application_, not baked into a deploy, so
`REDIS_URL` and `APP_FQDN` must exist there before the first deploy.

::: warning Authentication
`deno deploy` uses the device login from `deno deploy login`. Deploy Classic
`ddp_` tokens are **not** valid; a stale `DENO_DEPLOY_TOKEN` in your environment
overrides the device login and every deploy fails with `AUTH_INVALID_TOKEN`.
:::

## Deploying anywhere else

Nothing is specific to Deno Deploy. The process is a normal server:

```sh
REDIS_URL=redis://... PORT=8080 deno run -A src/serve.ts
```

Behind a proxy, make sure it forwards websocket upgrades — for nginx that means
`proxy_set_header Upgrade $http_upgrade;` and
`proxy_set_header Connection
"upgrade";` — and set a generous
`proxy_read_timeout`, because idle channels otherwise get cut.

Run as many instances as you like against one redis. They discover each other
implicitly through pub/sub; there is no cluster membership to configure.

## Operating it

- **Health**: `GET /healthcheck` returns `200 OK`. Use it as your liveness and
  readiness probe.
- **Redis**: only pub/sub is used, so no persistence, no eviction policy and no
  backup strategy is needed. Size it for bandwidth, not memory.
- **Restarts drop every connection.** Clients must reconnect; the reference
  client in the [quickstart](/guide/quickstart#a-complete-two-way-client) does.
- **Scaling**: add instances for more concurrent sockets. Redis message
  throughput is the shared ceiling.
- **Logs**: connections, disconnections and redis failures are logged to stdout.
  Message payloads are not.
