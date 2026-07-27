import { createClient } from "redis";

const url = Deno.env.get("REDIS_URL");

if (!url) {
  throw new Error("🌺 💥 No REDIS_URL environment variable found");
}

const hostname = new URL(url).hostname;

/**
 * Redis requires a dedicated connection for subscriptions — a client in
 * subscriber mode cannot issue ordinary commands — so publishing and
 * subscribing get one client each.
 */
const create = (label: string) => {
  const client = createClient({ url });
  // node-redis emits `error` on every reconnection attempt. Nothing here is
  // fatal: with redis down, each instance still routes between its own local
  // sockets, so log and let the client keep retrying.
  client
    .on("error", (err: Error) => console.log(`🌺 💥 Redis ${label} error`, err))
    .on(
      "connect",
      () => console.log(`🌺 ...Redis ${label} connecting to ${hostname}`),
    )
    .on(
      "reconnecting",
      () => console.log(`🌺 ...Redis ${label} RE-connecting to ${hostname}`),
    )
    .on("ready", () => console.log(`🌺 ✅ Redis ${label} ready`));
  return client;
};

export const publishClient = create("publishClient");
await publishClient.connect();

export const subscribeClient = create("subscribeClient");
await subscribeClient.connect();
