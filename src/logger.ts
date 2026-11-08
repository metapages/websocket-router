import { mkdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";

import type { Config } from "./config.js";

/**
 * Logging has two consumers with different needs:
 *
 *   - operators tailing files on the box, and anything shipping them off it:
 *     newline-delimited JSON, rotated by size with a bounded retention count
 *     so a chatty channel can never fill the disk;
 *   - the admin panel, which wants the last few hundred lines instantly and
 *     must not block on disk.
 *
 * Both are fed from one pino instance: a rotating file destination plus an
 * in-memory ring buffer. The ring is the panel's fast path; the files are the
 * record, and the panel falls back to reading them when asked for more
 * history than the ring holds.
 */

export type LogEntry = {
  readonly time: number;
  readonly level: string;
  readonly msg: string;
  readonly [key: string]: unknown;
};

export type Logs = {
  readonly logger: pino.Logger;
  /** Most recent entries from memory, newest last. */
  recent: (limit: number) => LogEntry[];
  /** Entries read back off disk, newest last. Spans rotated files. */
  fromDisk: (limit: number) => Promise<LogEntry[]>;
  readonly files: () => Promise<{ name: string; size: number }[]>;
  readonly directory: string;
};

const RING_CAPACITY = 2000;

const LEVELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export const createLogs = (config: Config): Logs => {
  mkdirSync(config.logDir, { recursive: true });

  const ring: LogEntry[] = [];
  const push = (entry: LogEntry) => {
    ring.push(entry);
    if (ring.length > RING_CAPACITY) ring.shift();
  };

  /**
   * A pino transport runs in a worker thread and cannot hand objects back, so
   * the ring is filled by a synchronous in-process stream instead. Writes here
   * are pure memory; the disk write is what goes through the transport.
   */
  const ringStream = {
    write: (line: string) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        push({
          time: typeof parsed["time"] === "number" ? parsed["time"] : Date.now(),
          level: LEVELS[parsed["level"] as number] ?? String(parsed["level"]),
          msg: typeof parsed["msg"] === "string" ? parsed["msg"] : "",
          ...parsed,
        });
      } catch {
        // A line pino itself wrote should always parse; if it somehow does
        // not, dropping it from the panel is better than crashing the server.
      }
    },
  };

  const fileTransport = pino.transport({
    target: "pino-roll",
    options: {
      file: join(config.logDir, "router.log"),
      size: config.logMaxSize,
      // Roll daily as well as by size, so a quiet server still produces
      // dated files rather than one that grows for a year.
      frequency: "daily",
      mkdir: true,
      dateFormat: "yyyy-MM-dd",
      limit: {
        // pino-roll's `count` is the number of rotated files kept *in addition
        // to* the active one. LOG_RETAIN_FILES is the total, because that is
        // the number an operator multiplies by LOG_MAX_SIZE to size a disk.
        count: Math.max(1, config.logRetainFiles - 1),
        // Without this, retention only applies to files this process created,
        // so every restart would begin a fresh set and leave the previous
        // one behind forever. A deploy restarts the process, so that is an
        // unbounded disk leak on exactly the schedule we deploy.
        removeOtherLogFiles: true,
      },
      extension: ".log",
    },
  });

  const logger = pino(
    {
      level: config.logLevel,
      base: { pid: process.pid },
      // Milliseconds since the epoch; the panel formats them client-side.
      timestamp: pino.stdTimeFunctions.epochTime,
    },
    pino.multistream([
      { level: config.logLevel, stream: fileTransport },
      { level: config.logLevel, stream: ringStream },
      // stdout is what pm2 captures. Keeping it means `pm2 logs` works
      // normally even though the server also writes its own rotated files.
      { level: config.logLevel, stream: process.stdout },
    ]),
  );

  const logFiles = async () => {
    const names = await readdir(config.logDir).catch(() => [] as string[]);
    const entries = await Promise.all(
      names
        .filter((name) => name.startsWith("router") && name.endsWith(".log"))
        .map(async (name) => {
          const info = await stat(join(config.logDir, name)).catch(() => null);
          return info ? { name, size: info.size, mtime: info.mtimeMs } : null;
        }),
    );
    return entries
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.mtime - b.mtime)
      .map(({ name, size }) => ({ name, size }));
  };

  return {
    logger,
    directory: config.logDir,
    recent: (limit) => ring.slice(Math.max(0, ring.length - limit)),
    files: logFiles,
    fromDisk: async (limit) => {
      const files = await logFiles();
      const collected: LogEntry[] = [];
      // Walk newest file backwards until we have enough lines.
      for (const file of [...files].reverse()) {
        const text = await readFile(join(config.logDir, file.name), "utf8")
          .catch(() => "");
        const parsed = text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              const value = JSON.parse(line) as Record<string, unknown>;
              return {
                time: typeof value["time"] === "number" ? value["time"] : 0,
                level: LEVELS[value["level"] as number] ??
                  String(value["level"]),
                msg: typeof value["msg"] === "string" ? value["msg"] : "",
                ...value,
              } satisfies LogEntry;
            } catch {
              return null;
            }
          })
          .filter((entry): entry is LogEntry => entry !== null);
        collected.unshift(...parsed);
        if (collected.length >= limit) break;
      }
      return collected.slice(Math.max(0, collected.length - limit));
    },
  };
};
