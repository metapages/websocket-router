import { join } from "node:path";

import compression from "compression";
import express, { type Express } from "express";
import type { Logger } from "pino";

import { createAdminRouter } from "./admin/routes.js";
import type { AdminAuth } from "./admin/auth.js";
import type { ChannelPageRenderer } from "./channelPage.js";
import type { ChannelRegistry } from "./channels.js";
import type { Config } from "./config.js";
import type { Logs } from "./logger.js";
import { isReservedPath } from "./reserved.js";
import type { SettingsStore } from "./settings.js";
import { safeJoin, sendStaticFile, staticMount } from "./staticAssets.js";
import type { ChallengeResponder } from "./tls/acme.js";

export type HttpDeps = {
  readonly config: Config;
  readonly registry: ChannelRegistry;
  readonly settings: SettingsStore;
  readonly logs: Logs;
  readonly auth: AdminAuth;
  readonly renderChannelPage: ChannelPageRenderer;
  readonly webRoot: string;
  readonly docsRoot: string;
  readonly publicRoot: string;
  readonly docsBuilt: boolean;
  readonly startedAt: number;
  readonly challenge?: ChallengeResponder;
};

const DOCS_MISSING_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Docs not built</title></head>
<body style="font-family:system-ui;max-width:40em;margin:4em auto;padding:0 1em">
<h1>Docs not built</h1>
<p>The documentation site has not been built into <code>docs/.vitepress/dist</code>.</p>
<pre style="background:#eee;padding:1em;border-radius:6px">just docs-build</pre>
<p><a href="/">&larr; back to the router</a></p>
</body></html>`;

/**
 * The plain :80 listener when TLS is on.
 *
 * It does exactly two things: answer ACME HTTP-01 challenges, and redirect
 * everything else to https. It is deliberately *not* the full application —
 * an earlier version reused `createHttpApp` here and appended a redirect,
 * which never fired because the channel-page catch-all claimed every request
 * first. The effect was that the whole site, admin panel included, was served
 * over plaintext on port 80 while TLS sat unused on 443.
 */
export const createRedirectApp = (deps: {
  readonly challenge: ChallengeResponder;
  readonly domains: string[];
  readonly fqdn: string;
  readonly logger: Logger;
}): Express => {
  const { challenge, domains, fqdn } = deps;
  const app = express();
  app.disable("x-powered-by");

  // Never redirected and never compressed: this is what the CA fetches.
  app.get("/.well-known/acme-challenge/:token", (request, response) => {
    const keyAuthorization = challenge.tokens.get(request.params.token);
    if (!keyAuthorization) {
      response.status(404).type("text/plain").send("not found");
      return;
    }
    response.type("text/plain").send(keyAuthorization);
  });

  const allowed = new Set(domains.map((domain) => domain.toLowerCase()));

  app.use((request, response) => {
    // Preserve the requested host when the certificate covers it, so a
    // multi-domain deployment does not funnel every visitor at the first
    // name in TLS_DOMAINS. Anything else is redirected to the canonical one.
    const requested = (request.headers.host ?? "").split(":")[0]?.toLowerCase();
    const target = requested && allowed.has(requested) ? requested : fqdn;
    response.redirect(301, `https://${target}${request.originalUrl}`);
  });

  return app;
};

export const createHttpApp = (deps: HttpDeps): Express => {
  const {
    config,
    registry,
    settings,
    logs,
    auth,
    renderChannelPage,
    webRoot,
    docsRoot,
    publicRoot,
    docsBuilt,
    startedAt,
    challenge,
  } = deps;
  const logger: Logger = logs.logger;

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", true);

  // ---------------------------------------------------------------------
  // ACME HTTP-01. Must come before everything, must never be compressed or
  // redirected, and is mounted on both listeners so a challenge arriving on
  // :443 during a renewal is still answered.
  // ---------------------------------------------------------------------
  if (challenge) {
    app.get("/.well-known/acme-challenge/:token", (request, response) => {
      const keyAuthorization = challenge.tokens.get(request.params.token);
      if (!keyAuthorization) {
        response.status(404).type("text/plain").send("not found");
        return;
      }
      response.type("text/plain").send(keyAuthorization);
    });
  }

  // Dynamic responses (the channel page, admin JSON) are gzipped on the fly.
  // Static assets are served from their precompressed .br/.gz siblings by
  // `staticMount` below, which this must not interfere with.
  app.use(
    compression({
      filter: (request, response) => {
        if (response.getHeader("Content-Encoding")) return false;
        return compression.filter(request, response);
      },
    }),
  );

  // CORS stays open to every origin: clients are arbitrary third-party pages,
  // which is the entire point of a public address space.
  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthcheck", (_request, response) => {
    response.type("text/plain").send("OK");
  });

  // ---------------------------------------------------------------------
  // admin
  // ---------------------------------------------------------------------
  if (config.adminEnabled) {
    app.use(
      "/admin",
      express.json({ limit: "64kb" }),
      createAdminRouter({
        config,
        auth,
        settings,
        registry,
        logs,
        webRoot,
        startedAt,
      }),
    );
    logger.info("admin: panel enabled at /admin");
  } else {
    logger.info("admin: disabled (set ADMIN_PASSWORD to enable)");
  }

  // Browser bundles for the channel page and the admin panel.
  app.use(
    staticMount({
      root: webRoot,
      prefix: "/_/",
      // Vite content-hashes everything under assets/, so those can be
      // cached forever.
      immutablePattern: /^assets\//,
    }),
  );

  app.get("/", (request, response, next) => {
    void (async () => {
      const file = safeJoin(webRoot, "channel/landing.html");
      if (file && (await sendStaticFile(request, response, file, { maxAgeSeconds: 60 }))) {
        return;
      }
      next();
    })().catch(next);
  });

  // ---------------------------------------------------------------------
  // documentation
  // ---------------------------------------------------------------------
  app.use((request, response, next) => {
    void (async () => {
      const path = request.path;
      if (path !== "/docs" && !path.startsWith("/docs/")) return next();
      // Static documentation answers reads only. Without this, a POST to
      // /docs got the trailing-slash redirect below, which is a GET
      // behaviour; it now falls through to the reserved-path 404.
      if (request.method !== "GET" && request.method !== "HEAD") return next();

      if (!docsBuilt) {
        response.status(503).type("text/html").send(DOCS_MISSING_HTML);
        return;
      }
      if (path === "/docs") {
        response.redirect(302, "/docs/");
        return;
      }

      const relative = path.slice("/docs/".length);
      const immutable = relative.startsWith("assets/");
      const candidates = relative === ""
        ? ["index.html"]
        : [relative, `${relative}.html`, join(relative, "index.html")];

      for (const candidate of candidates) {
        const absolute = safeJoin(docsRoot, candidate);
        if (absolute === null) continue;
        const sent = await sendStaticFile(request, response, absolute, {
          maxAgeSeconds: immutable ? 31_536_000 : 0,
          immutable,
        });
        if (sent) return;
      }

      const notFound = safeJoin(docsRoot, "404.html");
      if (notFound) {
        response.status(404);
        if (await sendStaticFile(request, response, notFound, { maxAgeSeconds: 0 })) {
          return;
        }
      }
      response.status(404).type("text/plain").send("not found");
    })().catch(next);
  });

  // Legacy /public assets (favicon, anything linked by absolute path).
  app.use((request, response, next) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      const filename = request.path.split("/").pop() ?? "";
      // Channel names live at arbitrary paths; only something that looks like
      // a filename is a candidate for the static root.
      if (!filename.includes(".")) return next();

      for (const candidate of [request.path.slice(1), filename]) {
        const absolute = safeJoin(publicRoot, candidate);
        if (absolute === null) continue;
        if (await sendStaticFile(request, response, absolute, { maxAgeSeconds: 3600 })) {
          return;
        }
      }
      return next();
    })().catch(next);
  });

  // ---------------------------------------------------------------------
  // Reserved prefixes.
  //
  // Every path that reaches the bottom of this stack is treated as a channel,
  // so without this guard `/admin` would be a perfectly usable channel name —
  // and anything built on it would break the day someone sets ADMIN_PASSWORD.
  // Reserving these unconditionally keeps the channel namespace the same shape
  // whether or not the panel is enabled, and makes a request to a disabled
  // panel 404 rather than quietly returning a channel page with a 200.
  //
  // This sits after every real handler for these prefixes, so it only catches
  // what none of them claimed.
  // ---------------------------------------------------------------------
  app.use((request, response, next) => {
    if (!isReservedPath(request.path)) return next();
    response.status(404).type("text/plain").send("not found");
  });

  // ---------------------------------------------------------------------
  // channels
  // ---------------------------------------------------------------------

  /**
   * Anything POSTed to a channel is broadcast to every listener on it. There
   * is no sending socket to exclude, so unlike a websocket message it does
   * reach everyone.
   *
   * The body is routed as a binary frame when the content type says so, and
   * as text otherwise, which keeps `curl -d` behaving exactly as before.
   */
  app.post(
    "/:channel",
    express.raw({ type: "*/*", limit: config.hardMaxMessageBytes }),
    (request, response) => {
      const channel = request.params.channel;
      const body: Buffer = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);

      const limit = settings.get().maxMessageBytes;
      if (body.byteLength > limit) {
        response
          .status(413)
          .type("text/plain")
          .send(`message exceeds the ${limit} byte limit`);
        return;
      }

      const contentType = String(request.headers["content-type"] ?? "");
      const binary = contentType.startsWith("application/octet-stream");
      const delivered = registry.broadcast(
        channel,
        binary ? body : body.toString("utf8"),
        binary,
      );

      logger.debug({ channel, bytes: body.byteLength, delivered }, "http: posted");
      response.type("text/plain").send("OK!");
    },
  );

  // Everything else is a channel page.
  app.use((request, response, next) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      const url = new URL(request.originalUrl, `http://${config.fqdn}`);
      response.type("text/html").send(await renderChannelPage(url));
    })().catch(next);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((
    error: Error,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error({ err: error.message, stack: error.stack }, "http: unhandled error");
    if (response.headersSent) return;
    response.status(500).type("text/plain").send("internal error");
  });

  return app;
};
