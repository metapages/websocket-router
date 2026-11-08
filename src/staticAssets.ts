import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { Request, RequestHandler, Response } from "express";

/**
 * Static files with precompressed variants.
 *
 * `npm run compress` writes a `.br` and a `.gz` next to every compressible
 * build artifact. This middleware picks the best one the client accepts and
 * streams it directly, so nothing is compressed at request time: brotli at a
 * high quality level is far too slow to do per request, but free when it was
 * done once at build time.
 */

const ENCODINGS = [
  { name: "br", extension: ".br" },
  { name: "gzip", extension: ".gz" },
] as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
};

const acceptedEncodings = (request: Request): Set<string> => {
  const header = request.headers["accept-encoding"];
  if (typeof header !== "string") return new Set();
  return new Set(
    header
      .split(",")
      .map((part) => (part.split(";")[0] ?? "").trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
};

/**
 * Resolve a URL path inside `root`, refusing anything that escapes it.
 * Returns null rather than throwing so callers can fall through to the next
 * route.
 */
export const safeJoin = (root: string, relative: string): string | null => {
  const decoded = (() => {
    try {
      return decodeURIComponent(relative);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes("\0")) return null;

  const target = resolve(join(root, normalize(decoded)));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
};

export type SendFileOptions = {
  /** Seconds for Cache-Control max-age. 0 means must-revalidate. */
  readonly maxAgeSeconds: number;
  /** Content-hashed filenames can be cached forever. */
  readonly immutable?: boolean;
};

/**
 * Stream `absolutePath`, preferring a precompressed sibling. Returns false if
 * the file does not exist, leaving the response untouched.
 */
export const sendStaticFile = async (
  request: Request,
  response: Response,
  absolutePath: string,
  options: SendFileOptions,
): Promise<boolean> => {
  const info = await stat(absolutePath).catch(() => null);
  if (!info || !info.isFile()) return false;

  const accepted = acceptedEncodings(request);
  let filePath = absolutePath;
  let size = info.size;
  let encoding: string | null = null;

  for (const candidate of ENCODINGS) {
    if (!accepted.has(candidate.name)) continue;
    const compressed = `${absolutePath}${candidate.extension}`;
    const compressedInfo = await stat(compressed).catch(() => null);
    if (compressedInfo?.isFile()) {
      filePath = compressed;
      size = compressedInfo.size;
      encoding = candidate.name;
      break;
    }
  }

  response.setHeader("Content-Type", contentTypeFor(absolutePath));
  response.setHeader("Content-Length", String(size));
  // Always vary: the same URL now has up to three distinct representations,
  // and a shared cache that ignores this will hand brotli to a client that
  // cannot read it.
  response.setHeader("Vary", "Accept-Encoding");
  response.setHeader(
    "Cache-Control",
    options.maxAgeSeconds <= 0
      ? "no-cache"
      : `public, max-age=${options.maxAgeSeconds}${options.immutable ? ", immutable" : ""}`,
  );
  // ETag is computed from the *uncompressed* file's identity so it stays
  // stable across encodings, which is what Vary is there to disambiguate.
  response.setHeader("ETag", `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`);
  response.setHeader("Last-Modified", info.mtime.toUTCString());

  if (encoding) {
    response.setHeader("Content-Encoding", encoding);
  }

  if (request.headers["if-none-match"] === response.getHeader("ETag")) {
    response.status(304).end();
    return true;
  }

  if (request.method === "HEAD") {
    response.status(200).end();
    return true;
  }

  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(filePath);
    stream.on("error", rejectStream);
    stream.on("end", resolveStream);
    stream.pipe(response);
  });
  return true;
};

export type StaticMountOptions = {
  readonly root: string;
  /** URL prefix this mount answers for, e.g. "/_/". */
  readonly prefix: string;
  /** Paths under the root matching this are treated as immutable. */
  readonly immutablePattern?: RegExp;
  readonly maxAgeSeconds?: number;
  readonly immutableMaxAgeSeconds?: number;
  /** Tried in order when the exact path misses, e.g. ["index.html"]. */
  readonly indexes?: string[];
};

export const staticMount = (options: StaticMountOptions): RequestHandler => {
  const {
    root,
    prefix,
    immutablePattern,
    maxAgeSeconds = 0,
    immutableMaxAgeSeconds = 31_536_000,
    indexes = [],
  } = options;

  return (request, response, next) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      const path = request.path;
      if (!path.startsWith(prefix)) return next();

      const relative = path.slice(prefix.length);
      const candidates = relative === "" ? indexes : [relative, ...indexes.map((i) => join(relative, i))];

      for (const candidate of candidates) {
        const absolute = safeJoin(root, candidate);
        if (absolute === null) continue;
        const immutable = immutablePattern?.test(candidate) ?? false;
        const sent = await sendStaticFile(request, response, absolute, {
          maxAgeSeconds: immutable ? immutableMaxAgeSeconds : maxAgeSeconds,
          immutable,
        });
        if (sent) return;
      }
      return next();
    })().catch(next);
  };
};
