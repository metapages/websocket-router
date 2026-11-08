import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminClient } from "../helpers/admin.js";
import { TestClient, settle } from "../helpers/client.js";
import { delay, randomChannel, startServer, type TestServer } from "../helpers/server.js";

/**
 * The connection inspector at /<INSPECT_KEY>.
 *
 * Three properties matter more than the page rendering, and each has a test
 * here: the key is undiscoverable (a wrong path is indistinguishable from any
 * other channel), watching a channel does not change it, and an observing
 * socket cannot send.
 */

const KEY = "inspector-key-for-the-test-suite";

type ConnectionInfo = {
  id: string;
  connectedAt: number;
  ip?: string;
  origin?: string;
  userAgent?: string;
  observer: boolean;
};

type ChannelDetail = {
  name: string;
  subscribers: number;
  observers: number;
  since: number;
  connections: ConnectionInfo[];
};

type ChannelsResponse = {
  serverTime: number;
  uptimeSeconds: number;
  truncated: boolean;
  channels: ChannelDetail[];
};

const channels = async (origin: string): Promise<ChannelsResponse> => {
  const response = await fetch(`${origin}/${KEY}/api/channels`);
  expect(response.status).toBe(200);
  return (await response.json()) as ChannelsResponse;
};

const find = (listing: ChannelsResponse, name: string): ChannelDetail | undefined =>
  listing.channels.find((channel) => channel.name === name);

describe("connection inspector", () => {
  describe("when INSPECT_KEY is not set", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer();
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("has no inspector anywhere", async () => {
      // With the feature off, the path has to behave like any other unclaimed
      // path -- a channel page -- rather than 404ing. A 404 would be a signal
      // that something used to be here.
      const page = await fetch(`${server.origin}/${KEY}`);
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).toContain("qrimage");
      expect(body).not.toContain("Connection inspector");

      const api = await fetch(`${server.origin}/${KEY}/api/channels`);
      expect(api.headers.get("content-type")).toContain("text/html");
    });

    it("refuses a socket that asks to observe", async () => {
      const result = await TestClient.connectExpectingFailure(
        `${server.wsOrigin}/${randomChannel()}?observe=${KEY}`,
      );
      expect(result).toMatchObject({ code: 1008 });
    });
  });

  describe("when INSPECT_KEY is unusable", () => {
    let server: TestServer;

    beforeAll(async () => {
      // Too short to be unguessable, and short enough to collide with a real
      // channel name. The router must still come up.
      server = await startServer({ env: { INSPECT_KEY: "short" } });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("stays up, serves no inspector, and says why", async () => {
      const health = await fetch(`${server.origin}/healthcheck`);
      expect(health.status).toBe(200);

      const page = await fetch(`${server.origin}/short`);
      expect(await page.text()).not.toContain("Connection inspector");

      expect(server.logs.join("\n")).toContain("INSPECT_KEY");
      expect(server.logs.join("\n")).toContain("at least 16 characters");
    });
  });

  describe("when INSPECT_KEY is set", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({
        env: { INSPECT_KEY: KEY, ADMIN_PASSWORD: "admin-password-for-tests" },
      });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("serves the inspector page at the secret path", async () => {
      const response = await fetch(`${server.origin}/${KEY}`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Connection inspector");
      expect(body).toContain("noindex");
    });

    it("never lets the page or its API be stored or referred from", async () => {
      // The URL is the credential. A cache that stores it, or a Referer that
      // leaks it, hands it to someone who was never given it.
      for (const path of [`/${KEY}`, `/${KEY}/api/channels`]) {
        const response = await fetch(`${server.origin}${path}`);
        expect(response.headers.get("cache-control"), path).toBe("no-store");
        expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      }
    });

    it("does not reveal itself at any other path", async () => {
      for (const path of [`/${KEY}x`, `/${KEY.slice(0, -1)}`, `/${randomChannel()}`]) {
        const response = await fetch(`${server.origin}${path}`);
        expect(response.status, path).toBe(200);
        expect(await response.text(), path).not.toContain("Connection inspector");
      }
    });

    it("keeps the key out of the channel namespace", async () => {
      // Over HTTP the key is the inspector, so a POST to it is not a
      // broadcast; over websockets it is not a channel either. Both halves
      // matter: a name that means one thing on one protocol and another on
      // the other is the trap `reserved.ts` exists to avoid.
      const posted = await fetch(`${server.origin}/${KEY}`, {
        method: "POST",
        body: "should not be routed",
      });
      expect(posted.status).toBe(404);

      const upgrade = await TestClient.connectExpectingFailure(
        `${server.wsOrigin}/${KEY}`,
      );
      expect(upgrade).toMatchObject({ error: expect.stringContaining("404") });
    });

    it("never writes the key to the logs", async () => {
      // The logs are readable from the admin panel, and the inspector is a
      // strictly greater privilege than the panel: anyone holding this key
      // can read and write every channel in use. So a password in a log file
      // the panel serves would be a way up, not just untidiness.
      await fetch(`${server.origin}/${KEY}`);
      await fetch(`${server.origin}/${KEY}/api/channels`);
      await TestClient.connectExpectingFailure(`${server.wsOrigin}/${KEY}`);

      const observer = await TestClient.connect(
        `${server.wsOrigin}/${randomChannel()}?observe=${KEY}`,
        "observer",
      );
      await settle();
      await observer.close();

      // LOG_LEVEL is debug in this suite, so every line the router can write
      // for these requests has been written by now.
      expect(server.logs.join("\n")).not.toContain(KEY);
    });

    it("lists a connected channel with its connection details", async () => {
      const channel = randomChannel("inspect");
      const client = await TestClient.connect(`${server.wsOrigin}/${channel}`);
      await settle();

      const listing = await channels(server.origin);
      const detail = find(listing, channel);
      expect(detail).toBeDefined();
      expect(detail?.subscribers).toBe(1);
      expect(detail?.observers).toBe(0);
      expect(detail?.connections).toHaveLength(1);

      const connection = detail?.connections[0];
      expect(connection?.id).toMatch(/^[0-9a-f]{6}$/);
      expect(connection?.observer).toBe(false);
      expect(connection?.ip).toBeTruthy();
      // `since` and `connectedAt` are server clock readings, which is why the
      // response carries the server's "now" to compare them against.
      expect(listing.serverTime).toBeGreaterThanOrEqual(detail?.since ?? 0);

      await client.close();
      await settle();
      expect(find(await channels(server.origin), channel)).toBeUndefined();
    });

    it("reports the handshake headers, which is what identifies a client", async () => {
      // This is the whole point of the tool: when something unexpected is
      // connected, these three fields are what say what it is.
      const channel = randomChannel("inspect");
      const client = await TestClient.connect(
        `${server.wsOrigin}/${channel}`,
        "client",
        10_000,
        {
          Origin: "https://app.example.com",
          "User-Agent": "Mozilla/5.0 (pretend browser)",
        },
      );
      await settle();

      const connection = find(await channels(server.origin), channel)
        ?.connections[0];
      expect(connection?.origin).toBe("https://app.example.com");
      expect(connection?.userAgent).toBe("Mozilla/5.0 (pretend browser)");

      await client.close();
    });

    it("counts every real subscriber on a channel", async () => {
      const channel = randomChannel("inspect");
      const clients = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "c"),
      ]);
      await settle();

      const detail = find(await channels(server.origin), channel);
      expect(detail?.subscribers).toBe(3);
      expect(detail?.connections).toHaveLength(3);
      // Oldest first, so the list reads as a history of who arrived.
      const times = (detail?.connections ?? []).map((c) => c.connectedAt);
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      await Promise.all(clients.map((client) => client.close()));
    });
  });

  describe("observing a channel", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ env: { INSPECT_KEY: KEY } });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("receives everything sent on the channel", async () => {
      const channel = randomChannel("observe");
      const observer = await TestClient.connect(
        `${server.wsOrigin}/${channel}?observe=${KEY}`,
        "observer",
      );
      const client = await TestClient.connect(`${server.wsOrigin}/${channel}`, "client");
      await settle();

      client.send("hello from the client");
      client.send(Buffer.from([0, 1, 2, 250]));
      await observer.waitForTotal(2);

      expect(observer.text).toEqual(["hello from the client"]);
      expect(observer.binary).toHaveLength(1);
      expect([...(observer.binary[0] ?? [])]).toEqual([0, 1, 2, 250]);

      await Promise.all([observer.close(), client.close()]);
    });

    it("is invisible in every count, and cannot keep a channel alive", async () => {
      const channel = randomChannel("observe");
      const client = await TestClient.connect(`${server.wsOrigin}/${channel}`, "client");
      const observer = await TestClient.connect(
        `${server.wsOrigin}/${channel}?observe=${KEY}`,
        "observer",
      );
      await settle();

      const detail = find(await channels(server.origin), channel);
      expect(detail?.subscribers).toBe(1);
      expect(detail?.observers).toBe(1);
      expect(detail?.connections).toHaveLength(1);

      // The real client leaves but the observer stays: the channel must stop
      // being listed, or merely looking at a channel would make it appear
      // occupied for as long as anyone watched.
      await client.close();
      await settle();
      expect(find(await channels(server.origin), channel)).toBeUndefined();

      await observer.close();
    });

    it("cannot send anything to the channel", async () => {
      // Enforced on the server, not just omitted from the page: a read-only
      // tool that can write is a tool that can corrupt what it is diagnosing.
      const channel = randomChannel("observe");
      const observer = await TestClient.connect(
        `${server.wsOrigin}/${channel}?observe=${KEY}`,
        "observer",
      );
      const a = await TestClient.connect(`${server.wsOrigin}/${channel}`, "a");
      const b = await TestClient.connect(`${server.wsOrigin}/${channel}`, "b");
      await settle();

      observer.send("injected by the observer");
      observer.send(Buffer.from([9, 9, 9]));
      await settle();

      expect(a.total).toBe(0);
      expect(b.total).toBe(0);

      // And the channel still works for everyone else.
      a.send("still routing");
      await b.waitForTotal(1);
      expect(b.text).toEqual(["still routing"]);

      await Promise.all([observer.close(), a.close(), b.close()]);
    });

    it("still gets a keepalive answered", async () => {
      // An observer has to be able to hold its socket open, so ping is the
      // one thing it may send.
      const channel = randomChannel("observe");
      const observer = await TestClient.connect(
        `${server.wsOrigin}/${channel}?observe=${KEY}`,
        "observer",
      );
      observer.send("ping");
      await observer.waitForTotal(1);
      expect(observer.text[0]).toContain("pong");
      await observer.close();
    });

    it("refuses a wrong key instead of connecting as an ordinary client", async () => {
      const channel = randomChannel("observe");
      const result = await TestClient.connectExpectingFailure(
        `${server.wsOrigin}/${channel}?observe=${KEY}-wrong`,
      );
      expect(result).toMatchObject({ code: 1008 });

      // Silently downgrading to a normal subscription would be worse than
      // refusing: a stale key would turn a read-only socket into one that can
      // write to the channel it meant to watch.
      await delay(50);
      expect(find(await channels(server.origin), channel)).toBeUndefined();
    });

    it("does not appear in the admin panel's numbers either", async () => {
      const admin = await startServer({
        env: { INSPECT_KEY: KEY, ADMIN_PASSWORD: "admin-password-for-tests" },
      });
      try {
        const channel = randomChannel("observe");
        const observer = await TestClient.connect(
          `${admin.wsOrigin}/${channel}?observe=${KEY}`,
          "observer",
        );
        await settle();

        const client = new AdminClient(admin.origin);
        await client.login("admin-password-for-tests");
        const { body } = await client.request("/api/stats");
        const router = body["router"] as { channels: number; connections: number };
        expect(router.connections).toBe(0);
        expect(router.channels).toBe(0);
        expect(body["inspect"]).toEqual({ enabled: true });

        await observer.close();
      } finally {
        await admin.stop();
      }
    });
  });
});
