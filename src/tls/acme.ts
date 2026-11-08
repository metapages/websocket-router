import { readFile } from "node:fs/promises";
import type { SecureContextOptions } from "node:tls";

import acme from "acme-client";
import type { Logger } from "pino";

import type { TlsConfig } from "../config.js";
import {
  certificateDomains,
  createCertificateStore,
  daysUntilExpiry,
  type CertificateStore,
} from "./store.js";

/**
 * Certificate lifecycle, using acme-client and the HTTP-01 challenge.
 *
 * The flow, once per boot and then every `checkIntervalMs`:
 *
 *   1. read whatever certificate is on disk;
 *   2. if it is missing, does not cover the configured domains, or expires
 *      within `renewBeforeDays`, order a new one;
 *   3. answer the HTTP-01 challenge from the plain :80 listener, which exists
 *      for exactly this and for redirecting everything else to https;
 *   4. write the result and hand it to the running https server, which swaps
 *      it in with `setSecureContext` — no restart, no dropped connections.
 *
 * Renewal failures are logged and retried on the next tick rather than being
 * fatal: an expiring certificate is still a working certificate, and taking
 * the router down because Let's Encrypt had a bad minute would be worse.
 */

export type ChallengeResponder = {
  /** Token -> key authorization, served at /.well-known/acme-challenge/. */
  readonly tokens: Map<string, string>;
};

export type CertificateManager = {
  /** Current key/cert, or null before the first issuance completes. */
  current: () => SecureContextOptions | null;
  /** Issue or renew if needed. Safe to call repeatedly. */
  ensure: () => Promise<void>;
  readonly challenge: ChallengeResponder;
  readonly store: CertificateStore;
  onRenewal: (handler: (context: SecureContextOptions) => void) => void;
  start: () => void;
  stop: () => void;
};

export const createCertificateManager = (options: {
  readonly tls: TlsConfig;
  readonly dataDir: string;
  readonly logger: Logger;
}): CertificateManager => {
  const { tls, dataDir, logger } = options;
  const store = createCertificateStore(dataDir);
  const challenge: ChallengeResponder = { tokens: new Map() };
  const handlers: ((context: SecureContextOptions) => void)[] = [];

  let context: SecureContextOptions | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const wanted = tls.domains.map((domain) => domain.toLowerCase());

  const needsIssuance = (cert: string | null): string | null => {
    if (!cert) return "no certificate on disk";

    const covered = new Set(certificateDomains(cert));
    const missing = wanted.filter((domain) => !covered.has(domain));
    if (missing.length > 0) {
      return `certificate does not cover ${missing.join(", ")}`;
    }

    const days = daysUntilExpiry(cert);
    if (days === null) return "certificate is unreadable";
    if (days < tls.renewBeforeDays) {
      return `certificate expires in ${days.toFixed(1)} days`;
    }
    return null;
  };

  const loadAccountKey = async (): Promise<Buffer> => {
    const existing = await store.readAccountKey();
    if (existing) return Buffer.from(existing);
    logger.info("acme: creating a new account key");
    const created = await acme.crypto.createPrivateKey();
    await store.writeAccountKey(created.toString());
    return created;
  };

  const issue = async (): Promise<void> => {
    if (tls.caBundleFile) {
      // Pebble and other test CAs are not in the system trust store. This is
      // how the integration suite exercises the real issuance path.
      const bundle = await readFile(tls.caBundleFile, "utf8");
      acme.axios.defaults.httpsAgent = new (await import("node:https")).Agent({
        ca: bundle,
      });
      logger.warn({ caBundleFile: tls.caBundleFile }, "acme: using a custom CA bundle");
    }

    const client = new acme.Client({
      directoryUrl: tls.directoryUrl,
      accountKey: await loadAccountKey(),
    });

    const [key, csr] = await acme.crypto.createCsr({
      commonName: wanted[0] as string,
      ...(wanted.length > 1 ? { altNames: wanted.slice(1) } : {}),
    });

    logger.info({ domains: wanted }, "acme: ordering a certificate");

    const cert = await client.auto({
      csr,
      // Spread rather than assign: with exactOptionalPropertyTypes an
      // explicit `undefined` is not the same as an absent key, and
      // acme-client's types only accept the latter.
      ...(tls.email ? { email: tls.email } : {}),
      termsOfServiceAgreed: true,
      challengePriority: ["http-01"],
      // On by default; see the note on this field in config.ts.
      skipChallengeVerification: tls.skipChallengeVerification,
      challengeCreateFn: async (_authz, challengeInfo, keyAuthorization) => {
        if (challengeInfo.type !== "http-01") {
          throw new Error(`unsupported challenge ${challengeInfo.type}`);
        }
        challenge.tokens.set(challengeInfo.token, keyAuthorization);
        logger.debug({ token: challengeInfo.token }, "acme: challenge armed");
      },
      challengeRemoveFn: async (_authz, challengeInfo) => {
        challenge.tokens.delete(challengeInfo.token);
      },
    });

    await store.writeCertificate({ key: key.toString(), cert: cert.toString() });
    context = { key: key.toString(), cert: cert.toString() };
    for (const handler of handlers) handler(context);
    logger.info(
      { domains: wanted, expiresInDays: daysUntilExpiry(cert.toString())?.toFixed(1) },
      "acme: certificate installed",
    );
  };

  const ensure = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const stored = await store.readCertificate();
      const reason = needsIssuance(stored?.cert ?? null);

      if (reason === null && stored) {
        if (!context) {
          context = { key: stored.key, cert: stored.cert };
          for (const handler of handlers) handler(context);
          logger.info(
            { expiresInDays: daysUntilExpiry(stored.cert)?.toFixed(1) },
            "acme: loaded certificate from disk",
          );
        }
        return;
      }

      logger.info({ reason }, "acme: issuing");
      await issue();
    } catch (error) {
      logger.error(
        { err: (error as Error).message },
        "acme: issuance failed; will retry on the next check",
      );
      // Only rethrow when there is nothing to serve at all — the caller needs
      // to know it cannot bring up an https listener.
      if (!context) throw error;
    } finally {
      running = false;
    }
  };

  return {
    challenge,
    store,
    current: () => context,
    ensure,
    onRenewal: (handler) => {
      handlers.push(handler);
      if (context) handler(context);
    },
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void ensure();
      }, tls.checkIntervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};
