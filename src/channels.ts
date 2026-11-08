/**
 * The router itself: a name, and the set of sockets currently listening to it.
 *
 * This is the whole of the application state. The previous version kept the
 * same structure but also mirrored every message through redis pub/sub, so
 * that several stateless instances behind a load balancer could reach each
 * other. One process needs no bus, and dropping it makes the delivery
 * contract strictly stronger: there is no cross-instance ordering gap, no
 * window where redis is down and peers silently stop hearing each other, and
 * no instance-id prefix to strip off every payload.
 *
 * The cost is that a deployment is one process. Two hosts are two independent
 * routers, not one router with two halves.
 */

/**
 * What is known about one websocket, captured at the handshake.
 *
 * All of it comes from the upgrade request, so it costs nothing to keep and
 * nothing is sampled from the traffic itself: this is the answer to "what is
 * connected to this channel", not "what is it saying". Message contents are
 * never retained anywhere on the server — the inspector reads those by
 * subscribing like any other client.
 */
export type ConnectionInfo = {
  /** Short random id, the same one that appears in the logs. */
  readonly id: string;
  readonly connectedAt: number;
  readonly ip: string | undefined;
  /** `Origin` header: which page opened the socket. */
  readonly origin: string | undefined;
  readonly userAgent: string | undefined;
  /**
   * An inspector socket. It receives traffic, may not send any, and is left
   * out of every count so that watching a channel cannot change what the
   * channel appears to be doing.
   */
  readonly observer: boolean;
};

export type Subscriber = {
  /** Deliver one message. Implementations must not throw. */
  readonly deliver: (data: string | Buffer, binary: boolean) => void;
  /** Present for a websocket. Absent for a POST, which has no socket. */
  readonly info?: ConnectionInfo;
};

export type ChannelStats = {
  readonly name: string;
  readonly subscribers: number;
};

/** One channel as the inspector sees it. */
export type ChannelDetail = {
  readonly name: string;
  /** Real subscribers, observers excluded. */
  readonly subscribers: number;
  readonly observers: number;
  /** When the oldest connection on this channel arrived. */
  readonly since: number;
  readonly connections: ConnectionInfo[];
};

export type RouterStats = {
  readonly channels: number;
  readonly connections: number;
  readonly messagesRouted: number;
  readonly bytesRouted: number;
  readonly topChannels: ChannelStats[];
};

export class ChannelRegistry {
  readonly #channels = new Map<string, Set<Subscriber>>();
  #messagesRouted = 0;
  #bytesRouted = 0;

  /** Add a subscriber, creating the channel if this is the first one. */
  join(name: string, subscriber: Subscriber): void {
    const existing = this.#channels.get(name);
    if (existing) {
      existing.add(subscriber);
      return;
    }
    this.#channels.set(name, new Set([subscriber]));
  }

  /** Remove a subscriber, dropping the channel once it is empty. */
  leave(name: string, subscriber: Subscriber): void {
    const subscribers = this.#channels.get(name);
    if (!subscribers) return;
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      this.#channels.delete(name);
    }
  }

  /**
   * Real subscribers on the channel, observers excluded.
   *
   * Excluding them is what makes the inspector safe to leave open: were they
   * counted, every channel would gain a subscriber the moment someone opened
   * the inspector, and a channel whose last real client had gone would still
   * read as occupied for as long as anyone was watching it.
   */
  size(name: string): number {
    const subscribers = this.#channels.get(name);
    if (!subscribers) return 0;
    let count = 0;
    for (const subscriber of subscribers) {
      if (subscriber.info?.observer !== true) count += 1;
    }
    return count;
  }

  /**
   * Send to every subscriber on the channel except `except`.
   *
   * `except` is the sending socket, which is how sender exclusion is enforced
   * — by socket identity, never by anything in the payload. Pass `undefined`
   * for POST, which has no socket of its own and therefore reaches everyone.
   *
   * Returns how many subscribers received it.
   */
  broadcast(
    name: string,
    data: string | Buffer,
    binary: boolean,
    except?: Subscriber,
  ): number {
    const subscribers = this.#channels.get(name);
    if (!subscribers) return 0;

    let delivered = 0;
    // Iterating the live Set is safe here: `deliver` only ever queues a write,
    // and a socket closing during the loop removes itself on a later tick.
    for (const subscriber of subscribers) {
      if (subscriber === except) continue;
      subscriber.deliver(data, binary);
      delivered += 1;
    }

    if (delivered > 0) {
      this.#messagesRouted += 1;
      this.#bytesRouted += byteLength(data) * delivered;
    }
    return delivered;
  }

  stats(topN = 10): RouterStats {
    let connections = 0;
    const channels: ChannelStats[] = [];
    for (const name of this.#channels.keys()) {
      // Observer-only channels are not channels anyone is using; they exist
      // because something is being watched, and reporting them would mean the
      // act of looking changed the numbers.
      const subscribers = this.size(name);
      if (subscribers === 0) continue;
      connections += subscribers;
      channels.push({ name, subscribers });
    }
    channels.sort((a, b) => b.subscribers - a.subscribers);
    return {
      channels: channels.length,
      connections,
      messagesRouted: this.#messagesRouted,
      bytesRouted: this.#bytesRouted,
      topChannels: channels.slice(0, topN),
    };
  }

  /**
   * Every channel with at least one real subscriber, busiest first.
   *
   * This is the inspector's only server-side read. It returns who is
   * connected and since when; it does not return, or keep, anything that was
   * sent. `limit` is a ceiling on the response, not on the router.
   */
  list(limit = 200): ChannelDetail[] {
    const details: ChannelDetail[] = [];

    for (const [name, subscribers] of this.#channels) {
      let real = 0;
      let observers = 0;
      let since = Number.POSITIVE_INFINITY;
      const connections: ConnectionInfo[] = [];

      for (const subscriber of subscribers) {
        const info = subscriber.info;
        if (info === undefined) continue;
        if (info.observer) {
          observers += 1;
          continue;
        }
        real += 1;
        connections.push(info);
        if (info.connectedAt < since) since = info.connectedAt;
      }

      if (real === 0) continue;
      connections.sort((a, b) => a.connectedAt - b.connectedAt);
      details.push({
        name,
        subscribers: real,
        observers,
        since: Number.isFinite(since) ? since : Date.now(),
        connections,
      });
    }

    details.sort((a, b) =>
      b.subscribers - a.subscribers || a.since - b.since
    );
    return details.slice(0, limit);
  }
}

export const byteLength = (data: string | Buffer): number =>
  typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
