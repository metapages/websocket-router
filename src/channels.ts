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

export type Subscriber = {
  /** Deliver one message. Implementations must not throw. */
  readonly deliver: (data: string | Buffer, binary: boolean) => void;
};

export type ChannelStats = {
  readonly name: string;
  readonly subscribers: number;
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

  size(name: string): number {
    return this.#channels.get(name)?.size ?? 0;
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
    for (const [name, subscribers] of this.#channels) {
      connections += subscribers.size;
      channels.push({ name, subscribers: subscribers.size });
    }
    channels.sort((a, b) => b.subscribers - a.subscribers);
    return {
      channels: this.#channels.size,
      connections,
      messagesRouted: this.#messagesRouted,
      bytesRouted: this.#bytesRouted,
      topChannels: channels.slice(0, topN),
    };
  }
}

export const byteLength = (data: string | Buffer): number =>
  typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
