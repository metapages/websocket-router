# Workflows

## `test.yml`

Type checks and the full build, the integration suite in containers, and
certificate issuance against pebble. Runs on every pull request into `main`,
and is called by `deploy.yml` so a push to `main` runs the identical jobs.

These three job names are the ones to list as required status checks on
`main`:

| Job name | What it covers |
| --- | --- |
| `Type check and build` | tsc across all three projects, the full build including docs, precompression, and that build output is not committed |
| `Integration suite` | the containerised suite, which is also what proves non-root operation |
| `Certificate issuance` | ACME HTTP-01 against pebble, Let's Encrypt's test server |

It deliberately does **not** trigger on `push`. A branch with an open pull
request fires both `push` and `pull_request`, which puts two check runs of
each name on the same commit. Guarding one of them off with an `if:` does not
help: the skipped run still reports a check run of that name, and a required
status check cannot tell which of the two gates the merge. Requiring a check
in that state blocks or passes a merge essentially at random.

## `deploy.yml`

Calls `test.yml`, then deploys to every host in the `DEPLOY_HOSTS` repository
variable over ssh — by running the same `deploy/deploy.sh` you would run by
hand. Nothing about the deployment is
CI-specific: if Actions is down, the identical command from a checkout does
the same thing, including the health gate and automatic rollback.

Triggered by a push to `main`, or manually via `workflow_dispatch` (which
accepts an explicit host list and a `skip_tests` escape hatch).

### Configuration

| Kind | Name | Purpose |
| --- | --- | --- |
| variable | `DEPLOY_HOSTS` | Space-separated hosts. A variable, not a secret, so it is visible and editable. |
| secret | `DEPLOY_SSH_PRIVATE_KEY` | Private key with root on each host. |
| secret | `DEPLOY_SSH_KNOWN_HOSTS` | `ssh-keyscan` output. With it, CI verifies the host key; without it, the first connection is trusted blindly. |
| secret | `INSPECT_KEY` | Optional. Serves the [connection inspector](../../docs/guide/inspector.md) at `/<key>`. Written into each host's environment file by `deploy.sh`; `just verify` then checks the route without printing it. |

Set them with:

```sh
gh variable set DEPLOY_HOSTS --body "<host>"
gh secret   set DEPLOY_SSH_PRIVATE_KEY < deploy_key
ssh-keyscan -t ed25519 <host> | gh secret set DEPLOY_SSH_KNOWN_HOSTS
openssl rand -hex 16 | gh secret set INSPECT_KEY
```

### Secrets that reach the host

`DEPLOY_SSH_*` are used by the workflow itself. `INSPECT_KEY` is different: it
is a value the *application* needs, and `deploy.sh` writes it into
`/opt/websocket-router/env` on each host (see `PUSH_ENV_KEYS` there), so
rotating it is a push to `main`.

A deploy run without it set leaves whatever the host already has, which is
what makes running `deploy/deploy.sh` from a laptop safe. The flip side:
deleting the repository secret does **not** remove the value from a host.
Delete the line in that file to do that.

Use a **dedicated** keypair, not a personal one. A key that only CI holds can
be revoked by deleting one line from `/root/.ssh/authorized_keys` without
disturbing anyone's own access:

```sh
ssh-keygen -t ed25519 -C "github-actions-deploy@websocket-router" -f deploy_key -N ""
ssh-copy-id -i deploy_key.pub root@<host>
```

### The `production` environment

The deploy job runs in a GitHub environment called `production`, restricted to
the `main` branch.

Note that the "protected branches" branch policy requires branch protection to
actually exist on `main`; if it does not, that setting blocks every deploy
while looking correct. This repository therefore uses a custom policy naming
`main` explicitly.

To require a human approval on every deploy, add yourself as a required
reviewer on that environment in repository settings. Nothing else changes.

### Rotating the deploy key

```sh
ssh-keygen -t ed25519 -C "github-actions-deploy@websocket-router" -f deploy_key -N ""
# Install the new key, then remove the old line from authorized_keys.
ssh root@<host> "grep -v 'github-actions-deploy' /root/.ssh/authorized_keys > /tmp/ak && \
  cat >> /tmp/ak && mv /tmp/ak /root/.ssh/authorized_keys" < deploy_key.pub
gh secret set DEPLOY_SSH_PRIVATE_KEY < deploy_key
```

`bootstrap.sh` does not install this key; it is deliberately a separate,
explicit step so that a host is never silently reachable from CI.

`DEPLOY_SSH_KNOWN_HOSTS` pins the host key, so **rebuilding or replacing a
host invalidates it** and every deploy then fails verification. Re-run the
`ssh-keyscan` line above whenever a host is recreated.
