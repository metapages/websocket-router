#!/usr/bin/env bash
#
# Point `current` back at the previous release and reload.
#
#   deploy/rollback.sh                 every host in deploy/hosts
#   deploy/rollback.sh router1         just this one
#   deploy/rollback.sh router1 <name>  to a specific release directory
#
# deploy.sh already rolls back automatically when the healthcheck fails. This
# is for the other case: a release that is healthy but wrong.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_NAME="${APP_NAME:-websocket-router}"
APP_USER="${APP_USER:-router}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
HOSTS_FILE="${HOSTS_FILE:-deploy/hosts}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new}"

TARGET_RELEASE=""
if [[ $# -ge 2 ]]; then
  HOSTS=("$1")
  TARGET_RELEASE="$2"
elif [[ $# -eq 1 ]]; then
  HOSTS=("$1")
else
  mapfile -t HOSTS < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' \
                           -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                           "${HOSTS_FILE}")
fi

for host in "${HOSTS[@]}"; do
  printf '\033[1m=== %s ===\033[0m\n' "${host}"
  ssh ${SSH_OPTS} "root@${host}" 'bash -s' <<REMOTE
set -euo pipefail
APP_ROOT="${APP_ROOT}"
APP_USER="${APP_USER}"
TARGET_RELEASE="${TARGET_RELEASE}"

cd "\${APP_ROOT}/releases"
CURRENT="\$(basename "\$(readlink -f "\${APP_ROOT}/current")")"

if [[ -n "\${TARGET_RELEASE}" ]]; then
  TARGET="\${TARGET_RELEASE}"
else
  # Newest release that is not the live one.
  TARGET="\$(ls -1t | grep -v "^\${CURRENT}\$" | head -1 || true)"
fi

if [[ -z "\${TARGET}" || ! -d "\${TARGET}" ]]; then
  echo "  no release to roll back to (available: \$(ls -1t | tr '\n' ' '))" >&2
  exit 1
fi

echo "  \${CURRENT} -> \${TARGET}"
ln -sfn "\${APP_ROOT}/releases/\${TARGET}" "\${APP_ROOT}/current.new"
mv -Tf "\${APP_ROOT}/current.new" "\${APP_ROOT}/current"

sudo -u "\${APP_USER}" -H bash -lc "
  set -a; . '\${APP_ROOT}/env'; set +a
  cd '\${APP_ROOT}/current'
  pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save --force
" >/dev/null

# Double quotes around the path are required; see the note in deploy.sh.
eval "\$(
  set -a
  . "\${APP_ROOT}/env" >/dev/null 2>&1 || true
  set +a
  printf 'HEALTH_PORT=%q\\nHEALTH_TLS=%q\\n' "\${PORT:-3077}" "\${TLS_ENABLED:-false}"
)"

if [[ "\${HEALTH_TLS}" == "true" ]]; then
  URL="https://127.0.0.1:\${HEALTH_PORT}/healthcheck"; EXTRA="-k"
else
  URL="http://127.0.0.1:\${HEALTH_PORT}/healthcheck"; EXTRA=""
fi
for _ in \$(seq 1 30); do
  if [[ "\$(curl -fsS \${EXTRA} --max-time 3 "\${URL}" 2>/dev/null)" == "OK" ]]; then
    echo "  healthy on \${TARGET}"
    exit 0
  fi
  sleep 1
done
echo "  rolled back but NOT healthy; check pm2 logs" >&2
exit 1
REMOTE
done
