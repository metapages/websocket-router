import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

import { SESSION_COOKIE, type Config } from "../config.js";

/**
 * Admin authentication: one shared password, exchanged for a signed session
 * cookie.
 *
 * There are no user accounts because there is nothing here to attribute to a
 * person — the panel reads logs and sets one number. What it does need is to
 * be genuinely closed to everyone else, so: constant-time password
 * comparison, an HMAC-signed cookie that carries its own expiry, and a lockout
 * that makes online guessing useless.
 */

const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60_000;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

type Attempts = { count: number; first: number; lockedUntil: number };

export type AdminAuth = {
  /** True if the password matches. Constant time regardless of length. */
  verifyPassword: (candidate: string) => boolean;
  issueSession: (response: Response) => void;
  clearSession: (response: Response) => void;
  hasValidSession: (request: Request) => boolean;
  /** Rejects with 401 unless the request carries a valid session. */
  required: RequestHandler;
  /** Returns remaining lockout ms, or 0 if the caller may try. */
  lockoutRemaining: (key: string) => number;
  recordFailure: (key: string) => void;
  recordSuccess: (key: string) => void;
};

const equals = (a: string, b: string): boolean => {
  // Hash both sides first so the comparison length never depends on the
  // secret, and timingSafeEqual never throws on a length mismatch.
  const key = randomBytes(32);
  const left = createHmac("sha256", key).update(a).digest();
  const right = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(left, right);
};

export const createAdminAuth = (config: Config): AdminAuth => {
  const secret = config.adminSessionSecret;
  const attempts = new Map<string, Attempts>();

  const sign = (payload: string): string =>
    createHmac("sha256", secret).update(payload).digest("base64url");

  const parseCookies = (header: string | undefined): Map<string, string> => {
    const cookies = new Map<string, string>();
    if (!header) return cookies;
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index < 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (name) cookies.set(name, decodeURIComponent(value));
    }
    return cookies;
  };

  const hasValidSession = (request: Request): boolean => {
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (!token) return false;
    const [expiryRaw, nonce, signature] = token.split(".");
    if (!expiryRaw || !nonce || !signature) return false;
    const expiry = Number.parseInt(expiryRaw, 10);
    if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
    return equals(sign(`${expiryRaw}.${nonce}`), signature);
  };

  return {
    verifyPassword: (candidate) =>
      config.adminPassword !== undefined && equals(candidate, config.adminPassword),

    issueSession: (response) => {
      const expiry = Date.now() + config.adminSessionTtlMs;
      const nonce = randomBytes(16).toString("base64url");
      const payload = `${expiry}.${nonce}`;
      const token = `${payload}.${sign(payload)}`;
      response.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        // Over plain HTTP in development the cookie must not be Secure or the
        // browser silently drops it; in production TLS is always on.
        secure: config.tls.enabled,
        path: "/admin",
        maxAge: config.adminSessionTtlMs,
      });
    },

    clearSession: (response) => {
      response.clearCookie(SESSION_COOKIE, { path: "/admin" });
    },

    hasValidSession,

    required: (request, response, next) => {
      if (hasValidSession(request)) return next();
      response.status(401).json({ error: "authentication required" });
    },

    lockoutRemaining: (key) => {
      const record = attempts.get(key);
      if (!record) return 0;
      const remaining = record.lockedUntil - Date.now();
      return remaining > 0 ? remaining : 0;
    },

    recordFailure: (key) => {
      const now = Date.now();
      const record = attempts.get(key);
      if (!record || now - record.first > ATTEMPT_WINDOW_MS) {
        attempts.set(key, { count: 1, first: now, lockedUntil: 0 });
        return;
      }
      record.count += 1;
      if (record.count >= FAILURE_LIMIT) {
        record.lockedUntil = now + LOCKOUT_MS;
        record.count = 0;
        record.first = now;
      }
    },

    recordSuccess: (key) => {
      attempts.delete(key);
    },
  };
};
