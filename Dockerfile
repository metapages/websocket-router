# Image used by the docker-compose test harness, and usable as a container
# deployment if you would rather not run pm2 on a VM.
#
# Two things it exists to prove, which a test on the host cannot:
#   - the server runs correctly as a non-root user (requirement 6);
#   - certificate issuance works against a real ACME server (pebble).

FROM node:24-bookworm-slim AS build
WORKDIR /build

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY docs/package.json docs/package-lock.json ./docs/
RUN cd docs && npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY web ./web
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs

# vitepress reads git history for per-page "last updated" stamps; there is no
# git in the image and no .git in the context, so turn that one feature off.
ENV VITEPRESS_NO_GIT=1
RUN npm run build:server \
 && npm run build:web \
 && cd docs && npm run build && cd .. \
 && npm run compress

# Drop dev dependencies from the tree that ships.
RUN npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime

# A fixed, high uid so bind-mounted data directories have predictable
# ownership across hosts.
RUN groupadd --gid 10001 router \
 && useradd --uid 10001 --gid router --home-dir /app --no-create-home router

WORKDIR /app

COPY --from=build --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/dist ./dist
COPY --from=build --chown=root:root /build/public ./public
COPY --from=build --chown=root:root /build/docs/.vitepress/dist ./docs/.vitepress/dist
COPY --chown=root:root package.json ./

# Only the data directory is writable. Application code is owned by root and
# read-only to the service user, so a compromised process cannot rewrite the
# thing that will be executed next boot.
RUN mkdir -p /data && chown router:router /data
ENV DATA_DIR=/data

USER router

ENV NODE_ENV=production
EXPOSE 3077
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3077)+'/healthcheck').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
