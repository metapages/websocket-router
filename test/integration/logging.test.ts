import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAll, TestClient } from "../helpers/client.js";
import { delay, randomChannel, startServer, type TestServer } from "../helpers/server.js";

/**
 * Logging and rotation.
 *
 * Rotation is the part that matters operationally: on a small VM an unbounded
 * log is the most likely way to run out of disk, and the router is chattiest
 * exactly when something is wrong. These tests drive it with a tiny size
 * threshold so a real roll happens in seconds rather than weeks.
 */
describe("logging", () => {
  describe("structure", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ env: { LOG_LEVEL: "debug" } });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("writes newline-delimited JSON", async () => {
      const channel = randomChannel("jsonprobe");
      const client = await TestClient.connect(`${server.wsOrigin}/${channel}`, "a");
      await client.close();

      const lines = await waitForLogLines(server, (text) => text.includes(channel));
      const parsed = lines
        .filter((line) => line.includes(channel))
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(parsed.length).toBeGreaterThan(0);
      const entry = parsed[0]!;
      // The shape the admin panel and any log shipper both depend on.
      expect(typeof entry["level"]).toBe("number");
      expect(typeof entry["time"]).toBe("number");
      expect(typeof entry["msg"]).toBe("string");
      expect(entry["channel"]).toBe(channel);
      expect(entry["pid"]).toBe(server.pid);
    });

    it("records the uid it is running as at startup", async () => {
      const lines = await waitForLogLines(server, (text) =>
        text.includes("router: ready"),
      );
      const ready = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry["msg"] === "router: ready");

      expect(ready).toBeDefined();
      expect(ready!["uid"]).toBeDefined();
      expect(ready!["node"]).toMatch(/^v\d+\./);
    });

    it("does not log message payloads", async () => {
      // The router moves other people's data. A payload in a log file is a
      // payload on disk, in a log shipper, and in whatever reads it later.
      const channel = randomChannel("secretprobe");
      const secret = "sentinel-payload-do-not-log-4f8a2c";
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);

      a.send(secret);
      await b.waitForTotal(1);
      await delay(500);

      const text = await readAllLogs(server);
      expect(text).not.toContain(secret);
      // The channel name is logged (it is the routing key, and operators need
      // it); the payload is not.
      expect(text).toContain(channel);

      await closeAll([a, b]);
    });

    it("respects the configured level", async () => {
      const quiet = await startServer({ env: { LOG_LEVEL: "warn" } });
      try {
        const channel = randomChannel("quietprobe");
        const client = await TestClient.connect(`${quiet.wsOrigin}/${channel}`, "a");
        await client.close();
        await delay(1000);

        const text = await readAllLogs(quiet);
        // "ws: connected" is logged at info, which is below warn.
        expect(text).not.toContain("ws: connected");
      } finally {
        await quiet.stop();
      }
    });
  });

  describe("rotation", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({
        env: {
          LOG_LEVEL: "debug",
          // Small enough that a few hundred log lines roll the file.
          LOG_MAX_SIZE: "8k",
          LOG_RETAIN_FILES: "3",
        },
      });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("rolls to a new file once the size threshold is passed", async () => {
      await generateLogVolume(server, 200);

      const files = await waitFor(
        () => logFiles(server),
        (found) => found.length >= 2,
        30_000,
      );

      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const name of files) {
        expect(name).toMatch(/\.log$/);
      }
    });

    it("keeps no more than the configured number of files", async () => {
      await generateLogVolume(server, 600);
      await delay(2000);

      const files = await logFiles(server);
      // LOG_RETAIN_FILES=3 means three files in total, so that
      // LOG_RETAIN_FILES x LOG_MAX_SIZE is the disk budget an operator can
      // actually size a volume against. Bounded retention is the whole point:
      // a chatty router must have a ceiling.
      expect(files.length).toBeLessThanOrEqual(3);
    });

    it("does not accumulate files across restarts", async () => {
      // Retention that only covered the current process would leak a whole
      // set of files on every deploy, which is the one schedule guaranteed to
      // repeat. Restart twice over the same directory and check the ceiling
      // still holds.
      const dataDir = server.dataDir;
      for (let round = 0; round < 2; round += 1) {
        const restarted = await startServer({
          env: {
            DATA_DIR: dataDir,
            LOG_LEVEL: "debug",
            LOG_MAX_SIZE: "8k",
            LOG_RETAIN_FILES: "3",
          },
        });
        try {
          await generateLogVolume(restarted, 200);
          await delay(1500);
        } finally {
          await restarted.stop();
        }
      }

      const files = await logFiles(server);
      expect(files.length).toBeLessThanOrEqual(3);
    }, 90_000);

    it("keeps serving while it rotates", async () => {
      const response = await fetch(`${server.origin}/healthcheck`);
      expect(response.status).toBe(200);

      const channel = randomChannel();
      const [a, b] = await Promise.all([
        TestClient.connect(`${server.wsOrigin}/${channel}`, "a"),
        TestClient.connect(`${server.wsOrigin}/${channel}`, "b"),
      ]);
      a.send("still routing");
      await b.waitForTotal(1);
      expect(b.text[0]).toBe("still routing");
      await closeAll([a, b]);
    });

    it("still answers the admin log endpoint after a roll", async () => {
      const admin = await startServer({
        env: {
          ADMIN_PASSWORD: "rotation-test",
          LOG_LEVEL: "debug",
          LOG_MAX_SIZE: "8k",
          LOG_RETAIN_FILES: "3",
        },
      });
      try {
        const { AdminClient } = await import("../helpers/admin.js");
        const client = new AdminClient(admin.origin);
        await client.login("rotation-test");

        await generateLogVolume(admin, 200);
        await delay(2000);

        const response = await client.request("/api/logs?source=disk&limit=100&level=all");
        expect(response.status).toBe(200);
        const files = response.body["files"] as { name: string }[];
        expect(files.length).toBeGreaterThanOrEqual(1);
      } finally {
        await admin.stop();
      }
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const logDir = (server: TestServer): string => join(server.dataDir, "logs");

const logFiles = async (server: TestServer): Promise<string[]> => {
  const names = await readdir(logDir(server)).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".log")).sort();
};

const readAllLogs = async (server: TestServer): Promise<string> => {
  const names = await logFiles(server);
  const parts = await Promise.all(
    names.map((name) => readFile(join(logDir(server), name), "utf8").catch(() => "")),
  );
  return parts.join("\n");
};

const waitFor = async <T>(
  produce: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last = await produce();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await delay(250);
    last = await produce();
  }
  return last;
};

const waitForLogLines = async (
  server: TestServer,
  matches: (text: string) => boolean,
  timeoutMs = 15_000,
): Promise<string[]> => {
  const text = await waitFor(() => readAllLogs(server), matches, timeoutMs);
  return text.split("\n").filter((line) => line.trim().startsWith("{"));
};

/**
 * Produce log volume.
 *
 * POSTs to an empty channel rather than websocket churn: each one is a single
 * `http: posted` debug line for one cheap request, with no handshake, no
 * socket pair and no teardown. An earlier version opened hundreds of real
 * websockets, which was slow enough under docker to make the surrounding
 * tests flaky through sheer resource pressure rather than through anything
 * being wrong.
 */
const generateLogVolume = async (
  server: TestServer,
  lines: number,
): Promise<void> => {
  const channel = randomChannel("volume");
  const batchSize = 50;
  for (let done = 0; done < lines; done += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, lines - done) }, () =>
        fetch(`${server.origin}/${channel}`, {
          method: "POST",
          // Padding, so each line carries predictable weight towards the
          // rotation threshold.
          body: "x".repeat(200),
        }).then((response) => response.text()),
      ),
    );
  }
  // Give the transport worker a moment to flush and roll.
  await delay(1500);
  await stat(logDir(server)).catch(() => null);
};
