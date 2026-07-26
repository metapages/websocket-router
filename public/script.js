import {
  getHashParamsFromWindow,
} from 'https://cdn.jsdelivr.net/npm/@metapages/hash-query@0.4.7/+esm';
import {
  isIframe,
  Metaframe,
} from 'https://cdn.jsdelivr.net/npm/@metapages/metapage@0.15.0/+esm';
import ReconnectingWebSocket
  from 'https://cdn.jsdelivr.net/npm/reconnecting-websocket@4.4.0/+esm';

const url = new URL(window.location.href);
url.hash = "";
url.pathname = "";
const hrefBase = url.href;

const testApplicationMetapageDefinition = {
  meta: {
    layouts: {
      "react-grid-layout": {
        docs: "https://www.npmjs.com/package/react-grid-layout",
        layout: [
          {
            h: 3,
            i: "random-data-generator",
            moved: false,
            static: false,
            w: 3,
            x: 0,
            y: 0,
          },
          {
            h: 3,
            i: "websocket-testrouting-1234",
            moved: false,
            static: false,
            w: 5,
            x: 3,
            y: 0,
          },
          {
            h: 3,
            i: "websocket-testrouting-1234-DUPLICATE",
            moved: false,
            static: false,
            w: 5,
            x: 3,
            y: 3,
          },
          {
            h: 3,
            i: "websocket-testrouting-1234-DUPLICATE-passthru",
            moved: false,
            static: false,
            w: 4,
            x: 8,
            y: 3,
          },
          {
            h: 3,
            i: "websocket-testrouting-1234-passthru",
            moved: false,
            static: false,
            w: 4,
            x: 8,
            y: 0,
          },
          {
            h: 3,
            i: "websocket-testrouting-endpoint-1234",
            moved: false,
            static: false,
            w: 5,
            x: 3,
            y: 6,
          },
          {
            h: 3,
            i: "websocket-testrouting-endpoint-1234-passthru",
            moved: false,
            static: false,
            w: 4,
            x: 8,
            y: 6,
          },
        ],
        props: {
          cols: 12,
          containerPadding: [5, 5],
          margin: [10, 20],
          rowHeight: 100,
        },
      },
    },
  },
  metaframes: {
    "random-data-generator": {
      url: "https://metapages.org/metaframes/random-data-generator/?frequency=1000",
    },
    "websocket-testrouting-1234": {
      inputs: [
        {
          metaframe: "random-data-generator",
          source: "y",
        },
      ],
      url: `${hrefBase}testrouting-1234`,
    },
    "websocket-testrouting-1234-DUPLICATE": {
      url: `${hrefBase}testrouting-1234#?forward=${hrefBase}testrouting-endpoint-1234`,
    },
    "websocket-testrouting-1234-DUPLICATE-passthru": {
      inputs: [
        {
          metaframe: "websocket-testrouting-1234-DUPLICATE",
          source: "*",
        },
      ],
      url: "https://metapages.org/metaframes/passthrough/",
    },
    "websocket-testrouting-1234-passthru": {
      inputs: [
        {
          metaframe: "websocket-testrouting-1234",
          source: "*",
        },
      ],
      url: "https://metapages.org/metaframes/passthrough/",
    },
    "websocket-testrouting-endpoint-1234": {
      url: `${hrefBase}testrouting-endpoint-1234`,
    },
    "websocket-testrouting-endpoint-1234-passthru": {
      inputs: [
        {
          metaframe: "websocket-testrouting-endpoint-1234",
          source: "*",
        },
      ],
      url: "https://metapages.org/metaframes/passthrough/",
    },
  },
  plugins: [
    "https://editor.mtfm.io/#?options=eyJtb2RlIjoianNvbiIsInNhdmVsb2FkaW5oYXNoIjpmYWxzZSwidGhlbWUiOiJ2cy1kYXJrIn0=",
  ],
  version: "0.3",
};

const convertHttpToWss = (urlstring) => {
  let urlObj = new URL(urlstring);
  urlObj.hash = "";
  urlObj.protocol = urlObj.protocol.replace("http", "ws");
  return urlObj.href;
};

const [prehashParams, hashParams] = getHashParamsFromWindow();

let forwardWebsocketAddress = hashParams["forward"];

let forwardWebsocket;
if (forwardWebsocketAddress) {
  forwardWebsocketAddress = convertHttpToWss(forwardWebsocketAddress);
  console.log(`Forwarding websocket address: ${forwardWebsocketAddress}`);
  forwardWebsocket = forwardWebsocketAddress
    ? new ReconnectingWebSocket(forwardWebsocketAddress)
    : undefined;
  forwardWebsocket.onerror = (err) => {
    console.error(
      `forwardWebsocketAddress=${forwardWebsocketAddress} error=${err} error=${JSON.stringify(
        err
      )}`
    );
  };
  forwardWebsocket.addEventListener("open", () => {
    console.log(`forward=${forwardWebsocketAddress} open!`);
  });
  forwardWebsocket.addEventListener("close", () => {
    console.log(`forward=${forwardWebsocketAddress} close!`);
  });
}

if (document.getElementById("title")) {
  document.getElementById("title").innerText =
    "Websocket route: " + window.location.pathname.substring(1);
}

/* Set up the metaframe */
var mf = new Metaframe();

/* Show some indicator that data is transferred without rendering it*/
let timeLastInput = 0;
let timeLastOutput = 0;
let timeLastForwarding = 0;

// The server will pipe the gesture/input data
const wsUrl = convertHttpToWss(window.location.href);
// console.log(`Home websocket address: ${wsUrl}`);
const ws = new ReconnectingWebSocket(wsUrl, undefined, {
  maxReconnectionDelay: 500,
  minReconnectionDelay: 50,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 3000,
  maxRetries: Infinity,
  // we are very tolerant, if 60 per second it's half a second but its
  // probably more than that
  maxEnqueuedMessages: 30,
});

// ws.addEventListener("open", () => {
//   console.log("+websocket opened");
// });
// ws.addEventListener("close", () => {
//   console.log("-websocket closed");
// });

// When we get the input data, which is expected to be JSON, for each top level key
// pipe the keys value to the corresponding output pipe
ws.addEventListener("message", (event) => {
  const inputBlob = event.data;
  if (typeof inputBlob === "string") {
    if (inputBlob.startsWith("pong")) {
      console.log(inputBlob);
      return;
    }
  }
  // forward if required
  // if (forwardWebsocket) {
  //   console.log('forwardWebsocket.readyState', forwardWebsocket.readyState)
  // }
  if (
    forwardWebsocket &&
    forwardWebsocket.readyState === ReconnectingWebSocket.OPEN
  ) {
    try {
      // console.log(`Got parent incoming message, sending to forwarding ws inputBlob=${inputBlob}`);
      forwardWebsocket.send(inputBlob);
      timeLastForwarding = Date.now();
    } catch (err) {
      console.error(err);
      ws.reconnect();
    }
  }

  // console.log(inputBlob)

  let inputBlobJson = null;
  if (typeof inputBlob === "string" && inputBlob[0] === "{") {
    try {
      inputBlobJson = JSON.parse(inputBlob);
    } catch (err) {
      //swallow JSON parsing errors
    }
  } else if (typeof inputBlob === "object") {
    inputBlobJson = inputBlob;
  }
  if (inputBlobJson) {
    mf.setOutputs(inputBlobJson);
    timeLastInput = Date.now();
  }
});

ws.addEventListener("error", (err) => {
  console.error(err);
  ws.reconnect();
});

// all inputs go up the websocket pipe to the channel
mf.onInputs((inputs) => {
  // console.log("connection.superslides.io metaframe onInputs", inputs);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(inputs));
    timeLastOutput = Date.now();
  }
});

setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send("ping from iframe");
  }

  if (Date.now() - timeLastInput <= 1000) {
    document.getElementById("input").innerText = "⬆️";
  } else {
    document.getElementById("input").innerText = "-";
  }
  if (Date.now() - timeLastOutput <= 1000) {
    document.getElementById("output").innerText = "⬇️";
  } else {
    document.getElementById("output").innerText = "-";
  }
  // if ((Date.now() - timeLastForwarding) <= 1000) {
  //   document.getElementById("forwarding").innerText = "forwarding: 🟢"
  // } else {
  //   document.getElementById("forwarding").innerText = "forwarding: ..."
  // }
}, 1000);

if (!isIframe()) {
  const definition = btoa(
    encodeURIComponent(JSON.stringify(testApplicationMetapageDefinition))
  );
  document.getElementById(
    "test"
  ).innerHTML = `<a href="https://app.metapages.org/#?definition=${definition}">Test application</a>`;
}

// Allow the QR Code to be hidden
const minimal = hashParams["minimal"] === "true" || hashParams["minimal"] === "1";
if (minimal) {
  const qrcodeImage = document.getElementById("qrcode");
  if (qrcodeImage) {
    qrcodeImage.style.display = "none";
  }
}
