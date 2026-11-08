import WebSocket from "ws";

import { delay } from "./server.js";

/**
 * A websocket that records everything it receives, separated by frame type,
 * so tests assert on exact delivery counts rather than "did something
 * arrive". Exactly-once delivery and sender exclusion are the two guarantees
 * this router makes; neither can be checked without counting.
 */
export class TestClient {
  readonly text: string[] = [];
  readonly binary: Buffer[] = [];
  readonly label: string;
  readonly closed: Promise<{ code: number; reason: string }>;

  readonly #socket: WebSocket;

  private constructor(socket: WebSocket, label: string) {
    this.#socket = socket;
    this.label = label;

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.binary.push(Buffer.from(data));
      else this.text.push(data.toString("utf8"));
    });

    this.closed = new Promise((resolve) => {
      socket.on("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });
  }

  static async connect(
    url: string,
    label = "client",
    timeoutMs = 10_000,
  ): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket, label);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label}: did not open within ${timeoutMs}ms`)),
        timeoutMs,
      );
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`${label}: ${error.message}`));
      });
    });

    return client;
  }

  /** Resolves with the close frame instead of throwing, for rejection tests. */
  static connectExpectingFailure(
    url: string,
    timeoutMs = 10_000,
  ): Promise<{ code: number; reason: string } | { error: string }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => resolve({ error: "timed out" }), timeoutMs);
      socket.once("close", (code: number, reason: Buffer) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString("utf8") });
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        resolve({ error: error.message });
      });
    });
  }

  send(data: string | Buffer, binary = Buffer.isBuffer(data)): void {
    this.#socket.send(data, { binary });
  }

  get total(): number {
    return this.text.length + this.binary.length;
  }

  countOfText(message: string): number {
    return this.text.filter((entry) => entry === message).length;
  }

  clear(): void {
    this.text.length = 0;
    this.binary.length = 0;
  }

  async waitForTotal(count: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.total >= count) return;
      await delay(20);
    }
    throw new Error(
      `${this.label}: timed out waiting for ${count} messages; ` +
        `got ${this.total} (text=${JSON.stringify(this.text.slice(0, 5))})`,
    );
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    this.#socket.close();
    await this.closed;
  }
}

export const closeAll = async (clients: TestClient[]): Promise<void> => {
  await Promise.all(clients.map((client) => client.close()));
};

/**
 * Long enough for a message to have gone client -> server -> client and for
 * any unwanted duplicate to have shown up too.
 */
export const SETTLE_MS = 250;
export const settle = (): Promise<void> => delay(SETTLE_MS);
