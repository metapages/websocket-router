/**
 * Path prefixes the router owns, and which therefore cannot be channels.
 *
 * The channel namespace is "every path that is not something else", so this
 * list is the complete set of exceptions. It is shared by the HTTP stack and
 * the websocket upgrade handler on purpose: the security model is that a
 * channel name is a secret, and a name that means one thing over HTTP and
 * another over a websocket is a trap.
 *
 * Reserved unconditionally, including when the admin panel is disabled, so
 * that enabling it never takes a name somebody was already using.
 */
export const RESERVED_PREFIXES = [
  "/admin",
  "/_",
  "/.well-known",
  "/healthcheck",
  "/docs",
] as const;

export const isReservedPath = (path: string): boolean =>
  RESERVED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
