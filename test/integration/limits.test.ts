import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminClient } from "../helpers/admin.js";
import { closeAll, settle, TestClient } from "../helpers/client.js";
import { randomChannel, startServer, type TestServer } from "../helpers/server.js";

const PASSWORD = "limits-test-password";

/**
 * Message size limiting, which the admin panel can change while the server is
 * running. The interesting case is not that a limit exists but that changing
 * it takes effect immediately, on connections that were already open when the
 * change was made.
 */
describe("message size limits", () => {
  let server: TestServer;
  let admin: AdminClient;

  beforeAll(async () => {
    server = await startServer({
      env: {
        ADMIN_PASSWORD: PASSWORD,
        WS_DEFAULT_MAX_MESSAGE_BYTES: "1024",
        WS_HARD_MAX_MESSAGE_BYTES: "65536",
      },
    });
    admin = new AdminClient(server.origin);
    const login = await admin.login(PASSWORD);
    expect(login.status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
  });

  const setLimit = async (bytes: number) => {
    const response = await admin.request("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ maxMessageBytes: bytes }),
    });
    expect(response.status).toBe(200);
    return response;
  };

  it("routes a message at exactly the limit", async () => {
    await setLimit(1024);
    const channel = randomChannel();
    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
    ]);

    const payload = "x".repeat(1024);
    a.send(payload);
    await b.waitForTotal(1);

    expect(b.text[0]).toBe(payload);
    await closeAll([a, b]);
  });

  it("closes a socket that sends one byte over the limit, with code 1009", async () => {
    await setLimit(1024);
    const channel = randomChannel();
    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
    ]);

    a.send("x".repeat(1025));
    const close = await a.closed;

    // 1009 is RFC 6455's "Message Too Big"; clients can act on it without
    // parsing the reason string.
    expect(close.code).toBe(1009);
    expect(close.reason).toContain("1024");

    // The oversize message must not reach anyone.
    await settle();
    expect(b.total).toBe(0);

    await b.close();
  });

  it("applies a limit change to connections that are already open", async () => {
    const channel = randomChannel();
    await setLimit(1024);

    const [a, b] = await Promise.all([
      TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
      TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
    ]);

    // Fine under the current limit.
    a.send("y".repeat(2000 > 1024 ? 1000 : 1000));
    await b.waitForTotal(1);
    b.clear();

    // Raise it, then send something that would have been refused a moment ago.
    await setLimit(8192);
    a.send("z".repeat(4096));
    await b.waitForTotal(1);
    expect(b.text[0]!.length).toBe(4096);

    // Lower it again; the same socket is now subject to the new, smaller one.
    await setLimit(512);
    a.send("w".repeat(1000));
    const close = await a.closed;
    expect(close.code).toBe(1009);

    await b.close();
  });

  it("rejects an oversize POST body with 413", async () => {
    await setLimit(1024);
    const response = await fetch(`${server.origin}/${randomChannel()}`, {
      method: "POST",
      body: "x".repeat(2048),
    });
    expect(response.status).toBe(413);
  });

  it("refuses a limit above the hard ceiling", async () => {
    const response = await admin.request("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ maxMessageBytes: 1024 * 1024 }),
    });
    expect(response.status).toBe(400);
    expect(String(response.body["error"])).toContain("65536");
  });

  it("refuses a limit that is not a positive number", async () => {
    for (const value of [0, -1, "big", null]) {
      const response = await admin.request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ maxMessageBytes: value }),
      });
      expect(response.status, `value ${JSON.stringify(value)}`).toBe(400);
    }
  });

  it("enforces the hard ceiling even when the panel is not involved", async () => {
    // WS_HARD_MAX_MESSAGE_BYTES is given to the websocket library itself, so
    // a frame larger than it is refused before the handler ever sees it —
    // which is what stops a single client from exhausting memory.
    await setLimit(65536);
    const channel = randomChannel();
    const client = await TestClient.connect(`${server.wsOrigin}/${channel}`, "a");

    client.send(Buffer.alloc(65536 + 4096), true);
    const close = await client.closed;
    expect(close.code).toBe(1009);
  });

  it("persists the limit across a restart", async () => {
    await setLimit(4096);

    const restarted = await startServer({
      env: {
        ADMIN_PASSWORD: PASSWORD,
        WS_DEFAULT_MAX_MESSAGE_BYTES: "1024",
        WS_HARD_MAX_MESSAGE_BYTES: "65536",
        DATA_DIR: server.dataDir,
      },
    });

    try {
      const freshAdmin = new AdminClient(restarted.origin);
      await freshAdmin.login(PASSWORD);
      const response = await freshAdmin.request("/api/settings");
      const settings = response.body["settings"] as { maxMessageBytes: number };
      // The default in the environment is still 1024; the stored value wins.
      expect(settings.maxMessageBytes).toBe(4096);
    } finally {
      await restarted.stop();
    }
  });
});
