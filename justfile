# just docs: https://github.com/casey/just
set shell         := ["bash", "-c"]
set dotenv-load   := true
set export        := true

REDIS_URL         := env_var_or_default("REDIS_URL", "redis://localhost:6379")
APP_FQDN          := env_var_or_default("APP_FQDN", "localhost:3077")
PORT              := env_var_or_default("PORT", "3077")

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
	echo -e "    Github  URL 🔗        {{ green }}https://github.com/metapages/websocket-router{{ normal }}"
	echo -e "    Deploy Console URL 🔗 {{ green }}https://console.deno.com/metapage/websocket-router{{ normal }}"
	echo -e ""

# Run the server locally, restarting on changes
dev:
	deno run -A --watch ./src/serve.ts

# Run the server locally, the same way deno deploy runs it
serve:
	deno run -A ./src/serve.ts

@check:
	deno check --allow-import src/serve.ts

# Deploy to Deno Deploy production. Deploy config lives in the `deploy` block of deno.json.
deploy: check
	#!/usr/bin/env bash
	set -euo pipefail
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
	    exit 0
	  fi
	  echo -e "{{ yellow }}Deploy attempt $i did not confirm success (exit $code); retrying...{{ normal }}"
	  sleep 5
	done
	echo -e "{{ magenta }}Deploy failed after $attempts attempts.{{ normal }}"
	exit 1

# Tail the production logs
logs:
	deno deploy logs

# Push the local .env values into the Deno Deploy application
env-push:
	deno deploy env load .env

# Show the environment variables configured on the Deno Deploy application
env-list:
	deno deploy env list
