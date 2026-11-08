import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starts the real built server as a child process.
 *
 * Nothing is mocked anywhere in this suite. Every test drives a process
 * started exactly the way pm2 starts it in production — `node
 * dist/server/index.js` with an environment — over real sockets. That is the
 * only way the things this rewrite actually changed (TLS, privilege
 * dropping, precompressed assets, process lifecycle) can be tested at all.
 */

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let nextPort = Number.parseInt(process.env["TEST_BASE_PORT"] ?? "34100", 10);
export const allocatePort = (): number => nextPort++;

export type ServerOptions = {
  readonly env?: Record<string, string>;
  /** Defaults to an allocated port. */
  readonly port?: number;
  /** Wait for /healthcheck before resolving. Default true. */
  readonly waitForHealth?: boolean;
};

export type TestServer = {
  readonly port: number;
  readonly origin: string;
  readonly wsOrigin: string;
  readonly dataDir: string;
  readonly logs: string[];
  readonly pid: number | undefined;
  stop: () => Promise<void>;
};

const SHOW_LOGS = process.env["TEST_SERVER_LOGS"] === "1";

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const startServer = async (
  options: ServerOptions = {},
): Promise<TestServer> => {
  const port = options.port ?? allocatePort();
  // A caller that supplies its own DATA_DIR is reusing another server's state
  // on purpose (the restart tests). Only clean up a directory we created, or
  // stopping the second server would delete the first one's data.
  const suppliedDataDir = options.env?.["DATA_DIR"];
  const dataDir = suppliedDataDir ?? (await mkdtemp(join(tmpdir(), "wsr-test-")));
  const ownsDataDir = suppliedDataDir === undefined;
  const logs: string[] = [];

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [join(REPO_ROOT, "dist/server/index.js")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        LOG_LEVEL: "debug",
        APP_FQDN: `localhost:${port}`,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const capture = (stream: NodeJS.ReadableStream, prefix: string) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        logs.push(line);
        if (logs.length > 500) logs.shift();
        if (SHOW_LOGS) console.log(`[:${port} ${prefix}] ${line}`);
      }
    });
  };
  capture(child.stdout, "out");
  capture(child.stderr, "err");

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const origin = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(8000).then(() => {
          child.kill("SIGKILL");
        }),
      ]);
    }
    if (ownsDataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (options.waitForHealth !== false) {
    try {
      await waitForHealth(origin, () => exited, logs);
    } catch (error) {
      await stop();
      throw error;
    }
  }

  return {
    port,
    origin,
    wsOrigin: `ws://127.0.0.1:${port}`,
    dataDir,
    logs,
    pid: child.pid,
    stop,
  };
};

export const waitForHealth = async (
  origin: string,
  hasExited: () => boolean,
  logs: string[],
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error(
        `server exited before becoming healthy\n--- output ---\n${logs.join("\n")}`,
      );
    }
    try {
      const response = await fetch(`${origin}/healthcheck`);
      if (response.status === 200 && (await response.text()) === "OK") return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = String((error as Error).message);
    }
    await delay(150);
  }
  throw new Error(
    `${origin} never became healthy (${lastError})\n--- output ---\n${logs.join("\n")}`,
  );
};

/** A fresh channel name per test, so tests can never collide. */
export const randomChannel = (prefix = "test"): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
