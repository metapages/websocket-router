import { Router, type Request } from "express";

import type { ChannelRegistry } from "../channels.js";
import type { Config } from "../config.js";
import type { Logs } from "../logger.js";
import type { SettingsStore } from "../settings.js";
import { safeJoin, sendStaticFile } from "../staticAssets.js";
import type { AdminAuth } from "./auth.js";

/**
 * The admin API, plus the single-page panel that drives it.
 *
 * Mounted only when ADMIN_PASSWORD is set — see `config.adminEnabled`. With
 * no password the whole subtree does not exist, rather than existing with a
 * default credential.
 */

export type AdminDeps = {
  readonly config: Config;
  readonly auth: AdminAuth;
  readonly settings: SettingsStore;
  readonly registry: ChannelRegistry;
  readonly logs: Logs;
  /** Directory holding the built admin bundle. */
  readonly webRoot: string;
  readonly startedAt: number;
};

const clientKey = (request: Request): string => request.ip ?? "unknown";

export const createAdminRouter = (deps: AdminDeps): Router => {
  const { config, auth, settings, registry, logs, webRoot, startedAt } = deps;
  const router = Router();

  // ---------------------------------------------------------------------
  // session
  // ---------------------------------------------------------------------

  router.post("/api/login", (request, response) => {
    const key = clientKey(request);
    const locked = auth.lockoutRemaining(key);
    if (locked > 0) {
      response.status(429).json({
        error: "too many attempts",
        retryAfterSeconds: Math.ceil(locked / 1000),
      });
      return;
    }

    const password = (request.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== "string" || !auth.verifyPassword(password)) {
      auth.recordFailure(key);
      logs.logger.warn({ ip: key }, "admin: failed login");
      response.status(401).json({ error: "invalid password" });
      return;
    }

    auth.recordSuccess(key);
    auth.issueSession(response);
    logs.logger.info({ ip: key }, "admin: logged in");
    response.json({ ok: true });
  });

  router.post("/api/logout", (_request, response) => {
    auth.clearSession(response);
    response.json({ ok: true });
  });

  router.get("/api/session", (request, response) => {
    response.json({ authenticated: auth.hasValidSession(request) });
  });

  // ---------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------

  router.get("/api/settings", auth.required, (_request, response) => {
    response.json({ settings: settings.get(), limits: settings.limits });
  });

  router.put("/api/settings", auth.required, (request, response) => {
    void (async () => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const next = await settings.update({
          ...(body["maxMessageBytes"] !== undefined
            ? { maxMessageBytes: body["maxMessageBytes"] as number }
            : {}),
        });
        logs.logger.info({ settings: next }, "admin: settings updated");
        response.json({ settings: next, limits: settings.limits });
      } catch (error) {
        response.status(400).json({ error: (error as Error).message });
      }
    })();
  });

  // ---------------------------------------------------------------------
  // observability
  // ---------------------------------------------------------------------

  router.get("/api/stats", auth.required, (_request, response) => {
    const memory = process.memoryUsage();
    response.json({
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      router: registry.stats(),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
      node: process.version,
      pid: process.pid,
      // Proof that requirement 6 actually holds in production, visible
      // without shelling into the box.
      user: { uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null },
      tls: { enabled: config.tls.enabled, domains: config.tls.domains },
      // Whether the inspector is on, never where it is. This exists so an
      // operator can tell that a deployed INSPECT_KEY actually arrived --
      // without it the only signal is a secret URL either working or 404ing,
      // and a 404 looks identical to a typo in the key you are holding.
      inspect: { enabled: config.inspectKey !== undefined },
    });
  });

  router.get("/api/logs", auth.required, (request, response) => {
    void (async () => {
      const limitRaw = Number.parseInt(String(request.query["limit"] ?? "200"), 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 2000);
      const source = request.query["source"] === "disk" ? "disk" : "memory";
      const entries = source === "disk"
        ? await logs.fromDisk(limit)
        : logs.recent(limit);
      const level = typeof request.query["level"] === "string" ? request.query["level"] : null;
      const filtered = level && level !== "all"
        ? entries.filter((entry) => entry.level === level)
        : entries;
      response.json({ source, entries: filtered, files: await logs.files() });
    })();
  });

  // ---------------------------------------------------------------------
  // the panel itself
  // ---------------------------------------------------------------------

  router.get(/^\/?$/, (request, response, next) => {
    void (async () => {
      const file = safeJoin(webRoot, "admin/index.html");
      if (file === null) return next();
      const sent = await sendStaticFile(request, response, file, { maxAgeSeconds: 0 });
      if (!sent) {
        response
          .status(503)
          .type("text/plain")
          .send("Admin panel is not built. Run `npm run build`.");
      }
    })().catch(next);
  });

  return router;
};
