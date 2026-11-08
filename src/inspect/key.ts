import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The inspector's credential.
 *
 * There is no login and no cookie: the secret *is* the path. `/<key>` serves
 * the inspector, and anyone who does not know the key sees what every other
 * unclaimed path serves — an ordinary channel page. That is the whole point:
 * a wrong guess is indistinguishable from any other channel name, so the
 * route cannot be found by probing, and there is no login form to attack.
 *
 * What it costs is that the key travels in URLs, which is why the inspector's
 * responses are `no-store` and `no-referrer`: a URL is the one credential
 * browsers put in the address bar, the history, and the `Referer` header.
 *
 * It is deliberately a different secret from ADMIN_PASSWORD. The panel reads
 * logs and writes settings; the inspector only watches traffic, and wanting
 * to hand someone the second is not a reason to hand them the first.
 */

/**
 * Short enough to type, long enough that guessing is hopeless.
 *
 * 16 characters of the allowed alphabet is ~95 bits. The floor matters more
 * than it looks: an 8-character key would be a *plausible channel name*, and
 * then anyone who happened to pick it as a channel would be served the
 * inspector instead of their own page.
 */
export const INSPECT_KEY_MIN_LENGTH = 16;

/** One path segment, and safe to drop into an express route unescaped. */
const ALLOWED = /^[A-Za-z0-9_-]+$/;

/**
 * Returns why this key cannot be used, or null if it is fine.
 *
 * A rejected key disables the inspector rather than failing the boot. The
 * router's job is to route; refusing to serve traffic because a diagnostic
 * tool was misconfigured would be a worse outcome than the tool being absent,
 * and the reason is logged at error level either way.
 */
export const inspectKeyProblem = (key: string): string | null => {
  if (key.length < INSPECT_KEY_MIN_LENGTH) {
    return `INSPECT_KEY must be at least ${INSPECT_KEY_MIN_LENGTH} characters`;
  }
  if (!ALLOWED.test(key)) {
    return "INSPECT_KEY must contain only A-Z, a-z, 0-9, hyphen and underscore";
  }
  return null;
};

/**
 * Constant-time string comparison.
 *
 * Both sides are HMACed under a per-call random key first, so the comparison
 * length never depends on the secret and `timingSafeEqual` cannot throw on a
 * length mismatch. Same construction as the admin password check.
 */
export const secretEquals = (a: string, b: string): boolean => {
  const key = randomBytes(32);
  const left = createHmac("sha256", key).update(a).digest();
  const right = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(left, right);
};
