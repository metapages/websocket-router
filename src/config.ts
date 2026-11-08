import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boot-time configuration, all from the environment.
 *
 * Anything here is fixed for the life of the process. Values an operator can
 * change while the server is running live in `settings.ts` instead, which is
 * what the admin panel writes to.
 */

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The directory holding `package.json`, `dist/`, `public/` and `docs/`.
 *
 * Found by walking up from this module rather than from `process.cwd()`,
 * because pm2 and systemd do not agree on what the working directory should
 * be and neither is reliably the install root.
 *
 * Walking up to a marker file rather than counting directories is deliberate:
 * this file sits at `src/config.ts` when run from source under tsx and at
 * `dist/server/config.js` when run from the build, which are *different*
 * depths. A fixed `../..` is correct for one and silently resolves to the
 * parent of the checkout for the other.
 */
const findRoot = (start: string): string => {
  const { root: filesystemRoot } = parse(start);
  let current = start;
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    if (current === filesystemRoot) {
      // Nothing to do but guess, and the build layout is the one that runs in
      // production. A missing asset directory is reported clearly at startup.
      return resolve(start, "../..");
    }
    current = dirname(current);
  }
};

export const ROOT = findRoot(SERVER_DIR);

const str = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

const optional = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return value;
};

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const list = (name: string): string[] =>
  str(name, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export type TlsConfig = {
  readonly enabled: boolean;
  /** Domains to request a certificate for. The first is the common name. */
  readonly domains: string[];
  /** Contact address Let's Encrypt uses for expiry warnings. */
  readonly email: string | undefined;
  /** ACME directory URL. Defaults to Let's Encrypt production. */
  readonly directoryUrl: string;
  /** Renew once the certificate has fewer than this many days left. */
  readonly renewBeforeDays: number;
  /** How often to re-check expiry. */
  readonly checkIntervalMs: number;
  /** Trust this CA bundle instead of the system store (pebble, in tests). */
  readonly caBundleFile: string | undefined;
  /**
   * Skip acme-client's own pre-flight fetch of the challenge URL.
   *
   * That pre-flight is worth having in production: it catches a closed port 80
   * or a DNS record pointing at the wrong host *before* the order is submitted,
   * which is the difference between a clear local error and a consumed
   * Let's Encrypt failure allowance. Leave it on.
   *
   * It only exists as a switch because the integration suite runs pebble with
   * `httpPort: 5002`, so the self-check — which always uses port 80 — cannot
   * succeed there even though the real validation does.
   */
  readonly skipChallengeVerification: boolean;
};

export type Config = {
  /**
   * False under `just dev`. Enables conveniences that must never run in
   * production — currently re-reading the channel page template when
   * `vite build --watch` rewrites it.
   */
  readonly isProduction: boolean;
  readonly port: number;
  /** The :80 listener. Serves ACME challenges and redirects to https. */
  readonly httpPort: number;
  readonly host: string;
  /** Hostname baked into channel QR codes. */
  readonly fqdn: string;
  /** Writable state: settings file, certificates, logs. */
  readonly dataDir: string;
  readonly logDir: string;
  readonly logLevel: string;
  /** Keep this many rotated log files per stream. */
  readonly logRetainFiles: number;
  /** Rotate once a log file passes this size. */
  readonly logMaxSize: string;
  readonly minimumChannelNameLength: number;
  /**
   * Hard ceiling enforced by the websocket library itself, before a frame is
   * ever buffered. The admin-configurable limit lives under this and cannot
   * exceed it.
   */
  readonly hardMaxMessageBytes: number;
  readonly defaultMaxMessageBytes: number;
  readonly adminEnabled: boolean;
  readonly adminPassword: string | undefined;
  readonly adminSessionSecret: string;
  readonly adminSessionTtlMs: number;
  readonly trustProxy: boolean;
  readonly tls: TlsConfig;
};

export const loadConfig = (): Config => {
  const dataDir = resolve(str("DATA_DIR", `${ROOT}/data`));
  const adminPassword = optional("ADMIN_PASSWORD");

  const hardMaxMessageBytes = int("WS_HARD_MAX_MESSAGE_BYTES", 16 * 1024 * 1024);
  const defaultMaxMessageBytes = Math.min(
    int("WS_DEFAULT_MAX_MESSAGE_BYTES", 1024 * 1024),
    hardMaxMessageBytes,
  );

  const tlsEnabled = bool("TLS_ENABLED", false);
  const domains = list("TLS_DOMAINS");
  if (tlsEnabled && domains.length === 0) {
    throw new Error("TLS_ENABLED is set but TLS_DOMAINS is empty");
  }

  return {
    isProduction: str("NODE_ENV", "development") === "production",
    port: int("PORT", tlsEnabled ? 443 : 3077),
    httpPort: int("HTTP_PORT", 80),
    host: str("HOST", "0.0.0.0"),
    fqdn: str("APP_FQDN", domains[0] ?? `localhost:${int("PORT", 3077)}`),
    dataDir,
    logDir: resolve(str("LOG_DIR", `${dataDir}/logs`)),
    logLevel: str("LOG_LEVEL", "info"),
    logRetainFiles: int("LOG_RETAIN_FILES", 10),
    logMaxSize: str("LOG_MAX_SIZE", "20m"),
    minimumChannelNameLength: int("MINIMUM_CHANNEL_NAME_LENGTH", 6),
    hardMaxMessageBytes,
    defaultMaxMessageBytes,
    // The panel is off unless a password is set. An admin panel that anyone
    // can open is worse than no admin panel, so this must never default on.
    adminEnabled: adminPassword !== undefined && bool("ADMIN_ENABLED", true),
    adminPassword,
    // Generated when unset, which is fine but logs every operator out on
    // restart. Set it in the environment to keep sessions across deploys.
    adminSessionSecret: str("ADMIN_SESSION_SECRET", randomBytes(32).toString("hex")),
    adminSessionTtlMs: int("ADMIN_SESSION_TTL_MINUTES", 12 * 60) * 60_000,
    trustProxy: bool("TRUST_PROXY", false),
    tls: {
      enabled: tlsEnabled,
      domains,
      email: optional("TLS_EMAIL"),
      directoryUrl: str(
        "ACME_DIRECTORY_URL",
        "https://acme-v02.api.letsencrypt.org/directory",
      ),
      renewBeforeDays: int("TLS_RENEW_BEFORE_DAYS", 30),
      checkIntervalMs: int("TLS_CHECK_INTERVAL_MINUTES", 12 * 60) * 60_000,
      caBundleFile: optional("ACME_CA_BUNDLE_FILE"),
      skipChallengeVerification: bool("ACME_SKIP_CHALLENGE_VERIFICATION", false),
    },
  };
};

export const SESSION_COOKIE = "wsr_admin";
