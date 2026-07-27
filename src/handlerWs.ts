import { cryptoRandomString } from "https://deno.land/x/crypto_random_string@1.0.0/mod.ts";

import { SERVER_INSTANCE_ID, SERVER_INSTANCE_ID_LENGTH } from "./id.ts";
import { publishClient, subscribeClient } from "./redis/client.ts";

/**
 * Channel names shorter than this are rejected: the name is the only thing
 * protecting a channel, so it has to be hard enough to guess.
 */
export const MINIMUM_CHANNEL_NAME_LENGTH = 6;

/**
 * Messages beginning with this prefix are keepalives: the server answers them
 * directly and never forwards them to the rest of the channel.
 */
export const PING_PREFIX = "ping";

export const PONG_MESSAGE = "client ping: pong from server";

/**
 * All local sockets listening on one channel, plus the single redis
 * subscription that feeds them messages from the other server instances.
 *
 * There is exactly one subscription per channel per server instance. A
 * per-socket subscription would deliver every remote message once per local
 * socket, so a channel with N local sockets would see N copies of everything.
 */
type Channel = {
  readonly sockets: Set<WebSocket>;
  /** Resolves once this instance is actually subscribed in redis. */
  readonly ready: Promise<unknown>;
  readonly onRedisMessage: (message: string) => void;
};

const channels: Map<string, Channel> = new Map();

const send = (socket: WebSocket, message: string) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(message);
  } catch (err) {
    console.log(`🐋 ws: failed sending to socket: ${err}`);
  }
};

/**
 * Publish onto redis so the other server instances fan the message out to their
 * own listeners. The publishing instance id is prepended so that instance can
 * recognise — and drop — its own echo.
 */
export const publishToRedis = async (channel: string, message: string) => {
  try {
    await publishClient.publish(channel, `${SERVER_INSTANCE_ID}:${message}`);
  } catch (err) {
    console.log(`🌺 💥 redis publish failed on channel=${channel}: ${err}`);
  }
};

const acquireChannel = (name: string, socket: WebSocket): Channel => {
  const existing = channels.get(name);
  if (existing) {
    existing.sockets.add(socket);
    return existing;
  }

  const sockets: Set<WebSocket> = new Set([socket]);

  const onRedisMessage = (message: string) => {
    // Our own publishes come back to us too; everything that is not ours is
    // from another instance, prefixed with that instance's id.
    if (message.startsWith(SERVER_INSTANCE_ID)) {
      return;
    }
    const payload = message.substring(SERVER_INSTANCE_ID_LENGTH + 1);
    for (const listener of sockets) {
      send(listener, payload);
    }
  };

  const channel: Channel = {
    sockets,
    onRedisMessage,
    ready: subscribeClient.subscribe(name, onRedisMessage).catch(
      (err: unknown) => {
        console.log(`🌺 💥 redis subscribe failed on channel=${name}: ${err}`);
      },
    ),
  };
  channels.set(name, channel);
  return channel;
};

const releaseChannel = async (name: string, socket: WebSocket) => {
  const channel = channels.get(name);
  if (!channel) {
    return;
  }
  channel.sockets.delete(socket);
  if (channel.sockets.size > 0) {
    return;
  }
  // Drop it from the map first: a socket arriving during the unsubscribe round
  // trip then builds a fresh channel with its own listener, and redis keeps the
  // subscription alive because a listener is still registered for the name.
  channels.delete(name);
  try {
    await channel.ready;
    await subscribeClient.unsubscribe(name, channel.onRedisMessage);
  } catch (err) {
    console.log(`🌺 💥 redis unsubscribe failed on channel=${name}: ${err}`);
  }
};

/**
 * Send to every listener on a channel, everywhere. Used by the HTTP POST route,
 * which has no socket of its own to exclude.
 */
export const sendToAll = (name: string, message: string) => {
  // Fire and forget: local listeners should not wait on the redis round trip.
  publishToRedis(name, message);

  const channel = channels.get(name);
  if (!channel) {
    return;
  }
  for (const listener of channel.sockets) {
    send(listener, message);
  }
};

export const handleWebsocketConnection = (
  socket: WebSocket,
  request: Request,
) => {
  const urlBlob = new URL(request.url);
  const urlTokens = urlBlob.pathname.split("/");
  const name = urlTokens[urlTokens.length - 1]; // less the initial '/'

  if (name.length < MINIMUM_CHANNEL_NAME_LENGTH) {
    console.log(`🐋 ws: closing, channel name too short: "${name}"`);
    socket.close(1008, "channel name too short");
    return;
  }

  const wsConnectionId = cryptoRandomString({
    length: 4,
    type: "alphanumeric",
  });
  const logPrefix = `🐋 ws-${wsConnectionId}[channel=${name}]:`;

  const channel = acquireChannel(name, socket);
  console.log(`${logPrefix} + (${channel.sockets.size} local)`);

  let closed = false;

  /** Everyone on this channel except whoever sent it. */
  const sendToOthers = (message: string) => {
    // Fire and forget: local listeners should not wait on the redis round trip.
    publishToRedis(name, message);

    for (const listener of channel.sockets) {
      if (listener !== socket) {
        send(listener, message);
      }
    }
  };

  socket.addEventListener("message", ({ data }: { data: unknown }) => {
    if (typeof data !== "string") {
      // Binary frames are not routed: the redis hop carries text only.
      return;
    }
    if (data.startsWith(PING_PREFIX)) {
      send(socket, PONG_MESSAGE);
      return;
    }
    sendToOthers(data);
  });

  const closeAllResources = () => {
    if (closed) {
      return;
    }
    closed = true;
    releaseChannel(name, socket);
    console.log(`${logPrefix} - (${channel.sockets.size} local)`);
  };

  socket.addEventListener("close", closeAllResources);
  socket.addEventListener("error", (event: Event) => {
    console.log(
      `${logPrefix} socket errored: ${(event as ErrorEvent).message}`,
    );
    closeAllResources();
  });
};
