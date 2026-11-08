# Self-hosting

Everything needed to run your own copy. One Node process on one small VM, with
its own TLS certificate. No broker, no database, no container runtime
required.

::: tip The short version
```sh
# once per host, as root
ssh root@your-host 'bash -s' < deploy/bootstrap.sh
ssh root@your-host 'nano /opt/websocket-router/env'   # set TLS_DOMAINS, TLS_EMAIL, ADMIN_PASSWORD

# from your checkout, as often as you like
echo your-host > deploy/hosts
just deploy
```
:::

## What you are deploying

A single Node process that holds every channel in memory and fans messages out
directly between sockets. That is the whole architecture — see
[Architecture](/guide/architecture).

::: warning Each host is an independent router
There is no shared bus. Channel membership lives in one process's memory, so
two hosts are two separate routers that happen to run the same code. Clients
on `router-a.example.com` cannot reach clients on `router-b.example.com`, even
on the same channel name.

**Do not put several hosts behind one hostname.** A load balancer would split
every channel silently: two peers would connect, both appear healthy, and
never hear each other. Give each host its own name.

`deploy/deploy.sh` takes a list of hosts because deploying the same build to
several independent routers is useful. It is not building a cluster.
:::

## Requirements

| | |
| --- | --- |
| OS | Debian 12 / Ubuntu 22.04 or newer |
| RAM | 512 MB is plenty for thousands of connections; 1 GB is comfortable |
| Node | 22 or newer (`bootstrap.sh` installs 24) |
| Ports | 443 inbound, and 80 inbound for ACME |
| DNS | an A record per host, pointing at it, before you enable TLS |

A €4/month shared-CPU VM handles far more than most deployments will ever see.
The binding constraint is memory per connection (roughly 20–40 KB), not CPU.

## Step 1 — bootstrap the host

Run once per new machine, as root:

```sh
ssh root@your-host 'bash -s' < deploy/bootstrap.sh
```

It is idempotent — re-run it any time to repair a host. It:

- creates a system user `router` with no login shell;
- installs Node.js 24 from NodeSource;
- installs `pm2` and registers it with systemd (`pm2 startup systemd`), so the
  router comes back after a reboot;
- installs and configures `pm2-logrotate`;
- grants `CAP_NET_BIND_SERVICE` through a systemd drop-in, so the service can
  bind 80 and 443 **without running as root**;
- writes a template environment file at `/opt/websocket-router/env`.

### Why a capability rather than root, or `setcap`

Ports below 1024 need a privilege. There are three ways to get it, and they
are not equivalent:

| Approach | Problem |
| --- | --- |
| Run as root | The router parses untrusted input from the public internet. Nothing here needs root. |
| `setcap` on the `node` binary | Grants *every* Node process on the box the right to bind low ports, forever. |
| `AmbientCapabilities` on the unit | Grants it to this service and its children only. |

`bootstrap.sh` uses the third, written to
`/etc/systemd/system/pm2-router.service.d/override.conf` so it survives
`pm2 startup` regenerating the unit:

```ini
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/var/lib/websocket-router /var/log/websocket-router /home/router/.pm2
```

`CapabilityBoundingSet` is the half that matters most: it caps what the
process could ever acquire, not just what it starts with.

## Step 2 — configure

Edit `/opt/websocket-router/env`. It is `root:router` and mode `0640`, because
it holds the admin password.

```sh
TLS_ENABLED=true
TLS_DOMAINS=router.example.com
TLS_EMAIL=you@example.com

ADMIN_PASSWORD=<a long random string>
ADMIN_SESSION_SECRET=<openssl rand -hex 32>
```

Generate the secrets rather than inventing them:

```sh
openssl rand -base64 32   # ADMIN_PASSWORD
openssl rand -hex 32      # ADMIN_SESSION_SECRET
```

Leave `ADMIN_PASSWORD` empty to disable the admin panel entirely — `/admin`
then returns 404 rather than existing with a weak credential. See
[Admin panel](/guide/admin).

Every setting is listed in [Configuration](/reference/configuration).

### Point DNS at the host first

ACME validates by fetching a file over HTTP from the name you are asking for a
certificate for. If DNS does not already resolve to this host, issuance fails
and the process will not start. Check before deploying:

```sh
dig +short router.example.com
```

## Step 3 — deploy

```sh
echo router.example.com > deploy/hosts
just deploy
```

Which builds locally, ships a tarball, and on each host: unpacks to
`releases/<timestamp>-<sha>`, runs `npm ci --omit=dev`, atomically repoints
`current`, reloads pm2, and **waits for `/healthcheck`**. If health never
comes up it prints the last 40 log lines and rolls `current` back to the
previous release automatically.

```sh
just deploy                      # every host in deploy/hosts
just deploy router-a router-b     # only these
just deploy-dry                   # build and package, touch no host
just status                       # what each host is running
just rollback router-a            # back to the previous release
just logs router-a                # tail pm2 output
just verify https://router.example.com   # smoke test over the network
```

Release trees are owned by `root:router` and are not writable by the service
user, so a compromised router process cannot rewrite the code that runs next
boot. The five most recent releases are kept.

## Deploying from GitHub Actions

`deploy.yml` runs the same `deploy/deploy.sh`, so CI and a laptop do the same
thing — including the health gate and automatic rollback. Three settings:

```sh
gh variable set DEPLOY_HOSTS --body "165.232.59.253"     # space separated
gh secret   set DEPLOY_SSH_PRIVATE_KEY < deploy_key      # root on each host
ssh-keyscan -t ed25519 165.232.59.253 | gh secret set DEPLOY_SSH_KNOWN_HOSTS
```

Generate a **dedicated** keypair rather than reusing a personal one — a key
only CI holds can be revoked by deleting one line from
`/root/.ssh/authorized_keys`, without disturbing anyone's own access:

```sh
ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key -N ""
ssh-copy-id -i deploy_key.pub root@165.232.59.253
```

`DEPLOY_SSH_KNOWN_HOSTS` is what makes CI *verify* the server rather than
trusting whatever answers on that address. Confirm the fingerprint it pins
matches the one your own client already recorded before you store it.

Pushes to `main` deploy. `workflow_dispatch` also accepts an explicit host
list, so you can deploy to one host out of several. Details and key rotation:
[`.github/workflows/README.md`](https://github.com/metapages/websocket-router/blob/main/.github/workflows/README.md).

`bootstrap.sh` deliberately does not install a CI key: a host should never
become reachable from CI as a side effect of being set up.

## TLS and certificates

Certificates are obtained and renewed in-process with
[`acme-client`](https://www.npmjs.com/package/acme-client) over HTTP-01. There
is no certbot, no cron job, and no reverse proxy.

With `TLS_ENABLED=true` the process opens two listeners:

| Port | Serves |
| --- | --- |
| `HTTP_PORT` (80) | ACME challenges, and a 301 to https for everything else |
| `PORT` (443) | the entire application |

Port 80 serves **nothing** but challenges and redirects. It is a deliberately
separate, minimal app.

### The lifecycle

On boot, and every `TLS_CHECK_INTERVAL_MINUTES` (12 hours by default):

1. read the certificate at `${DATA_DIR}/acme/certificate.crt`;
2. if it is missing, does not cover every name in `TLS_DOMAINS`, or expires
   within `TLS_RENEW_BEFORE_DAYS` (30), order a new one;
3. answer the HTTP-01 challenge from the port 80 listener;
4. write the result and hand it to the running https server, which swaps it in
   with `setSecureContext` — **no restart, no dropped connections**.

A renewal failure is logged and retried on the next check rather than being
fatal: an expiring certificate is still a working certificate, and taking the
router down because a CA had a bad minute would be worse. A failure at *first*
issuance is fatal, because there is nothing to serve.

### Multiple names on one certificate

```sh
TLS_DOMAINS=router.example.com,ws.example.com
```

The first is the common name; the rest become SANs. Every one needs its own
DNS record pointing here. The port 80 redirect preserves whichever covered
name was requested, so a visitor to `ws.example.com` is not bounced to
`router.example.com`.

### Test against staging first

Let's Encrypt rate-limits failed authorizations hard. While you are still
getting DNS and firewall right, point at staging:

```sh
ACME_DIRECTORY_URL=https://acme-staging-v02.api.letsencrypt.org/directory
```

Browsers will not trust the result — that is expected. When `/healthcheck`
answers over https, remove the line, delete `${DATA_DIR}/acme/`, and redeploy
to get a real certificate.

### Troubleshooting issuance

| Symptom | Cause |
| --- | --- |
| `no certificate available; cannot start https` | First issuance failed. The error above it in the log says why. |
| Challenge times out | Port 80 is not reachable from the internet. Check the firewall and any cloud security group. |
| `unauthorized` / wrong host | DNS does not resolve to this host yet, or still points somewhere else. |
| `too many failed authorizations` | Rate limited. Wait it out, and use staging next time. |
| Permission denied binding :80 | The systemd drop-in is missing. Re-run `bootstrap.sh`. |
| Still serving the staging certificate | A valid certificate on disk is reused rather than reordered. Delete `${DATA_DIR}/acme/` and deploy again. |
| An env change appears to do nothing | `systemctl restart` resurrects pm2's *saved* environment and ignores the env file. Deploy instead -- `deploy.sh` deletes and restarts the app so the env file wins. |

Certificates and the ACME account key live in `${DATA_DIR}/acme/`, written
`0600`. Back up that directory, or do not — losing it costs one fresh account
registration and one fresh issuance.

### If you already run a reverse proxy

Set `TLS_ENABLED=false`, pick a high `PORT`, and terminate TLS in Caddy or
nginx as usual. Two things matter:

- the proxy must pass websocket upgrades through (`Upgrade` and `Connection`
  headers);
- set `TRUST_PROXY=true` so `X-Forwarded-For` is honoured, or the admin
  panel's login lockout will count every attempt against the proxy's address
  instead of the real client's.

## Running without pm2

The server is an ordinary Node process. A plain systemd unit works:

```ini
[Unit]
Description=websocket router
After=network-online.target

[Service]
Type=simple
User=router
WorkingDirectory=/opt/websocket-router/current
EnvironmentFile=/opt/websocket-router/env
ExecStart=/usr/bin/node dist/server/index.js
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

Or use the `Dockerfile`, which already runs as uid 10001 and expects a volume
at `/data`.

## Logs

Two independent streams, deliberately:

| Where | What | Rotation |
| --- | --- | --- |
| `${LOG_DIR}/router*.log` | newline-delimited JSON, the record | in-process, by `LOG_MAX_SIZE` and daily, keeping `LOG_RETAIN_FILES` total |
| pm2's capture of stdout | the same lines, for `pm2 logs` | `pm2-logrotate`, 20 MB × 10, compressed |

`LOG_RETAIN_FILES × LOG_MAX_SIZE` is the disk budget for the first stream —
10 × 20 MB = 200 MB by default. Retention spans restarts, so repeated deploys
do not accumulate orphaned files.

The router never logs message payloads. Channel names are logged, because
they are the routing key an operator needs; the contents are not, because they
are someone else's data.

## Backups

There is almost nothing to back up. `${DATA_DIR}` holds:

- `settings.json` — the admin-configurable message size limit;
- `acme/` — the account key and current certificate.

Both are regenerable. Nothing about a channel is persisted anywhere, ever.

## Sizing and limits

Memory per idle websocket is roughly 20–40 KB, so connection count is what to
plan against. A 1 GB box handles the low tens of thousands.

Two safety valves exist because one process has no second instance to absorb
overflow:

- `WS_HARD_MAX_MESSAGE_BYTES` (16 MB) is enforced by the websocket library
  itself, before a frame is assembled in memory. The admin-configurable limit
  sits under it.
- A socket with more than 8 MB of unflushed data has further messages dropped
  rather than buffered, so one client that stops reading cannot grow the heap
  until the box dies.

See [Guarantees & limits](/reference/guarantees).
