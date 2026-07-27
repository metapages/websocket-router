import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  closeAll,
  type Cluster,
  connectAll,
  delay,
  randomChannel,
  REDIS_URL,
  REPO_ROOT,
  settle,
  startCluster,
  TestClient,
} from "./harness.ts";

/**
 * The whole suite runs inside one test so the cluster is started once. Steps
 * are independent: each uses a fresh random channel, so a failure in one never
 * leaks into another.
 */
Deno.test("websocket router integration", async (t) => {
  const cluster = await startClusterOrExplain();
  const [i0, i1, i2] = cluster.instances;

  const step = (name: string, fn: () => Promise<void>) =>
    t.step({ name, fn, sanitizeOps: false, sanitizeResources: false });

  try {
    // -----------------------------------------------------------------------
    // HTTP surface
    // -----------------------------------------------------------------------

    await step("every instance reports healthy", async () => {
      for (const instance of cluster.instances) {
        const response = await fetch(`${instance.http}/healthcheck`);
        assertEquals(response.status, 200, `instance :${instance.port}`);
        assertEquals(await response.text(), "OK");
      }
    });

    await step("the landing page explains the router", async () => {
      const response = await fetch(`${i0.http}/`);
      assertEquals(response.status, 200);
      assertStringIncludes(
        response.headers.get("content-type") ?? "",
        "text/html",
      );
      const body = await response.text();
      assertStringIncludes(body, "Websocket Router");
      // The core contract has to be stated on the page people land on.
      assertStringIncludes(body, "except the sender");
      // And the docs have to be reachable from it.
      assertStringIncludes(body, "/docs/");
    });

    await step("the docs are served under /docs", async () => {
      const built = await exists(
        `${REPO_ROOT}docs/.vitepress/dist/index.html`,
      );
      if (!built) {
        console.log(
          "  ↳ skipped: docs not built. Run `just docs-build` to cover this.",
        );
        const response = await fetch(`${i0.http}/docs/`);
        assertEquals(response.status, 503);
        await response.body?.cancel();
        return;
      }

      const index = await fetch(`${i0.http}/docs/`);
      assertEquals(index.status, 200);
      assertStringIncludes(await index.text(), "Websocket Router");

      // Bare /docs redirects rather than 404ing.
      const bare = await fetch(`${i0.http}/docs`, { redirect: "manual" });
      assertEquals(bare.status, 302);
      assertEquals(bare.headers.get("location"), "/docs/");
      await bare.body?.cancel();

      // Clean URLs resolve to the built .html file.
      const page = await fetch(`${i0.http}/docs/guide/introduction`);
      assertEquals(page.status, 200);
      assertStringIncludes(await page.text(), "address space");

      const missing = await fetch(`${i0.http}/docs/nope/not-a-page`);
      assertEquals(missing.status, 404);
      await missing.body?.cancel();
    });

    await step("a channel URL serves the channel page", async () => {
      const response = await fetch(`${i0.http}/${randomChannel()}?hidden=true`);
      assertEquals(response.status, 200);
      assertStringIncludes(await response.text(), "<html");
    });

    // -----------------------------------------------------------------------
    // The core contract
    // -----------------------------------------------------------------------

    await step("a message reaches every peer except the sender", async () => {
      const channel = randomChannel();
      const [sender, peer1, peer2] = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "sender@i0" },
        { url: `${i0.ws}/${channel}`, label: "peer1@i0" },
        { url: `${i0.ws}/${channel}`, label: "peer2@i0" },
      ]);
      await settle();

      const message = "hello from the sender";
      sender.send(message);

      await peer1.waitForMessage(message);
      await peer2.waitForMessage(message);
      await settle();

      assertEquals(
        sender.received,
        [],
        "sender must never see its own message",
      );
      assertEquals(peer1.countOf(message), 1);
      assertEquals(peer2.countOf(message), 1);

      await closeAll([sender, peer1, peer2]);
    });

    await step("fan-out crosses server instances", async () => {
      const channel = randomChannel();
      const [a, b, c] = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "a@i0" },
        { url: `${i1.ws}/${channel}`, label: "b@i1" },
        { url: `${i2.ws}/${channel}`, label: "c@i2" },
      ]);
      await settle();

      a.send("from instance 0");
      await b.waitForMessage("from instance 0");
      await c.waitForMessage("from instance 0");

      // And back the other way, to prove it is not one-directional.
      c.send("from instance 2");
      await a.waitForMessage("from instance 2");
      await b.waitForMessage("from instance 2");
      await settle();

      assertEquals(a.received, ["from instance 2"]);
      assertEquals(b.received, ["from instance 0", "from instance 2"]);
      assertEquals(c.received, ["from instance 0"]);

      await closeAll([a, b, c]);
    });

    await step(
      "no duplicates when several sockets share an instance",
      async () => {
        // Regression: one redis subscription per socket meant every remote
        // message was delivered once per local socket on the channel.
        const channel = randomChannel();
        const clients = await connectAll([
          { url: `${i0.ws}/${channel}`, label: "sender@i0" },
          { url: `${i0.ws}/${channel}`, label: "local1@i0" },
          { url: `${i0.ws}/${channel}`, label: "local2@i0" },
          { url: `${i1.ws}/${channel}`, label: "remote1@i1" },
          { url: `${i1.ws}/${channel}`, label: "remote2@i1" },
          { url: `${i1.ws}/${channel}`, label: "remote3@i1" },
          { url: `${i2.ws}/${channel}`, label: "remote4@i2" },
        ]);
        const [sender, ...receivers] = clients;
        await settle();

        const message = "exactly once, please";
        sender.send(message);

        for (const receiver of receivers) {
          await receiver.waitForMessage(message);
        }
        // Give any duplicate every chance to turn up.
        await delay(1_000);

        assertEquals(sender.received, []);
        for (const receiver of receivers) {
          assertEquals(
            receiver.countOf(message),
            1,
            `${receiver.label} received ${receiver.countOf(message)} copies`,
          );
          assertEquals(receiver.received.length, 1, receiver.label);
        }

        await closeAll(clients);
      },
    );

    await step("channels are isolated from each other", async () => {
      const channelA = randomChannel("a");
      const channelB = randomChannel("b");
      const clients = await connectAll([
        { url: `${i0.ws}/${channelA}`, label: "a1@i0" },
        { url: `${i1.ws}/${channelA}`, label: "a2@i1" },
        { url: `${i0.ws}/${channelB}`, label: "b1@i0" },
        { url: `${i2.ws}/${channelB}`, label: "b2@i2" },
      ]);
      const [a1, a2, b1, b2] = clients;
      await settle();

      a1.send("only for channel A");
      b2.send("only for channel B");

      await a2.waitForMessage("only for channel A");
      await b1.waitForMessage("only for channel B");
      await settle();

      assertEquals(a1.received, []);
      assertEquals(a2.received, ["only for channel A"]);
      assertEquals(b1.received, ["only for channel B"]);
      assertEquals(b2.received, []);

      await closeAll(clients);
    });

    await step(
      "leading path segments do not namespace a channel",
      async () => {
        // Documented behaviour: only the last path segment identifies a channel.
        const channel = randomChannel();
        const clients = await connectAll([
          { url: `${i0.ws}/alice/${channel}`, label: "alice@i0" },
          { url: `${i1.ws}/bob/${channel}`, label: "bob@i1" },
        ]);
        const [alice, bob] = clients;
        await settle();

        alice.send("same channel really");
        await bob.waitForMessage("same channel really");

        await closeAll(clients);
      },
    );

    // -----------------------------------------------------------------------
    // HTTP POST broadcast
    // -----------------------------------------------------------------------

    await step(
      "POST reaches every listener, sender excluded by nobody",
      async () => {
        const channel = randomChannel();
        const clients = await connectAll([
          { url: `${i0.ws}/${channel}`, label: "l0@i0" },
          { url: `${i0.ws}/${channel}`, label: "l1@i0" },
          { url: `${i1.ws}/${channel}`, label: "l2@i1" },
          { url: `${i2.ws}/${channel}`, label: "l3@i2" },
        ]);
        await settle();

        const body = JSON.stringify({ temperature: 21.4 });
        // Posted to instance 1, which holds only one of the four listeners.
        const response = await fetch(`${i1.http}/${channel}`, {
          method: "POST",
          body,
        });
        assertEquals(response.status, 200);
        assertEquals(await response.text(), "OK!");

        for (const client of clients) {
          await client.waitForMessage(body);
        }
        await delay(1_000);

        for (const client of clients) {
          assertEquals(client.countOf(body), 1, client.label);
          assertEquals(client.received.length, 1, client.label);
        }

        await closeAll(clients);
      },
    );

    await step("POST to a channel with no listeners is accepted", async () => {
      const response = await fetch(`${i0.http}/${randomChannel()}`, {
        method: "POST",
        body: "into the void",
      });
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "OK!");
    });

    await step("POST bodies are not treated as pings", async () => {
      const channel = randomChannel();
      const [listener] = await connectAll([
        { url: `${i1.ws}/${channel}`, label: "listener@i1" },
      ]);
      await settle();

      await (await fetch(`${i0.http}/${channel}`, {
        method: "POST",
        body: "ping this should still be delivered",
      })).text();

      await listener.waitForMessage("ping this should still be delivered");
      await closeAll([listener]);
    });

    // -----------------------------------------------------------------------
    // Protocol details
    // -----------------------------------------------------------------------

    await step("ping is answered and never forwarded", async () => {
      const channel = randomChannel();
      const clients = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "pinger@i0" },
        { url: `${i0.ws}/${channel}`, label: "local@i0" },
        { url: `${i1.ws}/${channel}`, label: "remote@i1" },
      ]);
      const [pinger, local, remote] = clients;
      await settle();

      pinger.send("ping");
      await pinger.waitForMessage("client ping: pong from server");
      await settle();

      assertEquals(pinger.received, ["client ping: pong from server"]);
      assertEquals(local.received, [], "keepalives must not reach the channel");
      assertEquals(remote.received, []);

      await closeAll(clients);
    });

    await step("payloads are delivered byte for byte", async () => {
      const channel = randomChannel();
      const clients = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "sender@i0" },
        { url: `${i2.ws}/${channel}`, label: "receiver@i2" },
      ]);
      const [sender, receiver] = clients;
      await settle();

      const payloads = [
        JSON.stringify({ nested: { a: [1, 2, 3] }, "key:with:colons": true }),
        'unicode ☃ 🐋 émoji — and a tab\tand a newline\nand a quote " done',
        "",
        "   leading and trailing whitespace   ",
        ":".repeat(64), // the redis prefix separator, repeated
        "x".repeat(100_000), // 100 KB
      ];

      for (const payload of payloads) {
        sender.send(payload);
      }

      await receiver.waitForCount(payloads.length);
      await settle();

      assertEquals(receiver.received, payloads);
      assertEquals(sender.received, []);

      await closeAll(clients);
    });

    await step("binary frames are not routed", async () => {
      const channel = randomChannel();
      const clients = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "sender@i0" },
        { url: `${i1.ws}/${channel}`, label: "receiver@i1" },
      ]);
      const [sender, receiver] = clients;
      await settle();

      // deno-lint-ignore no-explicit-any
      (sender as any).send(new Uint8Array([1, 2, 3, 4]));
      await settle();
      assertEquals(receiver.received, []);

      // ...and the connection still works afterwards.
      sender.send("still here");
      await receiver.waitForMessage("still here");

      await closeAll(clients);
    });

    await step("messages from one sender keep their order", async () => {
      const channel = randomChannel();
      const clients = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "sender@i0" },
        { url: `${i0.ws}/${channel}`, label: "local@i0" },
        { url: `${i1.ws}/${channel}`, label: "remote@i1" },
      ]);
      const [sender, local, remote] = clients;
      await settle();

      const count = 250;
      const expected = Array.from({ length: count }, (_, i) => `msg-${i}`);
      for (const message of expected) {
        sender.send(message);
      }

      await local.waitForCount(count);
      await remote.waitForCount(count);
      await settle();

      assertEquals(local.received, expected, "local delivery order");
      assertEquals(remote.received, expected, "cross-instance delivery order");
      assertEquals(sender.received, []);

      await closeAll(clients);
    });

    await step("concurrent senders all get through", async () => {
      const channel = randomChannel();
      const clients = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "s0@i0" },
        { url: `${i1.ws}/${channel}`, label: "s1@i1" },
        { url: `${i2.ws}/${channel}`, label: "s2@i2" },
        { url: `${i0.ws}/${channel}`, label: "watcher@i0" },
      ]);
      const senders = clients.slice(0, 3);
      const watcher = clients[3];
      await settle();

      const perSender = 40;
      senders.forEach((sender, index) => {
        for (let n = 0; n < perSender; n++) {
          sender.send(`s${index}-${n}`);
        }
      });

      await watcher.waitForCount(senders.length * perSender);
      await settle();

      // Ordering between senders is explicitly not guaranteed, so assert on
      // the set, and on per-sender order within it.
      assertEquals(watcher.received.length, senders.length * perSender);
      senders.forEach((_, index) => {
        const mine = watcher.received.filter((m) => m.startsWith(`s${index}-`));
        assertEquals(
          mine,
          Array.from({ length: perSender }, (_, n) => `s${index}-${n}`),
          `per-sender order for s${index}`,
        );
      });

      await closeAll(clients);
    });

    await step("short channel names are rejected", async () => {
      for (const name of ["a", "abc", "12345"]) {
        const client = new TestClient(`${i0.ws}/${name}`, `short-${name}`);
        const info = await withTimeout(
          client.closed,
          5_000,
          `socket for "${name}" was not closed`,
        );
        assertEquals(info.code, 1008, `close code for "${name}"`);
      }

      // Six characters is the boundary and must be accepted.
      const ok = await TestClient.connect(`${i0.ws}/abcdef`, "boundary");
      await ok.close();
    });

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    await step("a departing client does not disturb the rest", async () => {
      const channel = randomChannel();
      const clients = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "leaver@i0" },
        { url: `${i0.ws}/${channel}`, label: "stayer@i0" },
        { url: `${i1.ws}/${channel}`, label: "remote@i1" },
      ]);
      const [leaver, stayer, remote] = clients;
      await settle();

      await leaver.close();
      await settle();

      remote.send("after the departure");
      await stayer.waitForMessage("after the departure");
      await settle();

      assertEquals(stayer.countOf("after the departure"), 1);
      assertEquals(leaver.received, []);

      await closeAll([stayer, remote]);
    });

    await step("a channel works again after everyone leaves", async () => {
      // Regression: the redis unsubscribe on the last departure must not tear
      // down a subscription that a reconnecting client has just re-created.
      const channel = randomChannel();

      const first = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "first-a@i0" },
        { url: `${i1.ws}/${channel}`, label: "first-b@i1" },
      ]);
      await settle();
      first[0].send("round one");
      await first[1].waitForMessage("round one");
      await closeAll(first);

      // Everyone is gone; the instances have unsubscribed.
      await settle();

      const second = await connectAll([
        { url: `${i0.ws}/${channel}`, label: "second-a@i0" },
        { url: `${i1.ws}/${channel}`, label: "second-b@i1" },
      ]);
      await settle();
      second[0].send("round two");
      await second[1].waitForMessage("round two");
      await settle();

      assertEquals(
        second[1].received,
        ["round two"],
        "no leftovers from round one",
      );

      await closeAll(second);
    });

    await step("rapid reconnects stay consistent", async () => {
      const channel = randomChannel();
      const anchor = await TestClient.connect(
        `${i1.ws}/${channel}`,
        "anchor@i1",
      );
      await settle();

      for (let round = 0; round < 5; round++) {
        const flapper = await TestClient.connect(
          `${i0.ws}/${channel}`,
          `flapper-${round}@i0`,
        );
        await settle();
        flapper.send(`round-${round}`);
        await anchor.waitForMessage(`round-${round}`);
        await flapper.close();
      }
      await settle();

      assertEquals(
        anchor.received,
        Array.from({ length: 5 }, (_, i) => `round-${i}`),
        "each round delivered exactly once",
      );

      await anchor.close();
    });

    await step("many channels stay separate under load", async () => {
      const channelCount = 8;
      const channels = Array.from(
        { length: channelCount },
        (_, i) => randomChannel(`multi${i}`),
      );

      const pairs = await Promise.all(channels.map(async (channel, index) => {
        const [sender, receiver] = await connectAll([
          { url: `${i0.ws}/${channel}`, label: `s${index}@i0` },
          { url: `${i2.ws}/${channel}`, label: `r${index}@i2` },
        ]);
        return { index, sender, receiver };
      }));
      await settle();

      for (const { index, sender } of pairs) {
        for (let n = 0; n < 10; n++) {
          sender.send(`channel-${index}-message-${n}`);
        }
      }

      for (const { index, receiver } of pairs) {
        await receiver.waitForCount(10);
        assertEquals(
          receiver.received,
          Array.from({ length: 10 }, (_, n) => `channel-${index}-message-${n}`),
          `channel ${index} received only its own messages, in order`,
        );
      }
      await settle();

      for (const { sender, receiver } of pairs) {
        assertEquals(sender.received, []);
        assertEquals(receiver.received.length, 10);
      }

      await closeAll(pairs.flatMap((p) => [p.sender, p.receiver]));
    });
  } finally {
    await cluster.stop();
  }
});

// ---------------------------------------------------------------------------

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (_) {
    return false;
  }
};

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);

async function startClusterOrExplain(): Promise<Cluster> {
  try {
    return await startCluster(3);
  } catch (error) {
    throw new Error(
      `Could not start the test cluster against REDIS_URL=${REDIS_URL}.\n` +
        "The integration tests need a running redis; `just test` starts one " +
        "in docker for you.\n\n" + `${error}`,
    );
  }
}
