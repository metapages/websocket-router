#!/usr/bin/env node
/**
 * Websocket round trip against a live deployment, including binary frames.
 *
 * Run by `just verify`. Uses two real clients on a random channel and checks
 * the delivery contract end to end: both directions, sender exclusion, text
 * and binary, and that POST reaches everyone.
 */
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

const ESC = String.fromCharCode(27);
const RED = `${ESC}[35m`;
const GREEN = `${ESC}[32m`;
const RESET = `${ESC}[0m`;

const base = (process.argv[2] ?? "https://router.metapage.io").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const channel = `verify-${randomBytes(8).toString("hex")}`;
const url = `${wsBase}/${channel}`;

const fail = (message) => {
  console.error(`  ${RED}x ${message}${RESET}`);
  process.exit(1);
};
const pass = (message) => console.log(`  ${GREEN}+ ${message}${RESET}`);

const open = (label) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(
      () => reject(new Error(`${label}: open timed out`)),
      15_000,
    );
    socket.on("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${error.message}`));
    });
  });

const collect = (socket) => {
  const received = { text: [], binary: [] };
  socket.on("message", (data, isBinary) => {
    if (isBinary) received.binary.push(Buffer.from(data));
    else received.text.push(data.toString("utf8"));
  });
  return received;
};

const waitFor = async (predicate, description, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`timed out waiting for ${description}`);
};

let a;
let b;
try {
  [a, b] = await Promise.all([open("client A"), open("client B")]);
} catch (error) {
  fail(error.message);
}

const fromA = collect(a);
const fromB = collect(b);

// --- text, A -> B ----------------------------------------------------------
const textPayload = `hello-${randomBytes(4).toString("hex")}`;
a.send(textPayload);
await waitFor(() => fromB.text.includes(textPayload), "B to receive A's text");
pass("text A to B");

// --- sender exclusion ------------------------------------------------------
if (fromA.text.includes(textPayload)) {
  fail("A received its own message; sender exclusion is broken");
}
pass("sender exclusion");

// --- binary, B -> A --------------------------------------------------------
const binaryPayload = randomBytes(256);
b.send(binaryPayload, { binary: true });
await waitFor(
  () => fromA.binary.some((entry) => entry.equals(binaryPayload)),
  "A to receive B's binary frame",
);
pass("binary B to A");

// --- keepalive -------------------------------------------------------------
a.send("ping from verify");
await waitFor(
  () => fromA.text.some((entry) => entry.startsWith("client ping: pong")),
  "a pong",
);
pass("keepalive");

// --- POST reaches everyone -------------------------------------------------
const postPayload = `posted-${randomBytes(4).toString("hex")}`;
const response = await fetch(`${base}/${channel}`, {
  method: "POST",
  body: postPayload,
});
if (!response.ok) fail(`POST /${channel} -> ${response.status}`);
await Promise.all([
  waitFor(() => fromA.text.includes(postPayload), "A to receive the POST"),
  waitFor(() => fromB.text.includes(postPayload), "B to receive the POST"),
]);
pass("POST reaches every listener");

a.close();
b.close();
