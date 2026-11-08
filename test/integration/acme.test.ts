import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { delay, REPO_ROOT, startServer, type TestServer } from "../helpers/server.js";

/**
 * Certificate issuance, against a real ACME server.
 *
 * This runs only under docker-compose, where pebble (Let's Encrypt's own test
 * ACME implementation) and challtestsrv are available. Skipping it elsewhere
 * is deliberate: the alternative is mocking acme-client, which would test the
 * mock rather than the HTTP-01 flow, the challenge route, the on-disk key
 * handling and the certificate hot-swap — the four things that can actually
 * break.
 *
 * The flow mirrors production exactly. The only differences are the directory
 * URL, the CA bundle used to trust pebble, and that HTTP-01 is answered on
 * port 5002 rather than 80 because pebble is configured to look there.
 */

const DIRECTORY_URL = process.env["ACME_DIRECTORY_URL"];
const CHALLTESTSRV = process.env["CHALLTESTSRV_URL"];
const PEBBLE_MGMT = process.env["PEBBLE_MGMT_URL"];
const DOMAIN = "router.test";

const describeAcme = DIRECTORY_URL && CHALLTESTSRV && PEBBLE_MGMT
  ? describe
  : describe.skip;

/** The address pebble must resolve `router.test` to: this container. */
const containerAddress = (): string => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("could not determine this container's address");
};

describeAcme("ACME certificate issuance", () => {
  let server: TestServer;
  let caBundle: string;
  let httpsOrigin: string;
  let agent: Agent;

  beforeAll(async () => {
    caBundle = await readFile(
      join(REPO_ROOT, "test/fixtures/pebble.minica.pem"),
      "utf8",
    );

    // Point challtestsrv's wildcard DNS at this container, so pebble's
    // validation of router.test reaches the server we are about to start.
    const response = await fetch(`${CHALLTESTSRV}/set-default-ipv4`, {
      method: "POST",
      body: JSON.stringify({ ip: containerAddress() }),
    });
    expect(response.status).toBe(200);

    const httpPort = 5002; // must match `httpPort` in pebble-config.json
    const httpsPort = 5443;

    server = await startServer({
      port: httpsPort,
      waitForHealth: false,
      env: {
        TLS_ENABLED: "true",
        TLS_DOMAINS: DOMAIN,
        TLS_EMAIL: "router@example.test",
        HTTP_PORT: String(httpPort),
        ACME_DIRECTORY_URL: DIRECTORY_URL as string,
        ACME_CA_BUNDLE_FILE: join(REPO_ROOT, "test/fixtures/pebble.minica.pem"),
        // pebble validates on port 5002, but acme-client's own pre-flight
        // check always uses port 80, so it can never succeed here. Production
        // leaves this off and keeps the pre-flight. See config.ts.
        ACME_SKIP_CHALLENGE_VERIFICATION: "true",
        APP_FQDN: DOMAIN,
        ADMIN_PASSWORD: "acme-test-password",
      },
    });

    httpsOrigin = `https://${DOMAIN}:${httpsPort}`;

    // The root that signs ISSUED certificates, which pebble generates fresh
    // on every start. `caBundle` (pebble.minica.pem) only signs pebble's own
    // listener, so it is what we trust to fetch this — not what verifies the
    // router's certificate. See test/fixtures/README.md.
    const issuingRoot = await undiciFetch(`${PEBBLE_MGMT}/roots/0`, {
      dispatcher: new Agent({ connect: { ca: caBundle } }),
    }).then((response) => response.text());
    expect(issuingRoot).toContain("BEGIN CERTIFICATE");

    // Trust that root and nothing else. `router.test` resolves to loopback
    // via the compose service's extra_hosts, so this connects by name and
    // therefore checks SNI and hostname verification against the real issued
    // certificate rather than skipping both.
    agent = new Agent({ connect: { ca: issuingRoot } });

    // Issuance has to complete before the https listener comes up at all.
    const deadline = Date.now() + 60_000;
    let lastError = "no attempt made";
    while (Date.now() < deadline) {
      try {
        const health = await undiciFetch(`${httpsOrigin}/healthcheck`, {
          dispatcher: agent,
        });
        if (health.status === 200) return;
        lastError = `status ${health.status}`;
      } catch (error) {
        lastError = `${(error as Error).message}` +
          ((error as { cause?: Error }).cause
            ? ` (cause: ${(error as { cause?: Error }).cause?.message})`
            : "");
      }
      await delay(500);
    }
    throw new Error(
      `https never came up: ${lastError}\n` +
        `--- server output ---\n${server.logs.join("\n")}`,
    );
  }, 150_000);

  afterAll(async () => {
    await agent?.close();
    await server?.stop();
  });

  it("obtains a certificate and serves https with it", async () => {
    const response = await undiciFetch(`${httpsOrigin}/healthcheck`, {
      dispatcher: agent,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("writes the account key and certificate to disk with tight permissions", async () => {
    const { stat } = await import("node:fs/promises");
    const acmeDir = join(server.dataDir, "acme");

    const accountKey = await stat(join(acmeDir, "account.key"));
    const certKey = await stat(join(acmeDir, "certificate.key"));
    const cert = await stat(join(acmeDir, "certificate.crt"));

    expect(accountKey.size).toBeGreaterThan(0);
    expect(cert.size).toBeGreaterThan(0);
    // Private keys must not be readable by anyone but the service user.
    expect(accountKey.mode & 0o077).toBe(0);
    expect(certKey.mode & 0o077).toBe(0);
  });

  it("issues a certificate that actually covers the configured domain", async () => {
    const { X509Certificate } = await import("node:crypto");
    const pem = await readFile(
      join(server.dataDir, "acme", "certificate.crt"),
      "utf8",
    );
    const certificate = new X509Certificate(pem);

    expect(certificate.subjectAltName).toContain(`DNS:${DOMAIN}`);
    // Pebble issues short-lived certificates, but they must still be valid now.
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
    expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now());
  });

  it("serves the ACME challenge path over plain HTTP without redirecting", async () => {
    // A redirect here would break renewal: the validation server follows
    // redirects only within limits, and this path must answer directly.
    const response = await fetch(
      "http://127.0.0.1:5002/.well-known/acme-challenge/not-a-real-token",
      { redirect: "manual" },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("redirects everything else on the plain listener to https", async () => {
    const response = await fetch("http://127.0.0.1:5002/some-channel-name", {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      `https://${DOMAIN}/some-channel-name`,
    );
  });

  it("serves no content at all over plaintext", async () => {
    // The regression this pins: the plain listener used to be the whole
    // application with a redirect appended, and the channel-page catch-all
    // claimed every request before the redirect could run — so the entire
    // site, admin panel included, was reachable unencrypted on port 80.
    for (const path of ["/", "/a-channel-name", "/admin", "/docs/", "/healthcheck"]) {
      const response = await fetch(`http://127.0.0.1:5002${path}`, {
        redirect: "manual",
      });
      expect(response.status, path).toBe(301);
      expect(response.headers.get("location"), path).toMatch(/^https:\/\//);
      const body = await response.text();
      expect(body, path).not.toContain("qrimage");
      expect(body, path).not.toContain("Router admin");
    }
  });

  it("preserves a covered host when redirecting", async () => {
    const response = await fetch("http://127.0.0.1:5002/x", {
      headers: { Host: DOMAIN },
      redirect: "manual",
    });
    expect(response.headers.get("location")).toBe(`https://${DOMAIN}/x`);
  });

  it("redirects an unrecognised host to the canonical name", async () => {
    // A host the certificate does not cover must not be echoed back into the
    // redirect; that would be an open redirect driven by the Host header.
    const response = await fetch("http://127.0.0.1:5002/x", {
      headers: { Host: "evil.example.com" },
      redirect: "manual",
    });
    expect(response.headers.get("location")).toBe(`https://${DOMAIN}/x`);
  });

  it("routes websockets over wss", async () => {
    // The whole point of the service, over the TLS listener it will actually
    // be used through.
    const { WebSocket } = await import("ws");
    const issuingRoot = await undiciFetch(`${PEBBLE_MGMT}/roots/0`, {
      dispatcher: new Agent({
        connect: { ca: caBundle },
      }),
    }).then((response) => response.text());

    const connect = (label: string) =>
      new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const socket = new WebSocket(`wss://${DOMAIN}:5443/acme-wss-channel`, {
          ca: issuingRoot,
        });
        const timer = setTimeout(
          () => reject(new Error(`${label}: timed out`)),
          15_000,
        );
        socket.on("open", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.on("error", (error: Error) => {
          clearTimeout(timer);
          reject(new Error(`${label}: ${error.message}`));
        });
      });

    const [a, b] = await Promise.all([connect("a"), connect("b")]);
    try {
      const received: string[] = [];
      b.on("message", (data: Buffer) => received.push(data.toString("utf8")));

      a.send("over tls");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && received.length === 0) {
        await delay(50);
      }
      expect(received).toEqual(["over tls"]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("reuses the certificate on restart instead of ordering a new one", async () => {
    const original = await readFile(
      join(server.dataDir, "acme", "certificate.crt"),
      "utf8",
    );

    const restarted = await startServer({
      port: 5444,
      waitForHealth: false,
      env: {
        TLS_ENABLED: "true",
        TLS_DOMAINS: DOMAIN,
        HTTP_PORT: "5003",
        ACME_DIRECTORY_URL: DIRECTORY_URL as string,
        ACME_CA_BUNDLE_FILE: join(REPO_ROOT, "test/fixtures/pebble.minica.pem"),
        ACME_SKIP_CHALLENGE_VERIFICATION: "true",
        APP_FQDN: DOMAIN,
        DATA_DIR: server.dataDir,
      },
    });

    try {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        ready = restarted.logs.some((line) => line.includes("https: listening"));
        await delay(250);
      }
      expect(ready, restarted.logs.join("\n")).toBe(true);

      // The stored certificate is still valid, so it must be loaded rather
      // than reissued — otherwise every restart would burn rate limit.
      expect(
        restarted.logs.some((line) => line.includes("loaded certificate from disk")),
      ).toBe(true);
      expect(
        await readFile(join(server.dataDir, "acme", "certificate.crt"), "utf8"),
      ).toBe(original);
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  it("secures the admin panel cookie when TLS is on", async () => {
    const response = await undiciFetch(`${httpsOrigin}/admin/api/login`, {
      dispatcher: agent,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "acme-test-password" }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/Secure/i);
  });
});
