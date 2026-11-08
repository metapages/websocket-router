/**
 * The metapage definition behind the "Test application" link, shown only when
 * the channel page is opened directly rather than embedded in an iframe.
 *
 * Lifted unchanged from the Deno version's public/script.js; it is data, not
 * logic, and lives in its own module to keep main.ts readable.
 */
export const testApplicationMetapageDefinition = (hrefBase: string) => ({
  meta: {
    layouts: {
      "react-grid-layout": {
        docs: "https://www.npmjs.com/package/react-grid-layout",
        layout: [
          { h: 3, i: "random-data-generator", moved: false, static: false, w: 3, x: 0, y: 0 },
          { h: 3, i: "websocket-testrouting-1234", moved: false, static: false, w: 5, x: 3, y: 0 },
          { h: 3, i: "websocket-testrouting-1234-DUPLICATE", moved: false, static: false, w: 5, x: 3, y: 3 },
          { h: 3, i: "websocket-testrouting-1234-DUPLICATE-passthru", moved: false, static: false, w: 4, x: 8, y: 3 },
          { h: 3, i: "websocket-testrouting-1234-passthru", moved: false, static: false, w: 4, x: 8, y: 0 },
          { h: 3, i: "websocket-testrouting-endpoint-1234", moved: false, static: false, w: 5, x: 3, y: 6 },
          { h: 3, i: "websocket-testrouting-endpoint-1234-passthru", moved: false, static: false, w: 4, x: 8, y: 6 },
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
      inputs: [{ metaframe: "random-data-generator", source: "y" }],
      url: `${hrefBase}testrouting-1234`,
    },
    "websocket-testrouting-1234-DUPLICATE": {
      url: `${hrefBase}testrouting-1234#?forward=${hrefBase}testrouting-endpoint-1234`,
    },
    "websocket-testrouting-1234-DUPLICATE-passthru": {
      inputs: [{ metaframe: "websocket-testrouting-1234-DUPLICATE", source: "*" }],
      url: "https://metapages.org/metaframes/passthrough/",
    },
    "websocket-testrouting-1234-passthru": {
      inputs: [{ metaframe: "websocket-testrouting-1234", source: "*" }],
      url: "https://metapages.org/metaframes/passthrough/",
    },
    "websocket-testrouting-endpoint-1234": {
      url: `${hrefBase}testrouting-endpoint-1234`,
    },
    "websocket-testrouting-endpoint-1234-passthru": {
      inputs: [{ metaframe: "websocket-testrouting-endpoint-1234", source: "*" }],
      url: "https://metapages.org/metaframes/passthrough/",
    },
  },
  plugins: [
    "https://editor.mtfm.io/#?options=eyJtb2RlIjoianNvbiIsInNhdmVsb2FkaW5oYXNoIjpmYWxzZSwidGhlbWUiOiJ2cy1kYXJrIn0=",
  ],
  version: "0.3",
});
