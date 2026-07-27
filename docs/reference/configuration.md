# Configuration

All configuration is environment variables. There is no config file and no
runtime configuration API.

## Server

| Variable    | Required | Default                  | Description                                                                                                                                                           |
| ----------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | **yes**  | —                        | Redis connection string, e.g. `redis://localhost:6379` or `rediss://user:pass@host:port`. Only pub/sub is used. The process **throws on startup** if this is missing. |
| `PORT`      | no       | `3077`                   | TCP port to listen on. Deno Deploy sets this for you.                                                                                                                 |
| `APP_FQDN`  | no       | `http://localhost:$PORT` | Host used to build the URL encoded in the QR code on channel pages. Routing does not use it.                                                                          |

Locally these come from a `.env` file in the project root, loaded automatically
by `just`:

```sh
# .env — gitignored, because REDIS_URL usually carries a password
REDIS_URL=redis://localhost:6379
APP_FQDN=localhost:3077
PORT=3077
```

In production they are set on the Deno Deploy _application_, not baked into a
deploy:

```sh
just env-list    # what production is using
just env-push    # push ./.env into the application
```

## Tests

| Variable           | Default                  | Description                                                                     |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------- |
| `REDIS_URL`        | `redis://localhost:6379` | Redis the test cluster publishes through.                                       |
| `TEST_BASE_PORT`   | `3100`                   | First port of the test cluster; instances use `PORT`, `PORT+1`, `PORT+2`.       |
| `TEST_SERVER_LOGS` | unset                    | Set to `1` to stream the test servers' stdout and stderr, prefixed by instance. |

## Deployment

The Deno Deploy target lives in the `deploy` block of `deno.json` rather than in
the dashboard, because that block takes precedence over dashboard settings:

```json
{
  "deploy": {
    "org": "metapage",
    "app": "websocket-router",
    "runtime": {
      "mode": "dynamic",
      "entrypoint": "src/serve.ts"
    }
  }
}
```

Authentication for `deno deploy` uses the device login from `deno deploy login`.

::: danger `DENO_DEPLOY_TOKEN` will break your deploys
Deploy Classic `ddp_` tokens are not valid for `deno deploy`. If one is exported
in your shell it overrides the device login and every deploy fails with
`AUTH_INVALID_TOKEN`. Unset it.
:::

## Constants

Not configurable, but worth knowing. All live in `src/handlerWs.ts`.

| Constant                      | Value                             | Meaning                                                       |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------- |
| `MINIMUM_CHANNEL_NAME_LENGTH` | `6`                               | Shorter names are rejected with close code `1008`             |
| `PING_PREFIX`                 | `"ping"`                          | Messages starting with this are keepalives and are not routed |
| `PONG_MESSAGE`                | `"client ping: pong from server"` | Reply sent to the pinging client                              |
| `SERVER_INSTANCE_ID_LENGTH`   | `6`                               | Length of the per-process id prefixed to redis publications   |
