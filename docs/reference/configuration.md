# Configuration

Everything is an environment variable. On a deployed host they live in
`/opt/websocket-router/env`, read by pm2 on every deploy and reload.

There are two kinds of setting, and the split is deliberate:

- **Boot-time** — fixed for the life of the process. Everything on this page.
- **Runtime** — changeable from the [admin panel](/guide/admin) without a
  restart, persisted to `${DATA_DIR}/settings.json`. Currently just the
  maximum message size.

Anything that cannot be changed safely while the process is serving traffic
belongs in the environment, not the panel.

## Listeners

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `443` with TLS, else `3077` | The main listener. |
| `HTTP_PORT` | `80` | Plain listener when TLS is on: ACME challenges and a 301 to https. Unused otherwise. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `APP_FQDN` | first `TLS_DOMAINS` entry, else `localhost:$PORT` | Hostname encoded into channel QR codes and used as the canonical redirect target. |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For`. **Set this behind a reverse proxy**, or the admin login lockout counts every attempt against the proxy's address. |

## TLS

See [Self-hosting](/guide/self-hosting#tls-and-certificates) for the full
lifecycle.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TLS_ENABLED` | `false` | Obtain a certificate and serve https. |
| `TLS_DOMAINS` | — | Comma-separated. First is the common name, the rest are SANs. **Required** when TLS is on. Every name needs a DNS record pointing here. |
| `TLS_EMAIL` | — | Contact address for CA expiry warnings. Strongly recommended. |
| `TLS_RENEW_BEFORE_DAYS` | `30` | Renew once the certificate has fewer days left than this. |
| `TLS_CHECK_INTERVAL_MINUTES` | `720` | How often to re-check expiry. |
| `ACME_DIRECTORY_URL` | Let's Encrypt production | Point at `https://acme-staging-v02.api.letsencrypt.org/directory` while you are still getting DNS right. |

### Testing only

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACME_CA_BUNDLE_FILE` | — | Trust this CA bundle instead of the system store. Exists so the test suite can verify against pebble. |
| `ACME_SKIP_CHALLENGE_VERIFICATION` | `false` | Skip acme-client's pre-flight fetch of the challenge URL. |

::: danger Leave both unset in production
The pre-flight check is worth having: it catches a closed port 80 or a DNS
record pointing at the wrong host *before* the order is submitted, which is
the difference between a clear local error and a consumed Let's Encrypt
failure allowance. It only exists as a switch because the test suite runs
pebble on a non-standard port, where a check that always uses port 80 cannot
succeed.
:::

## Admin panel

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | — | **Unset means the panel does not exist** and `/admin` returns 404. There is no default password. |
| `ADMIN_SESSION_SECRET` | random per boot | Signs session cookies. Set it, or every restart signs operators out. |
| `ADMIN_SESSION_TTL_MINUTES` | `720` | Session lifetime. |
| `ADMIN_ENABLED` | `true` | Set `false` to disable the panel while keeping the password in the file. |

```sh
openssl rand -base64 32   # ADMIN_PASSWORD
openssl rand -hex 32      # ADMIN_SESSION_SECRET
```

## Messages

| Variable | Default | Purpose |
| --- | --- | --- |
| `WS_DEFAULT_MAX_MESSAGE_BYTES` | `1048576` (1 MiB) | Initial limit, before anything is stored in `settings.json`. Once the panel has written a value, that wins. |
| `WS_HARD_MAX_MESSAGE_BYTES` | `16777216` (16 MiB) | Ceiling enforced by the websocket library itself, before a frame is assembled in memory. The panel cannot exceed it. |
| `MINIMUM_CHANNEL_NAME_LENGTH` | `6` | Shorter names are refused. The name is the only thing protecting a channel. |

The limit applies to websocket frames and `POST` bodies alike. Over it, a
socket is closed with **1009** and a `POST` gets **413**.

## Storage and logs

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `<install>/data` | Writable state: `settings.json` and `acme/`. Must be writable by the service user and nothing else. |
| `LOG_DIR` | `${DATA_DIR}/logs` | Rotated JSON logs. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_MAX_SIZE` | `20m` | Roll once a file passes this. |
| `LOG_RETAIN_FILES` | `10` | **Total** files kept, so `LOG_RETAIN_FILES × LOG_MAX_SIZE` is the disk budget. Retention spans restarts. |

`bootstrap.sh` sets `DATA_DIR=/var/lib/websocket-router` and
`LOG_DIR=/var/log/websocket-router`.

## A worked production file

```sh
# /opt/websocket-router/env

TLS_ENABLED=true
TLS_DOMAINS=router.example.com
TLS_EMAIL=ops@example.com

ADMIN_PASSWORD=yT8kQ2mXp9vL4nR7wZ3bF6hJ1sD5gA0c
ADMIN_SESSION_SECRET=4f8a2c91e7b3d6054a1f8e2c7b9d3056f1a8c4e7b2d9f6031a5c8e2b7d4f9061

DATA_DIR=/var/lib/websocket-router
LOG_DIR=/var/log/websocket-router
LOG_LEVEL=info
LOG_MAX_SIZE=20m
LOG_RETAIN_FILES=10

WS_DEFAULT_MAX_MESSAGE_BYTES=1048576
WS_HARD_MAX_MESSAGE_BYTES=16777216
```

Behind an existing reverse proxy instead:

```sh
TLS_ENABLED=false
PORT=3077
TRUST_PROXY=true
APP_FQDN=router.example.com
ADMIN_PASSWORD=...
ADMIN_SESSION_SECRET=...
```

`APP_FQDN` matters here: without it, QR codes on channel pages would encode
`localhost:3077` rather than the name clients actually use.

## Local development

```sh
just dev     # watches everything; admin password "dev", no TLS
just prod    # full build, NODE_ENV=production, exactly as production runs
```

`just dev` runs two watchers: `vite build --watch` for the browser bundles and
`tsx watch` for the server. It builds the bundles before starting the server,
so there is nothing to do first. Edit anything under `web/` and the rebuilt
bundle is picked up without a restart; edit anything under `src/` and the
server restarts.

`just prod` is the one to reach for when you want to check behaviour that
differs between modes — precompressed assets, the built docs at `/docs`, and
`NODE_ENV=production`, which disables the dev-only template reload.

No environment file is required: every setting above has a working default
except `TLS_DOMAINS`, which is only read when TLS is on.
