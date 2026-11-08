#!/usr/bin/env bash
#
# Build once, ship to every host in deploy/hosts, reload pm2 on each.
#
#   deploy/deploy.sh                      every host in deploy/hosts
#   deploy/deploy.sh router1 router2      just these
#   DRY_RUN=1 deploy/deploy.sh            show what would happen
#   SKIP_BUILD=1 deploy/deploy.sh         reuse the current dist/
#
# IMPORTANT: each host is an INDEPENDENT router.
#
# There is no shared bus any more, so channel state is per process. Two hosts
# serving one hostname behind a load balancer would silently split every
# channel: clients landing on different hosts would never hear each other.
# Give each host its own hostname. This script deploys the same build to
# several independent routers; it does not build a cluster.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"

APP_NAME="${APP_NAME:-websocket-router}"
APP_USER="${APP_USER:-router}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
HOSTS_FILE="${HOSTS_FILE:-deploy/hosts}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

bold=$'\033[1m'; normal=$'\033[0m'
green=$'\033[32m'; yellow=$'\033[33m'; blue=$'\033[34m'; red=$'\033[31m'

say()  { printf '%s▸ %s%s\n' "${blue}" "$*" "${normal}"; }
ok()   { printf '%s  ✓ %s%s\n' "${green}" "$*" "${normal}"; }
warn() { printf '%s  ! %s%s\n' "${yellow}" "$*" "${normal}"; }
bad()  { printf '%s  ✗ %s%s\n' "${red}" "$*" "${normal}"; }

# ---------------------------------------------------------------------------
# which hosts
# ---------------------------------------------------------------------------

if [[ $# -gt 0 ]]; then
  HOSTS=("$@")
else
  if [[ ! -f "${HOSTS_FILE}" ]]; then
    bad "no ${HOSTS_FILE}. Copy deploy/hosts.example and list your instances."
    exit 1
  fi
  # One host per line; # comments and blanks ignored.
  mapfile -t HOSTS < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' \
                           -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                           "${HOSTS_FILE}")
fi

if [[ ${#HOSTS[@]} -eq 0 ]]; then
  bad "no hosts to deploy to"
  exit 1
fi

say "deploying to ${#HOSTS[@]} host(s): ${HOSTS[*]}"
if [[ ${#HOSTS[@]} -gt 1 ]]; then
  warn "each host is an independent router; clients must use a per-host hostname"
fi

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

RELEASE="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

if [[ "${SKIP_BUILD}" != "1" ]]; then
  say "building release ${RELEASE}"
  npm ci --no-audit --no-fund
  npm run build
  (cd docs && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build)
  # The docs are part of the deployment, and the precompressed variants have
  # to cover them too, so compress after they are built.
  npm run compress
else
  say "reusing the existing build (SKIP_BUILD=1)"
fi

for required in dist/server/index.js dist/web/channel/index.html docs/.vitepress/dist/index.html; do
  if [[ ! -f "${required}" ]]; then
    bad "missing ${required}; build did not complete"
    exit 1
  fi
done
ok "build artefacts present"

# ---------------------------------------------------------------------------
# package
# ---------------------------------------------------------------------------

say "packaging"
TARBALL="$(mktemp -t wsr-release-XXXXXX).tar.gz"
# Only what production runs: no sources, no tests, no CI config, no docs
# sources. node_modules is installed on the host from the lockfile instead of
# being shipped, so native builds match the host's own Node.
# COPYFILE_DISABLE and --no-xattrs stop macOS tar embedding
# com.apple.provenance metadata, which GNU tar on the host warns about once
# per file; those warnings interleave with the deploy's own output.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "${TARBALL}" \
  dist \
  public \
  docs/.vitepress/dist \
  package.json \
  package-lock.json \
  ecosystem.config.cjs
ok "$(du -h "${TARBALL}" | cut -f1) tarball"

cleanup() { rm -f "${TARBALL}"; }
trap cleanup EXIT

if [[ "${DRY_RUN}" == "1" ]]; then
  warn "DRY_RUN=1, stopping before any host is touched"
  exit 0
fi

# ---------------------------------------------------------------------------
# ship
# ---------------------------------------------------------------------------

# The remote half. Kept as one heredoc so a half-finished deploy cannot leave
# a host serving a release whose dependencies were never installed: `current`
# is only repointed after npm ci succeeds.
remote_script() {
  cat <<REMOTE
set -euo pipefail

APP_NAME="${APP_NAME}"
APP_USER="${APP_USER}"
APP_ROOT="${APP_ROOT}"
RELEASE="${RELEASE}"
KEEP_RELEASES="${KEEP_RELEASES}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT}"

RELEASE_DIR="\${APP_ROOT}/releases/\${RELEASE}"

if ! id -u "\${APP_USER}" >/dev/null 2>&1; then
  echo "service user \${APP_USER} does not exist; run deploy/bootstrap.sh on this host first" >&2
  exit 1
fi
if [[ ! -f "\${APP_ROOT}/env" ]]; then
  echo "\${APP_ROOT}/env is missing; run deploy/bootstrap.sh on this host first" >&2
  exit 1
fi

echo "  unpacking \${RELEASE}"
rm -rf "\${RELEASE_DIR}"
install -d -o root -g root -m 0755 "\${RELEASE_DIR}"
tar -xzf /tmp/\${RELEASE}.tar.gz -C "\${RELEASE_DIR}"

echo "  installing production dependencies"
cd "\${RELEASE_DIR}"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

# Release trees stay root-owned and group-readable by the service user, so the
# running process cannot modify the code it is executing.
chown -R root:"\${APP_USER}" "\${RELEASE_DIR}"
chmod -R g-w,o-rwx "\${RELEASE_DIR}"

# Only a real symlink counts as a previous release. \`readlink -f\` on a
# path that does not exist yet canonicalises to that same path rather than
# failing, so a first deploy used to record "previous = current" and the
# rollback below then pointed current at itself (ELOOP).
if [[ -L "\${APP_ROOT}/current" ]]; then
  PREVIOUS="\$(readlink -f "\${APP_ROOT}/current" 2>/dev/null || true)"
else
  PREVIOUS=""
fi

# Atomic swap: symlink to a temp name, then rename over the old one.
ln -sfn "\${RELEASE_DIR}" "\${APP_ROOT}/current.new"
mv -Tf "\${APP_ROOT}/current.new" "\${APP_ROOT}/current"
echo "  current -> \${RELEASE}"

# The capability to bind :80 and :443 comes from the systemd drop-in on
# pm2-\${APP_USER}.service, and systemd grants it only to a daemon *it*
# started. A pm2 daemon spawned by this ssh session gets CapAmb=0, and every
# listen on a privileged port then fails with EACCES while the drop-in looks
# perfectly correct. So make sure the daemon is the systemd one before
# touching the app.
if ! systemctl is-active --quiet "pm2-\${APP_USER}"; then
  echo "  starting the pm2 daemon under systemd"
  # A stray daemon from an earlier manual run owns the process list, so clear
  # it before handing control over.
  sudo -u "\${APP_USER}" -H pm2 kill >/dev/null 2>&1 || true
  # \`pm2 resurrect\` needs a dump to exist; create an empty one if there is none.
  if [[ ! -f "/home/\${APP_USER}/.pm2/dump.pm2" ]]; then
    sudo -u "\${APP_USER}" -H pm2 save --force >/dev/null 2>&1 || true
    sudo -u "\${APP_USER}" -H pm2 kill >/dev/null 2>&1 || true
  fi
  systemctl start "pm2-\${APP_USER}"
  for _ in \$(seq 1 30); do
    sudo -u "\${APP_USER}" -H pm2 ping >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! sudo -u "\${APP_USER}" -H pm2 ping >/dev/null 2>&1; then
  echo "  pm2 daemon is not reachable; cannot deploy" >&2
  systemctl status "pm2-\${APP_USER}" --no-pager -l 2>&1 | head -20 >&2
  exit 1
fi

echo "  reloading pm2"
# --update-env so edits to \${APP_ROOT}/env take effect on a plain deploy.
# startOrReload handles both the first deploy and every later one.
sudo -u "\${APP_USER}" -H bash -lc "
  set -euo pipefail
  set -a; . '\${APP_ROOT}/env'; set +a
  cd '\${APP_ROOT}/current'
  pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save --force
" >/dev/null

# --- health gate -------------------------------------------------------
# Read the listener settings out of the env file. The path MUST be in double
# quotes: inside this command substitution single quotes are literal, so
# '\${APP_ROOT}/env' would try to source a file of that literal name, fail,
# have the error swallowed by 2>/dev/null, and silently fall back to the
# default port — health-checking a port nothing is listening on while the
# deploy itself was fine.
eval "\$(
  set -a
  . "\${APP_ROOT}/env" >/dev/null 2>&1 || true
  set +a
  printf 'HEALTH_PORT=%q\\nHEALTH_TLS=%q\\n' "\${PORT:-3077}" "\${TLS_ENABLED:-false}"
)"

if [[ "\${HEALTH_TLS}" == "true" ]]; then
  HEALTH_URL="https://127.0.0.1:\${HEALTH_PORT}/healthcheck"
  # The certificate is valid for the public name, not 127.0.0.1.
  CURL_EXTRA="-k"
else
  HEALTH_URL="http://127.0.0.1:\${HEALTH_PORT}/healthcheck"
  CURL_EXTRA=""
fi

echo "  waiting for \${HEALTH_URL}"
healthy=0
for _ in \$(seq 1 "\${HEALTH_TIMEOUT}"); do
  if [[ "\$(curl -fsS \${CURL_EXTRA} --max-time 3 "\${HEALTH_URL}" 2>/dev/null)" == "OK" ]]; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "\${healthy}" != "1" ]]; then
  echo "  HEALTHCHECK FAILED; rolling back" >&2
  sudo -u "\${APP_USER}" -H pm2 logs "\${APP_NAME}" --lines 40 --nostream >&2 || true
  if [[ -n "\${PREVIOUS}" && -d "\${PREVIOUS}" \
        && "\${PREVIOUS}" != "\${RELEASE_DIR}" \
        && "\${PREVIOUS}" == "\${APP_ROOT}/releases/"* ]]; then
    ln -sfn "\${PREVIOUS}" "\${APP_ROOT}/current.new"
    mv -Tf "\${APP_ROOT}/current.new" "\${APP_ROOT}/current"
    sudo -u "\${APP_USER}" -H bash -lc "
      set -a; . '\${APP_ROOT}/env'; set +a
      cd '\${APP_ROOT}/current'
      pm2 startOrReload ecosystem.config.cjs --update-env
      pm2 save --force
    " >/dev/null || true
    echo "  rolled back to \$(basename "\${PREVIOUS}")" >&2
  else
    echo "  no previous release to roll back to" >&2
  fi
  rm -f /tmp/\${RELEASE}.tar.gz
  exit 1
fi

echo "  healthy"

# Prune old releases, never the one that is live.
cd "\${APP_ROOT}/releases"
CURRENT_BASE="\$(basename "\$(readlink -f "\${APP_ROOT}/current")")"
ls -1t | grep -v "^\${CURRENT_BASE}\$" | tail -n +"\${KEEP_RELEASES}" | while read -r old; do
  echo "  pruning \${old}"
  rm -rf -- "\${old}"
done

rm -f /tmp/\${RELEASE}.tar.gz
REMOTE
}

# The remote half is generated by an unquoted heredoc, so every `$` that must
# survive to the remote shell needs escaping. Getting one wrong produces a
# script that is still valid but silently uses a local value. DUMP_REMOTE=1
# prints exactly what would be piped to ssh.
if [[ "${DUMP_REMOTE:-0}" == "1" ]]; then
  remote_script
  exit 0
fi

FAILED=()
SUCCEEDED=()

for host in "${HOSTS[@]}"; do
  echo
  printf '%s=== %s ===%s\n' "${bold}" "${host}" "${normal}"

  if ! scp ${SSH_OPTS} -q "${TARBALL}" "root@${host}:/tmp/${RELEASE}.tar.gz"; then
    bad "${host}: upload failed"
    FAILED+=("${host}")
    continue
  fi

  if remote_script | ssh ${SSH_OPTS} "root@${host}" 'bash -s'; then
    ok "${host}: deployed ${RELEASE}"
    SUCCEEDED+=("${host}")
  else
    bad "${host}: deploy failed (see output above)"
    FAILED+=("${host}")
  fi
done

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

echo
say "summary for ${RELEASE}"
for host in "${SUCCEEDED[@]:-}"; do [[ -n "${host}" ]] && ok "${host}"; done
for host in "${FAILED[@]:-}";    do [[ -n "${host}" ]] && bad "${host}"; done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo
  bad "${#FAILED[@]} of ${#HOSTS[@]} host(s) failed"
  # A partial deploy across independent routers is a real state, not a
  # transient one: the hosts that failed are still serving the old release.
  exit 1
fi

echo
ok "all ${#HOSTS[@]} host(s) deployed"
