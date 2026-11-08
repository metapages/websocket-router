import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { ChannelRegistry } from "./channels.js";
import { createAdminAuth } from "./admin/auth.js";
import { createChannelPageRenderer } from "./channelPage.js";
import { loadConfig, ROOT } from "./config.js";
import { createHttpApp, createRedirectApp } from "./httpApp.js";
import { createLogs } from "./logger.js";
import { isReservedPath } from "./reserved.js";
import { createSettingsStore } from "./settings.js";
import { createCertificateManager } from "./tls/acme.js";
import { channelNameFromUrl, createWebSocketServer } from "./wsServer.js";

/**
 * Entrypoint. Wires everything together and owns the listeners.
 *
 * With TLS off there is one plain HTTP listener on PORT. With TLS on there
 * are two: an https listener on PORT serving everything, and a plain
 * listener on HTTP_PORT that answers ACME challenges and 301s the rest.
 */

const startedAt = Date.now();

const main = async (): Promise<void> => {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });

  const logs = createLogs(config);
  const logger = logs.logger;

  const webRoot = join(ROOT, "dist/web");
  const docsRoot = join(ROOT, "docs/.vitepress/dist");
  const publicRoot = join(ROOT, "public");
  const docsBuilt = existsSync(join(docsRoot, "index.html"));

  if (!existsSync(join(webRoot, "channel/index.html"))) {
    throw new Error(
      `Browser bundles are missing from ${webRoot}.\n` +
        `  Build them with:  just build-web\n` +
        `  Or run:           just dev    (builds and watches them for you)`,
    );
  }
  if (!docsBuilt) {
    logger.warn({ docsRoot }, "docs are not built; /docs will explain how");
  }

  const registry = new ChannelRegistry();
  const settings = await createSettingsStore(config);
  const auth = createAdminAuth(config);
  const renderChannelPage = await createChannelPageRenderer({
    webRoot,
    fqdn: config.fqdn,
    // Under `just dev` the bundle is rebuilt beside the running server and
    // its content hash changes each time; see ChannelPageOptions.
    reloadOnChange: !config.isProduction,
    logger,
  });

  const certificates = config.tls.enabled
    ? createCertificateManager({
        tls: config.tls,
        dataDir: config.dataDir,
        logger,
      })
    : null;

  const app = createHttpApp({
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
    ...(certificates ? { challenge: certificates.challenge } : {}),
  });

  const wss = createWebSocketServer({ config, registry, settings, logger });

  /**
   * Upgrade handling is attached manually rather than by handing `ws` the
   * server, so a request for a channel name that is too short is refused at
   * the HTTP layer instead of being accepted and then immediately closed.
   */
  const attachUpgrade = (server: Server) => {
    server.on("upgrade", (request, socket: Duplex, head) => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (isReservedPath(path)) {
        logger.debug({ path }, "upgrade: refused, reserved path");
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const name = channelNameFromUrl(request.url);
      if (name.length < config.minimumChannelNameLength) {
        logger.debug({ channel: name }, "upgrade: refused, channel name too short");
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (socket_) => {
        wss.emit("connection", socket_, request);
      });
    });
  };

  const servers: Server[] = [];

  if (certificates) {
    // The plain listener has to be up first: it is what answers the HTTP-01
    // challenge that the certificate request below depends on. It serves
    // nothing else — see createRedirectApp.
    const plain = createHttpServer(
      createRedirectApp({
        challenge: certificates.challenge,
        domains: config.tls.domains,
        fqdn: config.fqdn,
        logger,
      }),
    );
    await listen(plain, config.httpPort, config.host);
    servers.push(plain);
    logger.info({ port: config.httpPort }, "http: listening (ACME + redirect)");

    await certificates.ensure();
    const context = certificates.current();
    if (!context) throw new Error("no certificate available; cannot start https");

    const secure = createHttpsServer(context, app);
    certificates.onRenewal((next) => {
      secure.setSecureContext(next);
      logger.info("https: swapped in the renewed certificate");
    });
    certificates.start();

    attachUpgrade(secure);
    await listen(secure, config.port, config.host);
    servers.push(secure);
    logger.info(
      { port: config.port, domains: config.tls.domains },
      "https: listening",
    );
  } else {
    const plain = createHttpServer(app);
    attachUpgrade(plain);
    await listen(plain, config.port, config.host);
    servers.push(plain);
    logger.info({ port: config.port, fqdn: config.fqdn }, "http: listening");
  }

  logger.info(
    {
      uid: process.getuid?.() ?? null,
      gid: process.getgid?.() ?? null,
      node: process.version,
      dataDir: config.dataDir,
      maxMessageBytes: settings.get().maxMessageBytes,
    },
    "router: ready",
  );

  // ------------------------------------------------------------------
  // shutdown
  // ------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "router: shutting down");

    certificates?.stop();
    for (const client of wss.clients) {
      // 1001 "going away" tells well-behaved clients this was intentional, so
      // they reconnect immediately rather than backing off as if the network
      // had failed.
      client.close(1001, "server shutting down");
    }
    wss.close();

    const closing = servers.map(
      (server) => new Promise<void>((done) => server.close(() => done())),
    );
    void Promise.all(closing).then(() => process.exit(0));

    // pm2 sends SIGINT and waits; do not make it wait forever on a socket
    // that refuses to drain.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: String(reason) }, "router: unhandled rejection");
  });
};

const listen = (server: Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

main().catch((error: unknown) => {
  console.error("router: failed to start:", error);
  process.exit(1);
});
