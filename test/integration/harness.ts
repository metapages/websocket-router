import { fromFileUrl } from "jsr:@std/path@1/from-file-url";

/**
 * Test harness for the integration suite.
 *
 * Nothing here is mocked: it starts real `src/serve.ts` processes against a
 * real redis and drives them over real websockets, which is the only way to
 * exercise the cross-instance routing that redis exists for.
 */

export const REPO_ROOT = fromFileUrl(new URL("../../", import.meta.url));

export const REDIS_URL = Deno.env.get("REDIS_URL") ?? "redis://localhost:6379";

const BASE_PORT = parseInt(Deno.env.get("TEST_BASE_PORT") ?? "3100");

/** Set TEST_SERVER_LOGS=1 to see what the servers under test are printing. */
const SHOW_SERVER_LOGS = Deno.env.get("TEST_SERVER_LOGS") === "1";

export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Long enough for a message to have gone client → server → redis → server →
 * client and for any (unwanted) duplicate to have shown up too.
 */
export const SETTLE_MS = 400;

export const settle = () => delay(SETTLE_MS);

// ---------------------------------------------------------------------------
// server instances
// ---------------------------------------------------------------------------

export type Instance = {
  readonly port: number;
  readonly http: string;
  readonly ws: string;
  readonly logs: string[];
  stop: () => Promise<void>;
};

const drain = (
  stream: ReadableStream<Uint8Array>,
  logs: string[],
  prefix: string,
) => {
  const decoder = new TextDecoder();
  return (async () => {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        logs.push(line);
        if (logs.length > 200) logs.shift();
        if (SHOW_SERVER_LOGS) console.log(`${prefix} ${line}`);
      }
    }
  })().catch(() => {
    // the stream dies with the process; nothing to report
  });
};

const waitForHealthy = async (
  http: string,
  logs: string[],
  timeoutMs = 45_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${http}/healthcheck`);
      const body = await response.text();
      if (response.status === 200 && body === "OK") {
        return;
      }
      lastError = `status=${response.status} body=${body}`;
    } catch (error) {
      lastError = `${error}`;
    }
    await delay(200);
  }
  throw new Error(
    `${http} never became healthy (${lastError})\n` +
      `--- server output ---\n${logs.join("\n")}`,
  );
};

const startInstance = async (port: number): Promise<Instance> => {
  const logs: string[] = [];
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--allow-all", "src/serve.ts"],
    cwd: REPO_ROOT,
    env: {
      PORT: String(port),
      REDIS_URL,
      APP_FQDN: `localhost:${port}`,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const drained = Promise.all([
    drain(child.stdout, logs, `[:${port} out]`),
    drain(child.stderr, logs, `[:${port} err]`),
  ]);

  const http = `http://127.0.0.1:${port}`;

  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch (_) {
      // already gone
    }
    await child.status;
    await drained;
  };

  try {
    await waitForHealthy(http, logs);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    port,
    http,
    ws: `ws://127.0.0.1:${port}`,
    logs,
    stop,
  };
};

export type Cluster = {
  readonly instances: Instance[];
  stop: () => Promise<void>;
};

/**
 * Start `count` independent server processes sharing one redis. The first is
 * started alone so that any first-run dependency caching happens once rather
 * than in three processes racing each other over the same directories.
 */
export const startCluster = async (count = 3): Promise<Cluster> => {
  const instances: Instance[] = [await startInstance(BASE_PORT)];
  const rest = await Promise.all(
    Array.from(
      { length: count - 1 },
      (_, index) => startInstance(BASE_PORT + index + 1),
    ),
  );
  instances.push(...rest);

  return {
    instances,
    stop: async () => {
      await Promise.all(instances.map((instance) => instance.stop()));
    },
  };
};

// ---------------------------------------------------------------------------
// websocket clients
// ---------------------------------------------------------------------------

export type CloseInfo = { code: number; reason: string };

/**
 * A websocket that records everything it receives, so tests can assert on
 * exact delivery counts rather than just "did something arrive".
 */
export class TestClient {
  readonly received: string[] = [];
  readonly label: string;
  readonly closed: Promise<CloseInfo>;

  #socket: WebSocket;
  #resolveClosed!: (info: CloseInfo) => void;

  constructor(url: string, label: string) {
    this.label = label;
    this.#socket = new WebSocket(url);
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });

    this.#socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.received.push(event.data);
      }
    });
    this.#socket.addEventListener("close", (event) => {
      this.#resolveClosed({ code: event.code, reason: event.reason });
    });
  }

  static async connect(url: string, label: string, timeoutMs = 10_000) {
    const client = new TestClient(url, label);
    await client.#opened(timeoutMs);
    return client;
  }

  #opened(timeoutMs: number): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.label}: did not open within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.#socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: errored while connecting`));
      }, { once: true });
    });
  }

  send(message: string) {
    this.#socket.send(message);
  }

  /** How many times exactly this message has been received. */
  countOf(message: string): number {
    return this.received.filter((entry) => entry === message).length;
  }

  /** Wait until `predicate` holds for something received, or throw. */
  async waitFor(
    predicate: (message: string) => boolean,
    description: string,
    timeoutMs = 5_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find(predicate);
      if (found !== undefined) return found;
      await delay(20);
    }
    throw new Error(
      `${this.label}: timed out after ${timeoutMs}ms waiting for ${description}. ` +
        `Received ${this.received.length}: ${
          JSON.stringify(this.received.slice(0, 10))
        }`,
    );
  }

  waitForMessage(message: string, timeoutMs = 5_000) {
    return this.waitFor(
      (entry) => entry === message,
      JSON.stringify(message),
      timeoutMs,
    );
  }

  waitForCount(count: number, timeoutMs = 10_000) {
    return this.waitFor(
      () => this.received.length >= count,
      `${count} messages`,
      timeoutMs,
    );
  }

  clear() {
    this.received.length = 0;
  }

  async close() {
    if (
      this.#socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    this.#socket.close();
    await this.closed;
  }
}

export const connectAll = (
  urls: { url: string; label: string }[],
): Promise<TestClient[]> =>
  Promise.all(urls.map(({ url, label }) => TestClient.connect(url, label)));

export const closeAll = async (clients: TestClient[]) => {
  await Promise.all(clients.map((client) => client.close()));
};

/** A fresh channel name per test, so tests never interfere with each other. */
export const randomChannel = (prefix = "test") =>
  `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`;
