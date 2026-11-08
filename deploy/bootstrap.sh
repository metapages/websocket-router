#!/usr/bin/env bash
#
# One-time per-host setup. Run once per new instance, as root, before the
# first `deploy.sh`. Idempotent: safe to re-run to repair a host.
#
#   ssh root@host 'bash -s' < deploy/bootstrap.sh
#
# What it establishes:
#   - a dedicated unprivileged service user that owns nothing it executes;
#   - Node.js from NodeSource;
#   - pm2, started by systemd so the router survives a reboot;
#   - pm2-logrotate, so pm2's own stdout capture stays bounded;
#   - CAP_NET_BIND_SERVICE for ports 80 and 443 without running as root.

set -euo pipefail

APP_NAME="${APP_NAME:-websocket-router}"
APP_USER="${APP_USER:-router}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
DATA_DIR="${DATA_DIR:-/var/lib/${APP_NAME}}"
LOG_DIR="${LOG_DIR:-/var/log/${APP_NAME}}"
NODE_MAJOR="${NODE_MAJOR:-24}"

say() { printf '\033[1;34m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "bootstrap.sh must run as root" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# packages
# ---------------------------------------------------------------------------

say "installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg libcap2-bin >/dev/null

if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node --version | cut -d. -f1 | tr -d v)" -lt "${NODE_MAJOR}" ]]; then
  say "installing Node.js ${NODE_MAJOR}.x"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
say "node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------------------
# swap
# ---------------------------------------------------------------------------

# `deploy.sh` runs `npm ci` on the host so native builds match the host's own
# Node. On the smallest droplets (512 MB, no swap by default) that is the one
# step that can plausibly be OOM-killed, and an OOM mid-install leaves a
# release directory with a half-populated node_modules. A small swap file is
# the cheapest insurance; it is only touched under memory pressure.
TOTAL_RAM_MB="$(free -m | awk '/^Mem:/ {print $2}')"
SWAP_MB="$(free -m | awk '/^Swap:/ {print $2}')"
SWAP_FILE="${SWAP_FILE:-/swapfile}"

if [[ "${SWAP_MB}" -eq 0 && "${TOTAL_RAM_MB}" -lt 2048 ]]; then
  say "adding a 1G swap file (${TOTAL_RAM_MB}MB RAM, no swap)"
  if ! fallocate -l 1G "${SWAP_FILE}" 2>/dev/null; then
    dd if=/dev/zero of="${SWAP_FILE}" bs=1M count=1024 status=none
  fi
  chmod 600 "${SWAP_FILE}"
  mkswap "${SWAP_FILE}" >/dev/null
  swapon "${SWAP_FILE}"
  if ! grep -q "^${SWAP_FILE} " /etc/fstab; then
    echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
  fi
  # Prefer RAM; this swap exists for burst headroom, not for running on.
  sysctl -q -w vm.swappiness=10
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-websocket-router.conf
  say "swap active: $(free -h | awk '/^Swap:/ {print $2}')"
else
  say "swap: ${SWAP_MB}MB with ${TOTAL_RAM_MB}MB RAM, leaving it alone"
fi

# ---------------------------------------------------------------------------
# service user and directories
# ---------------------------------------------------------------------------

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  say "creating service user ${APP_USER}"
  # No login shell and no password: this account exists to run one process.
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
          --shell /usr/sbin/nologin "${APP_USER}"
fi

say "creating directories"
# Releases are owned by root and only readable by the service user, so a
# compromised router process cannot rewrite the code that runs next boot.
install -d -o root -g root -m 0755 "${APP_ROOT}" "${APP_ROOT}/releases"
# Writable state: settings, ACME keys, the router's own rotated logs.
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${DATA_DIR}"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${LOG_DIR}"

# ---------------------------------------------------------------------------
# pm2, managed by systemd
# ---------------------------------------------------------------------------

if ! command -v pm2 >/dev/null 2>&1; then
  say "installing pm2"
  npm install -g pm2 >/dev/null
fi
say "pm2 $(pm2 --version 2>/dev/null | tail -1)"

say "configuring pm2 log rotation"
# The router writes its own rotated JSON logs; this bounds pm2's separate
# capture of stdout, which is what `pm2 logs` reads.
sudo -u "${APP_USER}" -H pm2 install pm2-logrotate >/dev/null 2>&1 || \
  warn "pm2-logrotate install reported an error; continuing"
sudo -u "${APP_USER}" -H pm2 set pm2-logrotate:max_size 20M >/dev/null 2>&1 || true
sudo -u "${APP_USER}" -H pm2 set pm2-logrotate:retain 10 >/dev/null 2>&1 || true
sudo -u "${APP_USER}" -H pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true
sudo -u "${APP_USER}" -H pm2 set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null 2>&1 || true

say "registering pm2 with systemd"
# `pm2 startup` prints the command to run; -u/--hp make it generate a unit for
# the service user rather than root.
pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" >/dev/null
systemctl enable "pm2-${APP_USER}" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# privileged ports without root
# ---------------------------------------------------------------------------

say "granting CAP_NET_BIND_SERVICE for ports 80 and 443"
# A systemd drop-in rather than `setcap` on the node binary: setcap would let
# *any* node process on the box bind low ports, while AmbientCapabilities
# grants it only to this service and its children. A drop-in also survives
# `pm2 startup` regenerating the unit.
DROPIN_DIR="/etc/systemd/system/pm2-${APP_USER}.service.d"
install -d -m 0755 "${DROPIN_DIR}"
cat > "${DROPIN_DIR}/override.conf" <<UNIT
[Service]
# Bind :80 and :443 as an unprivileged user. CAP_NET_BIND_SERVICE is the only
# capability needed; everything else stays dropped.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

# Nothing here needs to write outside its own state directories.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${DATA_DIR} ${LOG_DIR} /home/${APP_USER}/.pm2
UNIT

systemctl daemon-reload

# ---------------------------------------------------------------------------
# environment file
# ---------------------------------------------------------------------------

ENV_FILE="${APP_ROOT}/env"
if [[ ! -f "${ENV_FILE}" ]]; then
  say "writing a template environment file at ${ENV_FILE}"
  cat > "${ENV_FILE}" <<ENVFILE
# Environment for ${APP_NAME}. Edit this, then re-run deploy.sh.
# Readable only by ${APP_USER}: it holds the admin password.

# --- required when TLS is on ---
TLS_ENABLED=false
TLS_DOMAINS=
TLS_EMAIL=

# --- connection inspector ---
# Serves a live list of connections at /<INSPECT_KEY>. The path IS the
# credential: there is no login, and an empty value means the route does not
# exist. At least 16 characters of [A-Za-z0-9_-]:
#   openssl rand -hex 16
# Set from CI instead (a repository secret) and deploy.sh writes it here.
INSPECT_KEY=

# --- admin panel: unset ADMIN_PASSWORD to disable it entirely ---
ADMIN_PASSWORD=
# Keeps admin sessions valid across restarts. Generate once:
#   openssl rand -hex 32
ADMIN_SESSION_SECRET=

# --- paths and limits ---
DATA_DIR=${DATA_DIR}
LOG_DIR=${LOG_DIR}
LOG_LEVEL=info
LOG_MAX_SIZE=20m
LOG_RETAIN_FILES=10
WS_DEFAULT_MAX_MESSAGE_BYTES=1048576
WS_HARD_MAX_MESSAGE_BYTES=16777216

# --- listeners ---
# With TLS_ENABLED=true these default to 443 and 80.
PORT=3077
HTTP_PORT=80
ENVFILE
  chown root:"${APP_USER}" "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  warn "edit ${ENV_FILE} before deploying: set TLS_DOMAINS, TLS_EMAIL and ADMIN_PASSWORD"
else
  say "keeping the existing ${ENV_FILE}"
fi

say "bootstrap complete on $(hostname)"
echo
echo "  next:"
echo "    1. edit ${ENV_FILE}"
echo "    2. point DNS at this host"
echo "    3. run deploy/deploy.sh from a checkout"
