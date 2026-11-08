import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "pino";
import QRCode from "qrcode";

/**
 * The page served at /<channel-name>.
 *
 * Vite builds `web/channel/index.html` into `dist/web/channel/index.html`
 * with its bundle already linked. The only thing the server injects is the QR
 * code, substituted into a placeholder comment, so there is no template
 * engine in the request path — just one string replace over a cached read.
 */

const PLACEHOLDER = "<!--QRCODE-->";

export type ChannelPageRenderer = (url: URL) => Promise<string>;

export type ChannelPageOptions = {
  readonly webRoot: string;
  readonly fqdn: string;
  /**
   * Re-read the template when it changes on disk, instead of holding the copy
   * read at boot.
   *
   * `just dev` runs `vite build --watch` beside the server, and every rebuild
   * gives the bundle a new content hash. Without this the server would keep
   * serving the boot-time HTML, whose `<script src>` now points at a file
   * that no longer exists — a blank page that looks like a server bug.
   */
  readonly reloadOnChange?: boolean;
  readonly logger?: Logger;
};

export const createChannelPageRenderer = async (
  options: ChannelPageOptions,
): Promise<ChannelPageRenderer> => {
  const file = join(options.webRoot, "channel/index.html");

  // Small LRU-ish cache: the same channel page is often reloaded, and QR
  // generation is the most expensive thing in an otherwise trivial response.
  const cache = new Map<string, string>();
  const CACHE_LIMIT = 256;

  let template = await load(file);

  if (options.reloadOnChange) {
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(file, () => {
      // Vite writes the file in more than one step, so debounce: reading on
      // the first event can see a truncated file.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void load(file)
          .then((next) => {
            template = next;
            // The cached renders embed the old asset hashes.
            cache.clear();
            options.logger?.info("dev: reloaded the channel page template");
          })
          .catch((error: unknown) => {
            options.logger?.warn(
              { err: (error as Error).message },
              "dev: channel page template reload failed; keeping the previous one",
            );
          });
      }, 150);
      timer.unref();
    });
    // Never hold the process open on account of a dev convenience.
    watcher.unref();
  }

  return async (url: URL): Promise<string> => {
    if (url.searchParams.get("hidden") === "true") {
      return template.replace(PLACEHOLDER, "");
    }

    const target = `https://${options.fqdn}${url.pathname}${url.search}`;
    const cached = cache.get(target);
    if (cached !== undefined) return cached;

    const dataUrl = await QRCode.toDataURL(target, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    const rendered = template.replace(
      PLACEHOLDER,
      `<img src="${dataUrl}" alt="QR code for this channel" width="200" height="200">`,
    );

    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(target, rendered);
    return rendered;
  };
};

const load = async (file: string): Promise<string> => {
  const template = await readFile(file, "utf8");
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`channel template is missing the ${PLACEHOLDER} placeholder`);
  }
  return template;
};
