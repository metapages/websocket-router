import { defineConfig } from "vitest/config";

/**
 * The suite is end-to-end: it builds the server, starts real processes and
 * drives them over real sockets. Nothing is mocked, so tests must not run
 * concurrently against each other's ports.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    pool: "forks",
    // One worker, one test file at a time: every test binds real ports and
    // spawns real processes, so parallelism here only buys flakiness.
    maxWorkers: 1,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
