import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";

import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";

import { byteLength, type ChannelRegistry, type Subscriber } from "./channels.js";
import type { Config } from "./config.js";
import type { SettingsStore } from "./settings.js";

/**
 * Messages beginning with this prefix are keepalives: the server answers them
 * directly and never forwards them. Text frames only — a binary frame that
 * happens to start with these bytes is payload, not a keepalive.
 */
export const PING_PREFIX = "ping";
export const PONG_MESSAGE = "client ping: pong from server";

/** Close codes, from RFC 6455 §7.4.1. */
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_MESSAGE_TOO_BIG = 1009;

/**
 * Once a socket has this much unflushed data queued, further messages to it
 * are dropped rather than buffered.
 *
 * Delivery is best-effort by design, and with one process there is no second
 * instance to absorb the overflow: a single client that stops reading would
 * otherwise grow the heap until the box dies. Dropping for that one socket
 * keeps every other client on the channel unaffected.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export type WsDeps = {
  readonly config: Config;
  readonly registry: ChannelRegistry;
  readonly settings: SettingsStore;
  readonly logger: Logger;
};

/** `/some-channel` -> `some-channel`; also tolerates a trailing slash. */
export const channelNameFromUrl = (url: string | undefined): string => {
  const path = (url ?? "/").split("?")[0] ?? "/";
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "" : decodeURIComponent(segments[segments.length - 1] ?? "");
};

export const createWebSocketServer = (deps: WsDeps): WebSocketServer => {
  const { config, registry, settings, logger } = deps;

  const wss = new WebSocketServer({
    noServer: true,
    // Hard ceiling enforced inside the library: a frame larger than this is
    // rejected before it is ever assembled in memory. The admin-configurable
    // limit is checked below and can only be lower.
    maxPayload: config.hardMaxMessageBytes,
    // Permessage-deflate is deliberately off. It costs CPU and memory per
    // connection, and this router mostly moves small frames that do not
    // compress enough to pay for it.
    perMessageDeflate: false,
  });

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const name = channelNameFromUrl(request.url);

    if (name.length < config.minimumChannelNameLength) {
      logger.debug({ channel: name }, "ws: rejected, channel name too short");
      socket.close(CLOSE_POLICY_VIOLATION, "channel name too short");
      return;
    }

    const id = randomBytes(3).toString("hex");

    const subscriber: Subscriber = {
      deliver: (data, binary) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          logger.warn(
            { channel: name, socket: id, buffered: socket.bufferedAmount },
            "ws: dropping message, subscriber is not draining",
          );
          return;
        }
        socket.send(data, { binary }, (error) => {
          if (error) {
            logger.debug(
              { channel: name, socket: id, err: error.message },
              "ws: send failed",
            );
          }
        });
      },
    };

    registry.join(name, subscriber);
    logger.info(
      { channel: name, socket: id, subscribers: registry.size(name) },
      "ws: connected",
    );

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // `ws` hands fragmented messages back as an array of chunks.
      const data: Buffer = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw);

      const limit = settings.get().maxMessageBytes;
      if (data.byteLength > limit) {
        logger.warn(
          { channel: name, socket: id, bytes: data.byteLength, limit },
          "ws: closing, message exceeds the configured limit",
        );
        socket.close(
          CLOSE_MESSAGE_TOO_BIG,
          `message exceeds ${limit} bytes`,
        );
        return;
      }

      if (!isBinary) {
        const text = data.toString("utf8");
        if (text.startsWith(PING_PREFIX)) {
          subscriber.deliver(PONG_MESSAGE, false);
          return;
        }
        // Text frames stay text on the wire out, so a browser client receives
        // a string rather than a Blob.
        registry.broadcast(name, text, false, subscriber);
        return;
      }

      registry.broadcast(name, data, true, subscriber);
    });

    const disconnect = () => {
      registry.leave(name, subscriber);
      logger.info(
        { channel: name, socket: id, subscribers: registry.size(name) },
        "ws: disconnected",
      );
    };

    socket.on("close", disconnect);
    socket.on("error", (error: Error) => {
      logger.debug({ channel: name, socket: id, err: error.message }, "ws: error");
      // `ws` always emits 'close' after 'error', so cleanup is not duplicated
      // here; the handler above is the single place a subscriber is removed.
    });
  });

  return wss;
};

export { byteLength };
