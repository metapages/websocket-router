# just docs: https://github.com/casey/just
set shell         := ["bash", "-c"]
set dotenv-load   := true
set export        := true

REDIS_URL         := env_var_or_default("REDIS_URL", "redis://localhost:6379")
APP_FQDN          := env_var_or_default("APP_FQDN", "localhost:3077")
PORT              := env_var_or_default("PORT", "3077")
TEST_REDIS_PORT   := env_var_or_default("TEST_REDIS_PORT", "6399")
TEST_REDIS_NAME   := "websocket-router-test-redis"

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
	echo -e "    Production URL 🔗     {{ green }}https://websocket-router.metapage.deno.net{{ normal }}"
	echo -e "    Documentation 🔗      {{ green }}https://websocket-router.metapage.deno.net/docs/{{ normal }}"
	echo -e "    Github  URL 🔗        {{ green }}https://github.com/metapages/websocket-router{{ normal }}"
	echo -e "    Deploy Console URL 🔗 {{ green }}https://console.deno.com/metapage/websocket-router{{ normal }}"
	echo -e ""

###########################################################################
# Develop
###########################################################################

# Run the server locally, restarting on changes
dev:
	deno run -A --watch ./src/serve.ts

# Run the server locally, the same way deno deploy runs it
serve:
	deno run -A ./src/serve.ts

###########################################################################
# Quality gates (CI runs `just ci`)
###########################################################################

# Format every source file in place
@fmt:
	deno fmt

# Fail if anything is not formatted. This is what CI enforces.
@fmt-check:
	echo -e "{{ blue }}▸ deno fmt --check{{ normal }}"
	deno fmt --check

@lint:
	echo -e "{{ blue }}▸ deno lint{{ normal }}"
	deno lint

@check:
	echo -e "{{ blue }}▸ deno check{{ normal }}"
	deno check --allow-import src/serve.ts

# Everything CI enforces, in the order CI runs it
ci: fmt-check lint check docs-not-committed docs-build test

###########################################################################
# Test
###########################################################################

# Integration tests against a disposable redis started in docker
test:
	#!/usr/bin/env bash
	set -euo pipefail
	cleanup() { docker rm -f "{{ TEST_REDIS_NAME }}" >/dev/null 2>&1 || true; }
	trap cleanup EXIT
	cleanup
	echo -e "{{ blue }}▸ starting test redis on port {{ TEST_REDIS_PORT }}{{ normal }}"
	docker run -d --rm --name "{{ TEST_REDIS_NAME }}" \
	  -p "{{ TEST_REDIS_PORT }}:6379" redis:7-alpine >/dev/null
	for _ in $(seq 1 40); do
	  if docker exec "{{ TEST_REDIS_NAME }}" redis-cli ping >/dev/null 2>&1; then break; fi
	  sleep 0.25
	done
	REDIS_URL="redis://localhost:{{ TEST_REDIS_PORT }}" just test-only

# Integration tests against whatever REDIS_URL already points at
@test-only +args="":
	echo -e "{{ blue }}▸ deno test (REDIS_URL=$REDIS_URL){{ normal }}"
	deno test --allow-all --no-check test/integration/ {{ args }}

###########################################################################
# Documentation (vitepress, served by the router at /docs)
###########################################################################

# Install the docs toolchain (node + npm, separate from the deno app)
@docs-install:
	cd docs && npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Live-reloading docs while writing them
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

# Serve the built docs standalone, without the router
docs-preview: docs-build
	cd docs && npm run preview

@_docs-ensure-install:
	if [ ! -d docs/node_modules ]; then just docs-install; fi

###########################################################################
# Deploy
###########################################################################

# Deploy to Deno Deploy production. Deploy config lives in the `deploy` block of deno.json.
deploy: check docs-build
	#!/usr/bin/env bash
	set -euo pipefail
	# The docs are gitignored build output that only reaches production because
	# `deploy.include` in deno.json names the path explicitly. `docs-build` above
	# just made them; refuse to deploy if it did not.
	if [ ! -f docs/.vitepress/dist/index.html ]; then
	  echo -e "{{ magenta }}docs/.vitepress/dist is missing; refusing to deploy without /docs.{{ normal }}"
	  exit 1
	fi
	# `deno deploy` intermittently hangs mid-upload and is then killed by Deno's
	# top-level-await watchdog with exit 1, even when nothing is wrong. Deploys
	# create a fresh revision each time, so retry and treat the run as successful
	# only when the CLI prints its genuine confirmation line.
	attempts=3
	for i in $(seq 1 $attempts); do
	  echo -e "{{ blue }}deno deploy attempt $i/$attempts{{ normal }}"
	  set +e
	  timeout 420 deno deploy --prod 2>&1 | tee deploy.log
	  code=${PIPESTATUS[0]}
	  set -e
	  if grep -q "Successfully deployed your application" deploy.log; then
	    echo -e "{{ green }}Deploy succeeded.{{ normal }}"
	    rm -f deploy.log
	    just verify-production
	    exit 0
	  fi
	  echo -e "{{ yellow }}Deploy attempt $i did not confirm success (exit $code); retrying...{{ normal }}"
	  sleep 5
	done
	echo -e "{{ magenta }}Deploy failed after $attempts attempts.{{ normal }}"
	exit 1

# Smoke test production over the network. Run by `just deploy`.
verify-production url="https://websocket-router.metapage.deno.net":
	#!/usr/bin/env bash
	set -euo pipefail
	url="{{ url }}"
	fail=0
	check() {
	  local path="$1" expect="$2" needle="${3:-}"
	  local body code
	  body=$(curl -sS -L --max-time 20 -w '\n%{http_code}' "$url$path" || echo $'\n000')
	  code=$(tail -n1 <<<"$body")
	  body=$(sed '$d' <<<"$body")
	  if [ "$code" != "$expect" ]; then
	    echo -e "  {{ magenta }}✗ $path -> $code (expected $expect){{ normal }}"; fail=1; return
	  fi
	  if [ -n "$needle" ] && ! grep -qF "$needle" <<<"$body"; then
	    echo -e "  {{ magenta }}✗ $path -> $code but missing '$needle'{{ normal }}"; fail=1; return
	  fi
	  echo -e "  {{ green }}✓ $path -> $code{{ normal }}"
	}
	echo -e "{{ blue }}▸ verifying $url{{ normal }}"
	check /healthcheck 200 OK
	check / 200 "except the sender"
	# The docs are gitignored build output; if `deploy.include` ever stops
	# naming them, this is what catches it.
	check /docs/ 200 "Websocket Router"
	check /docs/guide/introduction 200 "address space"
	check /docs/reference/api 200 "POST /:channel"
	echo -e "{{ blue }}▸ websocket round trip{{ normal }}"
	deno run --quiet --allow-net ./test/verify-production.ts "$url" || fail=1
	if [ "$fail" != "0" ]; then
	  echo -e "{{ magenta }}Production verification FAILED.{{ normal }}"
	  exit 1
	fi
	echo -e "{{ green }}Production verified.{{ normal }}"

# Tail the production logs
logs:
	deno deploy logs

# Push the local .env values into the Deno Deploy application
env-push:
	deno deploy env load .env

# Show the environment variables configured on the Deno Deploy application
env-list:
	deno deploy env list
