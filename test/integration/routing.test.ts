import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAll, settle, TestClient } from "../helpers/client.js";
import { randomChannel, startServer, type TestServer } from "../helpers/server.js";

/**
 * The delivery contract. Everything here used to depend on redis to hold
 * across instances; with one process it is plain in-memory fan-out, and
 * these tests are what prove the rewrite did not quietly change the rules
 * clients already build against.
 */
describe("routing", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("delivers a text message to every peer except the sender", async () => {
    const channel = randomChannel();
    const [a, b, c] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "c"),
    ]);

    a.send("hello everyone");
    await settle();

    expect(b.text).toEqual(["hello everyone"]);
    expect(c.text).toEqual(["hello everyone"]);
    // The one rule: a sender never hears its own message back.
    expect(a.text).toEqual([]);

    await closeAll([a, b, c]);
  });

  it("delivers exactly once, however many peers are on the channel", async () => {
    const channel = randomChannel();
    const clients = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        TestClient.connect(`${server.wsOrigin}/${channel}`, `c${index}`),
      ),
    );

    clients[0]!.send("once");
    await settle();

    for (const client of clients.slice(1)) {
      expect(client.countOfText("once")).toBe(1);
    }
    expect(clients[0]!.total).toBe(0);

    await closeAll(clients);
  });

  it("keeps channels isolated from each other", async () => {
    const [one, two] = [randomChannel("one"), randomChannel("two")];
    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${one}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${two}`, "b"),
    ]);

    a.send("not for you");
    await settle();

    expect(b.total).toBe(0);
    await closeAll([a, b]);
  });

  it("preserves per-sender ordering", async () => {
    const channel = randomChannel();
    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
    ]);

    const sent = Array.from({ length: 50 }, (_, index) => `message-${index}`);
    for (const message of sent) a.send(message);
    await b.waitForTotal(sent.length);

    expect(b.text).toEqual(sent);
    await closeAll([a, b]);
  });

  it("delivers payloads byte for byte", async () => {
    const channel = randomChannel();
    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
    ]);

    // Multibyte, emoji, control characters, quotes and markup: the router
    // must not parse, re-encode or trim any of it.
    const payload = [
      "héllo \u{1F33A} \"quoted\"",
      "\ttabbed <tag>&amp; end",
    ].join("\n");
    a.send(payload);
    await b.waitForTotal(1);

    expect(b.text[0]).toBe(payload);
    await closeAll([a, b]);
  });

  describe("binary frames", () => {
    it("routes a binary frame as binary, excluding the sender", async () => {
      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0xfe]);
      a.send(payload, true);
      await b.waitForTotal(1);

      expect(b.binary).toHaveLength(1);
      expect(b.text).toHaveLength(0);
      expect(b.binary[0]!.equals(payload)).toBe(true);
      expect(a.total).toBe(0);

      await closeAll([a, b]);
    });

    it("round-trips a megabyte of binary data unchanged", async () => {
      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      const payload = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = index % 256;
      }
      a.send(payload, true);
      await b.waitForTotal(1, 15_000);

      expect(b.binary[0]!.length).toBe(payload.length);
      expect(b.binary[0]!.equals(payload)).toBe(true);

      await closeAll([a, b]);
    });

    it("keeps text frames text and binary frames binary", async () => {
      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      a.send("as text", false);
      a.send(Buffer.from("as binary", "utf8"), true);
      await b.waitForTotal(2);

      expect(b.text).toEqual(["as text"]);
      expect(b.binary).toHaveLength(1);
      expect(b.binary[0]!.toString("utf8")).toBe("as binary");

      await closeAll([a, b]);
    });

    it("does not treat a binary frame starting with 'ping' as a keepalive", async () => {
      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      // The ping prefix is a text-frame convention. Binary payloads are
      // opaque bytes and must be routed even when they happen to spell it.
      const payload = Buffer.from("ping-but-binary", "utf8");
      a.send(payload, true);
      await b.waitForTotal(1);

      expect(b.binary[0]!.equals(payload)).toBe(true);
      expect(a.total).toBe(0);

      await closeAll([a, b]);
    });
  });

  describe("keepalives", () => {
    it("answers a ping-prefixed text frame to the sender only", async () => {
      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      a.send("ping from a client");
      await a.waitForTotal(1);
      await settle();

      expect(a.text).toEqual(["client ping: pong from server"]);
      // A keepalive is between one client and the server; peers never see it.
      expect(b.total).toBe(0);

      await closeAll([a, b]);
    });
  });

  describe("channel names", () => {
    it("refuses a name shorter than the minimum", async () => {
      const result = await TestClient.connectExpectingFailure(
        `${server.wsOrigin}/abc`,
      );
      expect(JSON.stringify(result)).toMatch(/400|1008|too short/i);
    });

    it("accepts a name at exactly the minimum length", async () => {
      const client = await TestClient.connect(`${server.wsOrigin}/abcdef`, "min");
      expect(client.total).toBe(0);
      await client.close();
    });
  });

  describe("HTTP POST", () => {
    it("broadcasts to every listener, with no socket to exclude", async () => {
      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      const response = await fetch(`${server.origin}/${channel}`, {
        method: "POST",
        body: '{"temperature": 21.4}',
      });
      expect(response.status).toBe(200);

      await Promise.all([a.waitForTotal(1), b.waitForTotal(1)]);
      expect(a.text).toEqual(['{"temperature": 21.4}']);
      expect(b.text).toEqual(['{"temperature": 21.4}']);

      await closeAll([a, b]);
    });

    it("sends a binary frame when the content type is octet-stream", async () => {
      const channel = randomChannel();
      const client = await TestClient.connect(`${server.wsOrigin}/${channel}`, "a");

      const payload = Buffer.from([1, 2, 3, 250, 251, 252]);
      const response = await fetch(`${server.origin}/${channel}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      });
      expect(response.status).toBe(200);

      await client.waitForTotal(1);
      expect(client.binary).toHaveLength(1);
      expect(client.binary[0]!.equals(payload)).toBe(true);

      await client.close();
    });

    it("accepts a post to a channel with no listeners", async () => {
      const response = await fetch(`${server.origin}/${randomChannel()}`, {
        method: "POST",
        body: "into the void",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK!");
    });
  });

  it("drops a disconnected peer from the channel", async () => {
    const channel = randomChannel();
    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
    ]);

    await b.close();
    await settle();

    // Nothing should throw or hang now that the only peer has gone.
    a.send("anyone there?");
    await settle();
    expect(a.total).toBe(0);

    await a.close();
  });
});
