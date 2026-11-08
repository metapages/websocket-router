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

/**
 * `extra` carries prefixes that are only reserved in some configurations --
 * currently `/<INSPECT_KEY>`. It has to be part of the same check rather than
 * a separate one for the reason above: the inspector key must mean the same
 * thing to the HTTP stack and to the websocket upgrade handler, or a channel
 * named after the key would exist over one protocol and not the other.
 */
export const isReservedPath = (
  path: string,
  extra: readonly string[] = [],
): boolean =>
  [...RESERVED_PREFIXES, ...extra].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

/** The configuration-dependent reserved prefixes, for the `extra` argument. */
export const dynamicReservedPrefixes = (
  inspectKey: string | undefined,
): string[] => (inspectKey === undefined ? [] : [`/${inspectKey}`]);
