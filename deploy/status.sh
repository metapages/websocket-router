#!/usr/bin/env bash
#
# What every host is actually running. Read-only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_NAME="${APP_NAME:-websocket-router}"
APP_USER="${APP_USER:-router}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
HOSTS_FILE="${HOSTS_FILE:-deploy/hosts}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new}"

if [[ $# -gt 0 ]]; then
  HOSTS=("$@")
else
  mapfile -t HOSTS < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' \
                           -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                           "${HOSTS_FILE}")
fi

for host in "${HOSTS[@]}"; do
  printf '\033[1m=== %s ===\033[0m\n' "${host}"
  ssh ${SSH_OPTS} "root@${host}" 'bash -s' <<REMOTE || echo "  unreachable"
set -uo pipefail
APP_ROOT="${APP_ROOT}"
APP_USER="${APP_USER}"

echo "  release:  \$(basename "\$(readlink -f "\${APP_ROOT}/current" 2>/dev/null)" 2>/dev/null || echo none)"
echo "  node:     \$(node --version 2>/dev/null || echo missing)"
echo "  systemd:  \$(systemctl is-active "pm2-\${APP_USER}" 2>/dev/null || echo inactive) / \$(systemctl is-enabled "pm2-\${APP_USER}" 2>/dev/null || echo disabled)"
# Whether the inspector is on, never the key itself.
echo "  inspect:  \$(grep -qE '^INSPECT_KEY=.+' "\${APP_ROOT}/env" 2>/dev/null && echo on || echo off)"
echo "  uptime:   \$(uptime -p 2>/dev/null)"
echo "  disk:     \$(df -h / | awk 'NR==2 {print \$4" free of "\$2}')"
sudo -u "\${APP_USER}" -H pm2 jlist 2>/dev/null \
  | node -e '
      let raw = ""; process.stdin.on("data", c => raw += c).on("end", () => {
        try {
          for (const app of JSON.parse(raw)) {
            const e = app.pm2_env || {};
            const m = app.monit || {};
            console.log(\`  pm2:      \${app.name} \${e.status} restarts=\${e.restart_time} mem=\${Math.round((m.memory||0)/1048576)}MB cpu=\${m.cpu}%\`);
          }
        } catch { console.log("  pm2:      (no processes)"); }
      });
    ' 2>/dev/null || echo "  pm2:      unavailable"
REMOTE
  echo
done
