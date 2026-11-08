#!/usr/bin/env node
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Writes `.br` and `.gz` siblings for every compressible build artifact.
 *
 * Doing this once at build time is what lets the server use brotli quality 11
 * — far too slow to run per request, and typically 15-20% smaller than gzip
 * on this kind of text. `staticAssets.ts` picks whichever variant the client
 * accepts and streams it straight off disk.
 */

const ROOTS = ["dist/web", "public", "docs/.vitepress/dist"];

const COMPRESSIBLE = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt",
  ".map", ".xml", ".webmanifest", ".ics",
]);

// Below this, the compressed file plus its HTTP overhead is not a saving.
const MIN_BYTES = 1024;
// Skip a variant that barely helps; serving it just costs the client a decode.
const MIN_RATIO = 0.95;

const walk = async (directory) => {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
};

const compress = async (source, target, createStream) => {
  await pipeline(createReadStream(source), createStream(), createWriteStream(target));
  return (await stat(target)).size;
};

const main = async () => {
  let files = 0;
  let originalBytes = 0;
  let brotliBytes = 0;

  for (const root of ROOTS) {
    const absolute = resolve(root);
    const candidates = (await walk(absolute)).filter((path) => {
      const extension = extname(path).toLowerCase();
      return COMPRESSIBLE.has(extension) && !path.endsWith(".br") && !path.endsWith(".gz");
    });

    for (const path of candidates) {
      const info = await stat(path);
      if (info.size < MIN_BYTES) continue;

      const brotliSize = await compress(path, `${path}.br`, () =>
        createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: info.size,
          },
        }),
      );
      const gzipSize = await compress(path, `${path}.gz`, () =>
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
      );

      // A variant bigger than ~95% of the original is not worth serving.
      if (brotliSize / info.size > MIN_RATIO) await unlink(`${path}.br`);
      if (gzipSize / info.size > MIN_RATIO) await unlink(`${path}.gz`);

      files += 1;
      originalBytes += info.size;
      brotliBytes += Math.min(brotliSize, info.size);
    }
  }

  const saved = originalBytes > 0
    ? (100 * (1 - brotliBytes / originalBytes)).toFixed(1)
    : "0.0";
  console.log(
    `precompress: ${files} file(s), ${(originalBytes / 1024).toFixed(0)} KiB -> ` +
      `${(brotliBytes / 1024).toFixed(0)} KiB brotli (${saved}% smaller)`,
  );
};

main().catch((error) => {
  console.error("precompress failed:", error);
  process.exit(1);
});
