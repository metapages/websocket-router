/**
 * Post-deploy smoke test: prove that a real deployment still routes messages.
 *
 * Run by `just verify-production` (and therefore by `just deploy`). This is
 * deliberately tiny and dependency-free — the exhaustive behaviour is covered by
 * test/integration/, which runs against a local cluster. All this has to answer
 * is "did the thing we just shipped come up and route".
 */

const base = Deno.args[0] ?? "https://router.metapage.io";
const channel = `deploy-check-${crypto.randomUUID().replaceAll("-", "")}`;
const wsUrl = new URL(`/${channel}`, base);
wsUrl.protocol = wsUrl.protocol.replace("http", "ws");

const open = (label: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(
      () => reject(new Error(`${label}: timed out connecting to ${wsUrl}`)),
      20_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${label}: failed to connect to ${wsUrl}`));
    }, { once: true });
  });

const fail = (message: string): never => {
  console.error(`  ✗ ${message}`);
  Deno.exit(1);
};

const sender = await open("sender");
const receiver = await open("receiver");

const received: string[] = [];
receiver.addEventListener("message", (event) => {
  if (typeof event.data === "string") received.push(event.data);
});
const senderReceived: string[] = [];
sender.addEventListener("message", (event) => {
  if (typeof event.data === "string") senderReceived.push(event.data);
});

// Give both subscriptions time to establish before anyone sends.
await new Promise((resolve) => setTimeout(resolve, 1_000));

const wsMessage = `websocket ${crypto.randomUUID()}`;
sender.send(wsMessage);

const postMessage = `post ${crypto.randomUUID()}`;
const response = await fetch(new URL(`/${channel}`, base), {
  method: "POST",
  body: postMessage,
});
if (response.status !== 200) {
  fail(`POST /${channel} returned ${response.status}`);
}
await response.text();

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  if (received.includes(wsMessage) && received.includes(postMessage)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

sender.close();
receiver.close();

if (!received.includes(wsMessage)) {
  fail("peer never received the websocket message");
}
if (!received.includes(postMessage)) {
  fail("peer never received the POSTed message");
}
if (senderReceived.includes(wsMessage)) {
  fail("sender received its own message — sender exclusion is broken");
}
if (!senderReceived.includes(postMessage)) {
  fail("sender did not receive the POSTed message — POST must reach everyone");
}

console.log("  ✓ websocket fan-out, sender exclusion, POST");
