# Workflows

## `ci.yml`

Type checks and the full build, the integration suite in containers, and
certificate issuance against pebble. Runs on every branch push and pull
request.

## `deploy.yml`

Builds, runs the integration suite, then deploys to every host in the
`DEPLOY_HOSTS` repository variable over ssh — by running the same
`deploy/deploy.sh` you would run by hand. Nothing about the deployment is
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

Set them with:

```sh
gh variable set DEPLOY_HOSTS --body "165.232.59.253"
gh secret   set DEPLOY_SSH_PRIVATE_KEY < deploy_key
ssh-keyscan -t ed25519 165.232.59.253 | gh secret set DEPLOY_SSH_KNOWN_HOSTS
```

Use a **dedicated** keypair, not a personal one. A key that only CI holds can
be revoked by deleting one line from `/root/.ssh/authorized_keys` without
disturbing anyone's own access:

```sh
ssh-keygen -t ed25519 -C "github-actions-deploy@websocket-router" -f deploy_key -N ""
ssh-copy-id -i deploy_key.pub root@165.232.59.253
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
