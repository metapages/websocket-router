import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Router } from "express";

import type { ChannelRegistry } from "../channels.js";

/**
 * The connection inspector, served at `/<INSPECT_KEY>`.
 *
 * Two routes: the page, and a list of what is connected. Nothing here reads
 * or stores message contents — the page watches traffic by subscribing to
 * each channel as a read-only client, over the same websocket API everyone
 * else uses. That is a deliberate division of labour: the server already
 * delivers messages to subscribers perfectly well, so a second mechanism for
 * delivering them to one privileged viewer would be new code able to go wrong
 * in new ways, and would need per-channel buffers the router does not
 * otherwise keep.
 *
 * Mounted only when INSPECT_KEY is set and usable — see `inspect/key.ts`.
 */

export type InspectDeps = {
  readonly registry: ChannelRegistry;
  /** Directory holding the built inspector bundle. */
  readonly webRoot: string;
  readonly startedAt: number;
};

/** A ceiling on the response; a busy router can have more channels than this. */
const MAX_CHANNELS = 200;

export const createInspectRouter = (deps: InspectDeps): Router => {
  const { registry, webRoot, startedAt } = deps;
  const router = Router();

  // The key is in the URL, so every response under it has to say: do not
  // store this, and do not tell anybody where you came from. `no-referrer`
  // is the one that matters -- without it, any link or asset the page
  // acquired later would hand the secret to another origin in a header.
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  router.get("/api/channels", (_request, response) => {
    const channels = registry.list(MAX_CHANNELS);
    response.json({
      // The page renders ages, and a browser clock can be minutes off a
      // server clock. Sending the server's "now" alongside lets it subtract
      // like-for-like instead of showing a connection that started in the
      // future.
      serverTime: Date.now(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      truncated: channels.length === MAX_CHANNELS,
      channels,
    });
  });

  // Read and sent directly rather than through `sendStaticFile`, which sets
  // its own `Cache-Control: no-cache` -- and `no-cache` still permits a
  // shared cache to *store* the page, which is the wrong answer for a URL
  // that is itself the credential. The file is a few kilobytes and this
  // route is opened by hand, so re-reading it per request costs nothing and
  // keeps the page current under `just dev`.
  router.get(/^\/?$/, (_request, response, next) => {
    void (async () => {
      const html = await readFile(join(webRoot, "inspect/index.html"), "utf8")
        .catch(() => null);
      if (html === null) {
        response
          .status(503)
          .type("text/plain")
          .send("Inspector is not built. Run `just build-web`.");
        return;
      }
      response.type("text/html").send(html);
    })().catch(next);
  });

  return router;
};
