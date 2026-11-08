import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Config } from "./config.js";

/**
 * Runtime settings an operator can change from the admin panel without a
 * restart, persisted to a JSON file so they survive one.
 *
 * Deliberately tiny. Anything that cannot be changed safely while the process
 * is serving traffic belongs in the environment (`config.ts`) instead.
 */
export type Settings = {
  /** Largest websocket frame or POST body that will be routed, in bytes. */
  maxMessageBytes: number;
};

export type SettingsStore = {
  get: () => Readonly<Settings>;
  /** Validates, persists, and returns the new settings. Throws on bad input. */
  update: (patch: Partial<Settings>) => Promise<Readonly<Settings>>;
  readonly limits: { readonly maxMessageBytes: { min: number; max: number } };
};

const MIN_MESSAGE_BYTES = 1;

export const createSettingsStore = async (
  config: Config,
): Promise<SettingsStore> => {
  const file = join(config.dataDir, "settings.json");
  const limits = {
    maxMessageBytes: {
      min: MIN_MESSAGE_BYTES,
      // The websocket library refuses anything above this before we see it,
      // so letting the panel set a higher number would be a lie.
      max: config.hardMaxMessageBytes,
    },
  } as const;

  let current: Settings = { maxMessageBytes: config.defaultMaxMessageBytes };

  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Settings>;
    if (typeof parsed.maxMessageBytes === "number") {
      current = { maxMessageBytes: clamp(parsed.maxMessageBytes, limits) };
    }
  } catch (error) {
    // A missing file is the normal first-run case. Anything else is corrupt
    // state we deliberately do not die on: defaults keep the router serving.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`settings: ignoring unreadable ${file}:`, error);
    }
  }

  const persist = async (next: Settings) => {
    await mkdir(dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated file
    // that the next boot would discard.
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, file);
  };

  return {
    limits,
    get: () => current,
    update: async (patch) => {
      const next: Settings = { ...current };
      if (patch.maxMessageBytes !== undefined) {
        next.maxMessageBytes = validate(patch.maxMessageBytes, limits);
      }
      await persist(next);
      current = next;
      return current;
    },
  };
};

const clamp = (
  value: number,
  limits: SettingsStore["limits"],
): number =>
  Math.min(
    Math.max(Math.floor(value), limits.maxMessageBytes.min),
    limits.maxMessageBytes.max,
  );

const validate = (
  value: unknown,
  limits: SettingsStore["limits"],
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("maxMessageBytes must be a number");
  }
  const floored = Math.floor(value);
  const { min, max } = limits.maxMessageBytes;
  if (floored < min || floored > max) {
    throw new Error(`maxMessageBytes must be between ${min} and ${max}`);
  }
  return floored;
};
