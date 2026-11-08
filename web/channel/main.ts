import { getHashParamsFromWindow } from "@metapages/hash-query";
import { isIframe, Metaframe } from "@metapages/metapage";
import ReconnectingWebSocket from "reconnecting-websocket";

import { testApplicationMetapageDefinition } from "./testApplication.js";

/**
 * The channel page: connects a websocket to the channel this page is served
 * from, bridges it to the surrounding metaframe, and shows a traffic
 * indicator.
 *
 * Behaviour is unchanged from the Deno version. The difference is that
 * @metapages/*, and reconnecting-websocket are bundled rather than fetched
 * from a CDN at runtime, so a channel page no longer stops working when
 * jsdelivr does.
 */

const toWebsocketUrl = (href: string): string => {
  const url = new URL(href);
  url.hash = "";
  url.protocol = url.protocol.replace("http", "ws");
  return url.href;
};

const hrefBase = (() => {
  const url = new URL(window.location.href);
  url.hash = "";
  url.pathname = "";
  url.search = "";
  return url.href;
})();

const [, hashParams] = getHashParamsFromWindow();

// ---------------------------------------------------------------------------
// optional forwarding to a second channel
// ---------------------------------------------------------------------------

let forwardSocket: ReconnectingWebSocket | undefined;
const forwardAddress = hashParams["forward"];
if (forwardAddress) {
  const target = toWebsocketUrl(forwardAddress);
  console.log(`forwarding to ${target}`);
  forwardSocket = new ReconnectingWebSocket(target);
  forwardSocket.addEventListener("open", () => console.log(`forward ${target} open`));
  forwardSocket.addEventListener("close", () => console.log(`forward ${target} closed`));
  forwardSocket.addEventListener("error", (event) =>
    console.error(`forward ${target} error`, event),
  );
}

// ---------------------------------------------------------------------------
// the channel socket
// ---------------------------------------------------------------------------

const metaframe = new Metaframe();

let lastInboundAt = 0;
let lastOutboundAt = 0;

const socket = new ReconnectingWebSocket(toWebsocketUrl(window.location.href), undefined, {
  maxReconnectionDelay: 500,
  minReconnectionDelay: 50,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 3000,
  maxRetries: Infinity,
  maxEnqueuedMessages: 30,
});
// Binary frames are routed now, so ask for something usable rather than a Blob.
socket.binaryType = "arraybuffer";

socket.addEventListener("message", (event: MessageEvent) => {
  const payload = event.data as string | ArrayBuffer;

  if (typeof payload === "string" && payload.startsWith("pong")) {
    return;
  }

  if (forwardSocket && forwardSocket.readyState === WebSocket.OPEN) {
    try {
      forwardSocket.send(payload);
    } catch (error) {
      console.error(error);
      socket.reconnect();
    }
  }

  // Only JSON objects map onto metaframe outputs; binary and plain strings
  // pass through the forwarder above and are otherwise ignored here.
  if (typeof payload === "string" && payload.startsWith("{")) {
    try {
      metaframe.setOutputs(JSON.parse(payload) as Record<string, unknown>);
      lastInboundAt = Date.now();
    } catch {
      // Not JSON after all. Nothing to route into the metaframe.
    }
  }
});

socket.addEventListener("error", (event) => {
  console.error(event);
  socket.reconnect();
});

metaframe.onInputs((inputs: Record<string, unknown>) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(inputs));
    lastOutboundAt = Date.now();
  }
});

// ---------------------------------------------------------------------------
// keepalive and traffic indicator
// ---------------------------------------------------------------------------

const setIndicator = (id: string, active: boolean, glyph: string) => {
  const element = document.getElementById(id);
  if (element) element.innerText = active ? glyph : "-";
};

setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send("ping from iframe");
  }
  setIndicator("input", Date.now() - lastInboundAt <= 1000, "⬆️");
  setIndicator("output", Date.now() - lastOutboundAt <= 1000, "⬇️");
}, 1000);

// ---------------------------------------------------------------------------
// page chrome
// ---------------------------------------------------------------------------

if (hashParams["minimal"] === "true" || hashParams["minimal"] === "1") {
  const qr = document.getElementById("qrimage");
  if (qr) qr.style.display = "none";
}

if (!isIframe()) {
  const definition = btoa(
    encodeURIComponent(JSON.stringify(testApplicationMetapageDefinition(hrefBase))),
  );
  const test = document.getElementById("test");
  if (test) {
    test.innerHTML =
      `<a href="https://app.metapages.org/#?definition=${definition}">Test application</a>`;
  }
}
