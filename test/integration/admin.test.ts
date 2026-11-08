import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminClient } from "../helpers/admin.js";
import { TestClient } from "../helpers/client.js";
import { delay, randomChannel, startServer, type TestServer } from "../helpers/server.js";

const PASSWORD = "correct-horse-battery-staple";

describe("admin panel", () => {
  describe("when no password is configured", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer();
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("does not expose the panel at all", async () => {
      // Not 401, not a default credential: with no ADMIN_PASSWORD the whole
      // subtree must not exist. An unauthenticated 401 would still tell an
      // attacker there is something here to attack.
      const panel = await fetch(`${server.origin}/admin`, { redirect: "manual" });
      expect(panel.status).toBe(404);
      expect(await panel.text()).not.toContain("Router admin");

      for (const path of ["/admin/api/stats", "/admin/api/settings", "/admin/api/logs"]) {
        const response = await fetch(`${server.origin}${path}`);
        expect(response.status, path).toBe(404);
      }
    });

    it("cannot be logged into", async () => {
      const response = await fetch(`${server.origin}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "" }),
      });
      expect(response.status).not.toBe(200);
    });
  });

  describe("when a password is configured", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ env: { ADMIN_PASSWORD: PASSWORD } });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("serves the panel HTML", async () => {
      const response = await fetch(`${server.origin}/admin`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Router admin");
      // The panel must not be indexable even if someone links it.
      expect(body).toContain("noindex");
    });

    it("refuses every API route without a session", async () => {
      for (const path of ["/api/stats", "/api/settings", "/api/logs"]) {
        const response = await fetch(`${server.origin}/admin${path}`);
        expect(response.status, path).toBe(401);
      }
    });

    it("refuses a settings write without a session", async () => {
      const response = await fetch(`${server.origin}/admin/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMessageBytes: 1 }),
      });
      expect(response.status).toBe(401);
    });

    it("rejects the wrong password", async () => {
      const admin = new AdminClient(server.origin);
      const response = await admin.login("not-the-password");
      expect(response.status).toBe(401);
      expect(admin.hasSession).toBe(false);
    });

    it("accepts the right password and issues a session", async () => {
      const admin = new AdminClient(server.origin);
      const login = await admin.login(PASSWORD);
      expect(login.status).toBe(200);

      const session = await admin.request("/api/session");
      expect(session.body["authenticated"]).toBe(true);
    });

    it("sets an httpOnly, same-site session cookie scoped to /admin", async () => {
      const response = await fetch(`${server.origin}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/admin/i);
    });

    it("rejects a forged session cookie", async () => {
      // A valid-looking shape with a bogus signature must not authenticate.
      const forged = `${Date.now() + 60_000}.abcdefgh.notarealsignature`;
      const response = await fetch(`${server.origin}/admin/api/stats`, {
        headers: { Cookie: `wsr_admin=${forged}` },
      });
      expect(response.status).toBe(401);
    });

    it("logs out", async () => {
      const admin = new AdminClient(server.origin);
      await admin.login(PASSWORD);
      await admin.request("/api/logout", { method: "POST" });

      // The cookie the server cleared is replayed by the jar; the server must
      // not honour it.
      const after = await admin.request("/api/session");
      expect(after.body["authenticated"]).toBe(false);
    });

    describe("stats", () => {
      it("reports live channel and connection counts", async () => {
        const admin = new AdminClient(server.origin);
        await admin.login(PASSWORD);

        const channel = randomChannel();
        const clients = await Promise.all([
          TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
          TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
        ]);

        const response = await admin.request("/api/stats");
        const router = response.body["router"] as {
          channels: number;
          connections: number;
          topChannels: { name: string; subscribers: number }[];
        };

        expect(router.connections).toBeGreaterThanOrEqual(2);
        expect(router.topChannels.some((entry) => entry.name === channel)).toBe(true);

        await Promise.all(clients.map((client) => client.close()));
      });

      it("reports the uid the process is running as", async () => {
        const admin = new AdminClient(server.origin);
        await admin.login(PASSWORD);
        const response = await admin.request("/api/stats");
        const user = response.body["user"] as { uid: number | null };

        expect(user).toBeDefined();
        if (process.env["EXPECT_NON_ROOT"] === "1") {
          // Under docker-compose the container runs as a non-root user, and
          // this is the assertion that proves requirement 6 holds at runtime
          // rather than just in the Dockerfile.
          expect(user.uid).not.toBe(0);
          expect(user.uid).toBeGreaterThan(0);
        }
      });
    });

    describe("logs", () => {
      it("returns recent entries from memory", async () => {
        const admin = new AdminClient(server.origin);
        await admin.login(PASSWORD);

        // Generate something distinctive to find.
        const channel = randomChannel("logprobe");
        const client = await TestClient.connect(`${server.wsOrigin}/${channel}`, "a");
        await client.close();

        const response = await admin.request("/api/logs?limit=500&level=all");
        const entries = response.body["entries"] as { msg: string; channel?: string }[];

        expect(Array.isArray(entries)).toBe(true);
        expect(entries.some((entry) => entry.channel === channel)).toBe(true);
      });

      it("reads history back off disk", async () => {
        const admin = new AdminClient(server.origin);
        await admin.login(PASSWORD);

        // pino's rotating file destination runs in a worker thread, so the
        // first file appears a moment after the process is already serving.
        // The panel renders "no log files yet" in the meantime, which is why
        // this polls rather than asserting on the first response.
        let files: { name: string; size: number }[] = [];
        let entries: unknown = [];
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const response = await admin.request(
            "/api/logs?source=disk&limit=50&level=all",
          );
          expect(response.status).toBe(200);
          files = response.body["files"] as { name: string; size: number }[];
          entries = response.body["entries"];
          if (files.length > 0 && (entries as unknown[]).length > 0) break;
          await delay(250);
        }

        expect(Array.isArray(entries)).toBe(true);
        expect((entries as unknown[]).length).toBeGreaterThan(0);
        expect(files.length).toBeGreaterThan(0);
        expect(files[0]!.name).toMatch(/\.log$/);
        expect(files[0]!.size).toBeGreaterThan(0);
      });

      it("filters by level", async () => {
        const admin = new AdminClient(server.origin);
        await admin.login(PASSWORD);

        const response = await admin.request("/api/logs?level=error&limit=500");
        const entries = response.body["entries"] as { level: string }[];
        expect(entries.every((entry) => entry.level === "error")).toBe(true);
      });

      it("caps the number of lines it will return", async () => {
        const admin = new AdminClient(server.origin);
        await admin.login(PASSWORD);
        const response = await admin.request("/api/logs?limit=999999");
        const entries = response.body["entries"] as unknown[];
        expect(entries.length).toBeLessThanOrEqual(2000);
      });
    });
  });

  describe("brute-force protection", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ env: { ADMIN_PASSWORD: PASSWORD } });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("locks out after repeated failures, and the lockout outlasts a correct password", async () => {
      const admin = new AdminClient(server.origin);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await admin.login(`wrong-${attempt}`);
        expect(response.status).toBe(401);
      }

      const locked = await admin.login(PASSWORD);
      expect(locked.status).toBe(429);
      expect(locked.body["retryAfterSeconds"]).toBeGreaterThan(0);
      expect(admin.hasSession).toBe(false);
    });
  });
});
