# Admin panel

A small password-protected panel at `/admin` for the two things that cannot
wait for a redeploy: changing the maximum message size, and reading the logs.

## Enabling it

The panel exists only when `ADMIN_PASSWORD` is set.

```sh
ADMIN_PASSWORD=<a long random string>
ADMIN_SESSION_SECRET=<openssl rand -hex 32>
```

With no password, `/admin` and every `/admin/api/*` route return **404**, not
401. That is deliberate: a panel that exists with a default or empty
credential is worse than no panel, and a 401 would still advertise that there
is something there to attack.

```sh
openssl rand -base64 32   # ADMIN_PASSWORD
openssl rand -hex 32      # ADMIN_SESSION_SECRET
```

`ADMIN_SESSION_SECRET` is optional. Without it a random secret is generated at
boot, which works but signs every operator out on each restart — including
every deploy.

::: warning
`/admin` is reserved whether or not the panel is enabled, so it can never be
used as a channel name. This is what stops a channel somebody is already
using from breaking the day you switch the panel on.
:::

## Signing in

Open `https://your-host/admin` and enter the password.

| | |
| --- | --- |
| Session | an HMAC-signed cookie carrying its own expiry |
| Cookie flags | `HttpOnly`, `SameSite=Strict`, `Path=/admin`, `Secure` when TLS is on |
| Lifetime | `ADMIN_SESSION_TTL_MINUTES`, 12 hours by default |
| Password comparison | constant time, independent of length |
| Lockout | 5 failures from one address locks it for 15 minutes |

The lockout outlasts a subsequent correct password, so guessing cannot be
retried faster by getting it right on the sixth attempt.

There are no user accounts. Nothing in the panel is attributable to a person
— it reads logs and sets one number — so a shared secret is the honest design
rather than a login system pretending to be more.

## What it shows

**Live counters**, refreshed every three seconds: channels, connections,
messages and bytes routed, resident memory, TLS status, and the uid the
process is running as. That last one is there so you can confirm the service
is not running as root without shelling into the box.

**Maximum message size.** Applies to websocket frames and `POST` bodies alike,
and takes effect immediately — including on connections that were already
open. A socket that exceeds it is closed with code **1009** (`Message Too
Big`), which clients can act on without parsing a string. An oversize `POST`
gets **413**.

The value is persisted to `${DATA_DIR}/settings.json` and survives restarts.
It cannot be raised above `WS_HARD_MAX_MESSAGE_BYTES`, which is enforced by
the websocket library itself before a frame is ever buffered — the panel
cannot promise something the transport will refuse.

**Logs.** The last N lines, filterable by level. Two sources:

| Source | Reads | Use for |
| --- | --- | --- |
| `recent (memory)` | an in-process ring buffer of the last 2000 entries | what is happening now |
| `history (files)` | the rotated files on disk | what happened earlier |

The memory source is there because the panel should never block on disk to
show you the last few lines of a server you are debugging.

## API

Every route is under `/admin/api/` and needs the session cookie. Useful for
scripting a check across hosts.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/login` | `{"password": "..."}` → sets the cookie |
| `POST` | `/logout` | clears it |
| `GET` | `/session` | `{"authenticated": bool}` |
| `GET` | `/settings` | current settings and their permitted range |
| `PUT` | `/settings` | `{"maxMessageBytes": n}` |
| `GET` | `/stats` | counters, memory, uid, TLS |
| `GET` | `/logs` | `?limit=200&source=memory|disk&level=info|all` |

```sh
# Read the limit on a host from the command line.
curl -sS -c /tmp/jar -X POST https://router.example.com/admin/api/login \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}"

curl -sS -b /tmp/jar https://router.example.com/admin/api/settings
```

## Security notes

The panel is as exposed as the rest of the router: one password on the public
internet. Worth knowing:

- **Use TLS.** Over plain HTTP the password and session cookie cross the
  network in clear. The cookie only gets its `Secure` flag when
  `TLS_ENABLED=true`.
- **Set `TRUST_PROXY=true` behind a reverse proxy**, or the login lockout
  counts every attempt against the proxy's address rather than the real
  client's — which turns a per-attacker lockout into a self-inflicted outage.
- **It is not in the sitemap and sends `noindex`**, but that is tidiness, not
  security. Treat the URL as public.
- **To restrict it by network**, put it behind your own firewall rule or
  proxy `allow`/`deny` on the `/admin` prefix. The router does not do IP
  allowlisting itself.
- The panel cannot read or write channel traffic. It has no route that
  exposes a payload, and the logs it serves deliberately exclude them.
