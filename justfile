# just docs: https://github.com/casey/just
set shell         := ["bash", "-c"]
set dotenv-load   := true
set export        := true

PORT              := env_var_or_default("PORT", "3077")
APP_FQDN          := env_var_or_default("APP_FQDN", "localhost:3077")
DATA_DIR          := env_var_or_default("DATA_DIR", "./data")
ADMIN_PASSWORD    := env_var_or_default("ADMIN_PASSWORD", "")
LOG_LEVEL         := env_var_or_default("LOG_LEVEL", "info")

###########################################################################
# Formatting
###########################################################################
bold              := '\033[1m'
normal            := '\033[0m'
green             := "\\e[32m"
yellow            := "\\e[33m"
blue              := "\\e[34m"
magenta           := "\\e[35m"
grey              := "\\e[90m"

@_help:
	echo ""
	just --list --unsorted --list-heading $'🪐 Commands for the websocket router:\n'
	echo -e ""
	echo -e "    Production URL 🔗     {{ green }}https://router.metapage.io{{ normal }}"
	echo -e "    Documentation 🔗      {{ green }}https://router.metapage.io/docs/{{ normal }}"
	echo -e "    Admin panel 🔗        {{ green }}https://router.metapage.io/admin{{ normal }}"
	echo -e "    Github  URL 🔗        {{ green }}https://github.com/metapages/websocket-router{{ normal }}"
	echo -e ""
	echo -e "    {{ grey }}Single process, no broker. Each deployed host is an independent router.{{ normal }}"
	echo -e ""

###########################################################################
# Develop
###########################################################################

# Install everything (app + docs toolchains)
install:
	npm ci --no-audit --no-fund
	cd docs && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)

# Run locally. Rebuilds browser bundles and restarts the server on any change.
dev:
	#!/usr/bin/env bash
	set -euo pipefail
	# Two watchers: vite rebuilds the browser bundles into dist/web, tsx
	# restarts the server on a src/ change. The server re-reads the channel
	# page template when vite rewrites it, so a web edit needs no restart.
	#
	# The binaries are invoked directly rather than through npx: `npx` inserts
	# an `npm exec` wrapper process, and signalling that wrapper leaves the
	# real `node vite` running. An orphaned watcher keeps rebuilding into
	# dist/ after you think you have stopped, which is a confusing thing to
	# debug later.
	VITE=./node_modules/.bin/vite
	TSX=./node_modules/.bin/tsx
	echo -e "{{ blue }}▸ vite build --watch + tsx watch{{ normal }}"
	# Build once and wait, so the server cannot start before dist/web exists
	# and fail with "browser bundles are missing".
	"$VITE" build --logLevel warn
	"$VITE" build --watch --logLevel warn &
	vite_pid=$!
	cleanup() {
	  # Children first, then the watcher itself.
	  pkill -P "$vite_pid" 2>/dev/null || true
	  kill "$vite_pid" 2>/dev/null || true
	}
	trap cleanup EXIT INT TERM
	# tsx stays in the foreground, so Ctrl-C reaches it and the trap above
	# then cleans up vite. tsx kills its own server child on the way out.
	ADMIN_PASSWORD="${ADMIN_PASSWORD:-dev}" \
	LOG_LEVEL="${LOG_LEVEL:-debug}" \
	  "$TSX" watch src/index.ts

# Run the server from source without watching anything
dev-once: build-web
	ADMIN_PASSWORD="${ADMIN_PASSWORD:-dev}" npx tsx src/index.ts

# Run exactly as production does: full build, NODE_ENV=production, no watchers
prod: build-all
	#!/usr/bin/env bash
	set -euo pipefail
	# TLS stays off unless you set TLS_ENABLED and TLS_DOMAINS yourself; it
	# needs a public DNS name and port 80, which localhost does not have.
	echo -e "{{ blue }}▸ production mode on port ${PORT:-3077}{{ normal }}"
	echo -e "{{ grey }}  docs at /docs, admin at /admin if ADMIN_PASSWORD is set{{ normal }}"
	NODE_ENV=production node dist/server/index.js

# Alias for `just prod`, kept because the recipe used to be called this
serve: prod

###########################################################################
# Build
###########################################################################

# Everything: server, browser bundles, precompressed variants
build: build-server build-web compress

@build-server:
	echo -e "{{ blue }}▸ tsc (server){{ normal }}"
	npx tsc -p tsconfig.json

@build-web:
	echo -e "{{ blue }}▸ vite build (browser){{ normal }}"
	npx vite build

# Write .br and .gz siblings for every compressible build artifact
@compress:
	echo -e "{{ blue }}▸ precompress{{ normal }}"
	node scripts/precompress.mjs

# A full production build, docs included. What deploy.sh runs.
build-all: build-server build-web docs-build compress

@clean:
	rm -rf dist docs/.vitepress/dist docs/.vitepress/cache data

###########################################################################
# Quality gates (CI runs `just ci`)
###########################################################################

@check:
	echo -e "{{ blue }}▸ tsc --noEmit (server, web, tests){{ normal }}"
	npx tsc -p tsconfig.json --noEmit
	npx tsc -p tsconfig.web.json --noEmit
	npx tsc -p tsconfig.test.json --noEmit

# Everything CI enforces, in the order CI runs it
ci: check build-all test-local

###########################################################################
# Test
###########################################################################

# The suite in docker-compose: non-root, as production runs it. The default.
test:
	#!/usr/bin/env bash
	set -euo pipefail
	echo -e "{{ blue }}▸ integration suite (docker-compose){{ normal }}"
	trap 'docker compose -f docker-compose.test.yml down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
	docker compose -f docker-compose.test.yml build tests
	docker compose -f docker-compose.test.yml run --rm tests

# The ACME suite against pebble, Let's Encrypt's test server
test-acme:
	#!/usr/bin/env bash
	set -euo pipefail
	echo -e "{{ blue }}▸ ACME suite (pebble){{ normal }}"
	trap 'docker compose -f docker-compose.test.yml --profile acme down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
	docker compose -f docker-compose.test.yml --profile acme build acme-tests
	docker compose -f docker-compose.test.yml --profile acme run --rm acme-tests

# Everything, including ACME
test-all: test test-acme

# On the host, without docker. Faster to iterate; skips non-root and ACME.
test-local +args="": build
	#!/usr/bin/env bash
	set -euo pipefail
	echo -e "{{ blue }}▸ integration suite (host){{ normal }}"
	echo -e "{{ grey }}  non-root and ACME coverage need \`just test\` / \`just test-acme\`{{ normal }}"
	npx vitest run {{ args }}

# Watch mode against the host
test-watch: build
	npx vitest

###########################################################################
# Documentation (vitepress, served by the router at /docs)
###########################################################################

@docs-install:
	cd docs && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)

docs-dev: _docs-ensure-install
	cd docs && npm run dev

# Build the docs into docs/.vitepress/dist, which the server mounts at /docs
docs-build: _docs-ensure-install
	#!/usr/bin/env bash
	set -euo pipefail
	echo -e "{{ blue }}▸ vitepress build{{ normal }}"
	# Rebuild from empty so pages deleted from the source cannot linger in the
	# output and get uploaded.
	rm -rf docs/.vitepress/dist
	cd docs && npm run build
	echo -e "{{ green }}Docs built into docs/.vitepress/dist{{ normal }}"

# Fail if build output has been committed. dist is gitignored - see .gitignore.
@docs-not-committed:
	echo -e "{{ blue }}▸ checking docs/.vitepress/dist is not tracked{{ normal }}"
	if [ -n "$(git ls-files docs/.vitepress/dist)" ]; then \
	  echo -e "{{ magenta }}docs/.vitepress/dist is build output and must not be committed.{{ normal }}"; \
	  echo -e "{{ yellow }}Remove it with: git rm -r --cached docs/.vitepress/dist{{ normal }}"; \
	  exit 1; \
	fi

@_docs-ensure-install:
	if [ ! -d docs/node_modules ]; then just docs-install; fi

###########################################################################
# Deploy
###########################################################################

# One-time setup for a new host: user, node, pm2, systemd, capabilities
bootstrap host:
	#!/usr/bin/env bash
	set -euo pipefail
	echo -e "{{ blue }}▸ bootstrapping {{ host }}{{ normal }}"
	ssh root@{{ host }} 'bash -s' < deploy/bootstrap.sh
	echo -e "{{ yellow }}Now edit /opt/websocket-router/env on {{ host }}, then \`just deploy\`.{{ normal }}"

# Build and deploy to every host in deploy/hosts
deploy *hosts:
	./deploy/deploy.sh {{ hosts }}

# Show what a deploy would do, without touching a host
deploy-dry *hosts:
	DRY_RUN=1 ./deploy/deploy.sh {{ hosts }}

# Point `current` back at the previous release
rollback *args:
	./deploy/rollback.sh {{ args }}

# What every host is running
status *hosts:
	./deploy/status.sh {{ hosts }}

# Tail the router's logs on a host
logs host lines="100":
	ssh root@{{ host }} "sudo -u router -H pm2 logs websocket-router --lines {{ lines }}"

# Smoke test a deployment over the network
verify url="https://router.metapage.io":
	#!/usr/bin/env bash
	set -euo pipefail
	url="{{ url }}"
	fail=0
	# `label` exists so a secret path can be checked without printing it.
	check() {
	  local path="$1" expect="$2" needle="${3:-}" label="${4:-$1}"
	  local body code
	  body=$(curl -sS -L --max-time 20 -w '\n%{http_code}' "$url$path" || echo $'\n000')
	  code=$(tail -n1 <<<"$body")
	  body=$(sed '$d' <<<"$body")
	  if [ "$code" != "$expect" ]; then
	    echo -e "  {{ magenta }}✗ $label -> $code (expected $expect){{ normal }}"; fail=1; return
	  fi
	  if [ -n "$needle" ] && ! grep -qF "$needle" <<<"$body"; then
	    echo -e "  {{ magenta }}✗ $label -> $code but missing '$needle'{{ normal }}"; fail=1; return
	  fi
	  echo -e "  {{ green }}✓ $label -> $code{{ normal }}"
	}
	check_absent() {
	  local path="$1" needle="$2" label="${3:-$1}"
	  local body
	  body=$(curl -sS -L --max-time 20 "$url$path" || true)
	  if grep -qF "$needle" <<<"$body"; then
	    echo -e "  {{ magenta }}✗ $label unexpectedly served '$needle'{{ normal }}"; fail=1; return
	  fi
	  echo -e "  {{ green }}✓ $label does not serve '$needle'{{ normal }}"
	}
	echo -e "{{ blue }}▸ verifying $url{{ normal }}"
	check /healthcheck 200 OK
	check / 200 "except the sender"
	# Every needle here must be something ONLY the built docs emit. Any
	# unmatched path is served the channel page, so a needle as generic as the
	# site name passes even when /docs was never built at all.
	check /docs/ 200 'name="generator" content="VitePress'
	check /docs/guide/introduction 200 "vp-doc"
	check /docs/reference/api 200 "POST /:channel"
	# A channel name must NOT be served documentation. This is the other half
	# of the check above: together they prove /docs is a real mount rather
	# than the catch-all swallowing everything.
	check /verify-not-a-docs-page 200 qrimage
	# The inspector, when a key is available (CI passes the repository secret;
	# locally it comes from .env). The key is never printed: it is the whole
	# credential, and `just verify` output ends up in CI logs and terminals.
	# Skipped silently when there is no key, so this recipe stays usable by
	# anyone verifying a deployment they do not hold the secret for.
	if [ -n "${INSPECT_KEY:-}" ]; then
	  echo -e "{{ blue }}▸ inspector{{ normal }}"
	  check "/$INSPECT_KEY" 200 "Connection inspector" "/<INSPECT_KEY>"
	  check "/$INSPECT_KEY/api/channels" 200 '"channels"' "/<INSPECT_KEY>/api/channels"
	  # Exactly the key, not a prefix of it: a near miss has to be served the
	  # ordinary channel page, which is what makes the real path unfindable.
	  check_absent "/${INSPECT_KEY}x" "Connection inspector" "/<INSPECT_KEY>x"
	fi
	echo -e "{{ blue }}▸ compression{{ normal }}"
	enc=$(curl -sS -H 'Accept-Encoding: br' -o /dev/null -w '%{content_type}' "$url/" || true)
	bundle=$(curl -sS "$url/" | grep -o '/_/assets/[^"]*\.js' | head -1 || true)
	if [ -n "$bundle" ]; then
	  got=$(curl -sS -H 'Accept-Encoding: br' -D- -o /dev/null "$url$bundle" | tr -d '\r' | awk -F': ' '/^[Cc]ontent-[Ee]ncoding/{print $2}')
	  if [ "$got" = "br" ]; then
	    echo -e "  {{ green }}✓ $bundle -> brotli{{ normal }}"
	  else
	    echo -e "  {{ magenta }}✗ $bundle -> content-encoding '$got' (expected br){{ normal }}"; fail=1
	  fi
	fi
	echo -e "{{ blue }}▸ websocket round trip{{ normal }}"
	node ./scripts/verify-production.mjs "$url" || fail=1
	if [ "$fail" != "0" ]; then
	  echo -e "{{ magenta }}Verification FAILED.{{ normal }}"
	  exit 1
	fi
	echo -e "{{ green }}Verified.{{ normal }}"
