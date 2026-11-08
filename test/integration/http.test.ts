import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPO_ROOT, randomChannel, startServer, type TestServer } from "../helpers/server.js";

/** The asset path of the built channel bundle, read out of the built HTML. */
const findBundlePath = async (): Promise<string> => {
  const html = await readFile(
    join(REPO_ROOT, "dist/web/channel/index.html"),
    "utf8",
  );
  const match = /\/_\/assets\/channel-[^"']+\.js/.exec(html);
  if (!match) throw new Error("could not find the channel bundle in the built HTML");
  return match[0];
};

describe("http surface", () => {
  let server: TestServer;
  let bundlePath: string;

  beforeAll(async () => {
    server = await startServer();
    bundlePath = await findBundlePath();
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("resolves its asset root the same way from source and from the build", async () => {
    // Regression: ROOT was `../..` from the config module, which is correct
    // for dist/server/ but one level too far from src/, so `just dev`
    // resolved every asset path to the PARENT of the checkout. Running the
    // source entrypoint is the only thing that catches it.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);

    const read = async (entry: string) => {
      const { stdout } = await run(
        process.execPath,
        ["--import", "tsx", "-e", `import {ROOT} from "${entry}"; console.log(ROOT);`],
        { cwd: REPO_ROOT },
      );
      return stdout.trim();
    };

    const [fromSource, fromBuild] = await Promise.all([
      read("./src/config.ts"),
      read("./dist/server/config.js"),
    ]);

    expect(fromSource).toBe(REPO_ROOT.replace(/\/$/, ""));
    expect(fromBuild).toBe(fromSource);
  });

  it("answers the healthcheck", async () => {
    const response = await fetch(`${server.origin}/healthcheck`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("serves the landing page, which states the one rule", async () => {
    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("Websocket Router");
    // The core contract has to be stated on the page people land on.
    expect(body).toContain("except the sender");
    expect(body).toContain("/docs/");
  });

  it("renders a channel page with a QR code", async () => {
    const response = await fetch(`${server.origin}/${randomChannel()}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("data:image/png;base64");
    expect(body).toContain("qrimage");
  });

  it("omits the QR code when asked to hide it", async () => {
    const response = await fetch(`${server.origin}/${randomChannel()}?hidden=true`);
    const body = await response.text();
    expect(body).not.toContain("data:image/png;base64");
    // The page itself still renders; only the code is gone.
    expect(body).toContain("qrimage");
  });

  it("does not serve documentation in place of a channel page", async () => {
    // The other half of the /docs test: together they prove /docs is a real
    // mount rather than a catch-all swallowing every path.
    const response = await fetch(`${server.origin}/verify-not-a-docs-page`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("qrimage");
  });

  it("allows cross-origin requests from anywhere", async () => {
    // Deliberate: clients are arbitrary third-party pages, which is the whole
    // point of a public address space.
    const response = await fetch(`${server.origin}/healthcheck`, {
      headers: { Origin: "https://example.com" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers a CORS preflight", async () => {
    const response = await fetch(`${server.origin}/${randomChannel()}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("does not advertise the framework", async () => {
    const response = await fetch(`${server.origin}/healthcheck`);
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  describe("compression", () => {
    it("serves brotli when the client accepts it", async () => {
      const response = await fetch(`${server.origin}${bundlePath}`, {
        headers: { "Accept-Encoding": "br" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("br");
      expect(response.headers.get("vary")).toContain("Accept-Encoding");
      // Still decodes to valid JavaScript.
      expect(await response.text()).toContain("function");
    });

    it("prefers brotli over gzip when both are accepted", async () => {
      const response = await fetch(`${server.origin}${bundlePath}`, {
        headers: { "Accept-Encoding": "gzip, deflate, br" },
      });
      expect(response.headers.get("content-encoding")).toBe("br");
    });

    it("falls back to gzip when brotli is not accepted", async () => {
      const response = await fetch(`${server.origin}${bundlePath}`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(response.headers.get("content-encoding")).toBe("gzip");
    });

    it("serves the file uncompressed when nothing is accepted", async () => {
      const response = await fetch(`${server.origin}${bundlePath}`, {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toContain("function");
    });

    it("actually sends fewer bytes when compressed", async () => {
      const [plain, compressed] = await Promise.all([
        fetch(`${server.origin}${bundlePath}`, {
          headers: { "Accept-Encoding": "identity" },
        }),
        fetch(`${server.origin}${bundlePath}`, {
          headers: { "Accept-Encoding": "br" },
        }),
      ]);

      const plainLength = Number(plain.headers.get("content-length"));
      const compressedLength = Number(compressed.headers.get("content-length"));
      expect(compressedLength).toBeGreaterThan(0);
      // Brotli on this bundle should be comfortably under half the size.
      expect(compressedLength).toBeLessThan(plainLength * 0.6);

      await Promise.all([plain.text(), compressed.text()]);
    });

    it("compresses the dynamically rendered channel page", async () => {
      const response = await fetch(`${server.origin}/${randomChannel()}`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(response.headers.get("content-encoding")).toBe("gzip");
    });

    it("keeps the correct content type alongside the encoding", async () => {
      const response = await fetch(`${server.origin}${bundlePath}`, {
        headers: { "Accept-Encoding": "br" },
      });
      // Not application/brotli: the encoding is transport, the type is content.
      expect(response.headers.get("content-type")).toContain("text/javascript");
      await response.text();
    });
  });

  describe("caching", () => {
    it("marks content-hashed assets immutable", async () => {
      const response = await fetch(`${server.origin}${bundlePath}`);
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("cache-control")).toContain("max-age=31536000");
      await response.text();
    });

    it("honours a conditional request", async () => {
      const first = await fetch(`${server.origin}${bundlePath}`);
      const etag = first.headers.get("etag");
      await first.text();
      expect(etag).toBeTruthy();

      const second = await fetch(`${server.origin}${bundlePath}`, {
        headers: { "If-None-Match": etag as string },
      });
      expect(second.status).toBe(304);
    });
  });

  describe("path traversal", () => {
    it("refuses to escape the asset root", async () => {
      for (const path of [
        "/_/../../package.json",
        "/_/..%2f..%2fpackage.json",
        "/_/assets/../../../etc/passwd",
      ]) {
        const response = await fetch(`${server.origin}${path}`, {
          redirect: "manual",
        });
        const body = await response.text();
        expect(body, path).not.toContain("websocket-router");
        expect(body, path).not.toContain("root:");
      }
    });
  });

  describe("documentation", () => {
    it("either serves the docs or explains that they are not built", async () => {
      const response = await fetch(`${server.origin}/docs/`, { redirect: "manual" });
      const body = await response.text();

      if (response.status === 503) {
        // Docs are optional for the integration suite; `just docs-build`
        // covers the other branch.
        expect(body).toContain("Docs not built");
        return;
      }

      expect(response.status).toBe(200);
      // Only the built vitepress site emits this; a generic needle would pass
      // even when /docs was never built at all.
      expect(body).toContain('name="generator" content="VitePress');
    });

    it("redirects bare /docs rather than 404ing", async () => {
      const response = await fetch(`${server.origin}/docs`, { redirect: "manual" });
      // 503 when the docs are absent; the redirect is what matters when present.
      if (response.status === 503) return;
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/docs/");
    });
  });

  describe("reserved paths", () => {
    it("cannot be used as channel names", async () => {
      // Every unmatched path is a channel, so these must be claimed by the
      // router itself — otherwise enabling the admin panel would take a name
      // somebody was already using, and `/admin` would broadcast.
      for (const path of ["/admin", "/docs", "/healthcheck", "/_", "/.well-known"]) {
        const response = await fetch(`${server.origin}${path}`, {
          method: "POST",
          body: "should not be routed",
          redirect: "manual",
        });
        expect(response.status, path).toBe(404);
      }
    });

    it("refuses a websocket upgrade on a reserved path", async () => {
      const { TestClient } = await import("../helpers/client.js");
      const result = await TestClient.connectExpectingFailure(
        `${server.wsOrigin}/healthcheck`,
      );
      // The HTTP and websocket namespaces have to agree: a name that means
      // one thing over HTTP and another over a socket is a trap when the
      // security model is that a channel name is a secret.
      expect(JSON.stringify(result)).toMatch(/404/);
    });
  });

  it("serves legacy /public assets", async () => {
    const response = await fetch(`${server.origin}/favicon.ico`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/x-icon");
  });
});
