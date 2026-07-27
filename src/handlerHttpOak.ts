import { render } from "https://deno.land/x/eta@v2.2.0/mod.ts";
import { qrcode } from "https://deno.land/x/qrcode@v2.0.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import {
  Application,
  Context,
  Router,
  send,
} from "https://deno.land/x/oak@v17.1.3/mod.ts";

import { sendToAll } from "./handlerWs.ts";

// The host encoded into channel-page QR codes. Unset means the public
// deployment: a missing value used to produce QR codes pointing at
// `https://undefined/...`, which renders fine and only fails when scanned.
const APP_FQDN = Deno.env.get("APP_FQDN") || "router.metapage.io";

// Resolve assets relative to this module, not the process working directory,
// so the server behaves the same when run locally from any directory and when
// run by deno deploy.
const ROOT = import.meta.dirname ? `${import.meta.dirname}/..` : Deno.cwd();
const PUBLIC_ROOT = `${ROOT}/public`;
const DOCS_ROOT = `${ROOT}/docs/.vitepress/dist`;

const channelPageTemplate: string = await Deno.readTextFile(
  `${ROOT}/views/index.ejs`,
);
const landingPage: string = await Deno.readTextFile(
  `${ROOT}/views/landing.html`,
);

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (_) {
    return false;
  }
};

/** The docs are built by `just docs-build`; they may not be present locally. */
const docsBuilt = await exists(`${DOCS_ROOT}/index.html`);
if (!docsBuilt) {
  console.log(`📖 no built docs at ${DOCS_ROOT} — /docs will explain how`);
}

const DOCS_MISSING_HTML =
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Docs not built</title>
<body style="font-family:system-ui;max-width:40em;margin:4em auto;padding:0 1em">
<h1>Docs not built</h1>
<p>The documentation site has not been built into
<code>docs/.vitepress/dist</code>. Build it with:</p>
<pre style="background:#eee;padding:1em;border-radius:6px">just docs-build</pre>
<p><a href="/">← back to the router</a></p>
</body></html>`;

/**
 * Try each candidate path under `root`, stopping at the first that exists.
 * `send` handles range requests, etag/last-modified and path traversal.
 */
const sendFirstMatch = async (
  context: Context,
  root: string,
  candidates: string[],
  maxageMs = 0,
): Promise<boolean> => {
  for (const candidate of candidates) {
    if (!(await exists(`${root}/${candidate}`))) {
      continue;
    }
    try {
      await send(context, candidate, {
        root,
        maxage: maxageMs,
        immutable: maxageMs > 0,
      });
      return true;
    } catch (error) {
      console.error(`failed serving ${root}/${candidate}`, error);
    }
  }
  return false;
};

/** vitepress emits content-hashed filenames under assets/, so those never change. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const renderChannelPage = async (url: URL): Promise<string> => {
  // Generate a QR code for the current URL so phones can join the channel by
  // scanning it.
  let base64Image: unknown = undefined;
  if (url.searchParams.get("hidden") !== "true") {
    base64Image = await qrcode(
      `https://${APP_FQDN}${url.pathname}${url.search}`,
      { size: 200 },
    ); // data:image/gif;base64,...
  }
  return render(
    channelPageTemplate,
    { qrcodeImage: base64Image ? `<img src="${base64Image}">` : "" },
    { autoEscape: false },
  );
};

const app = new Application();
app.use(oakCors()); // Enable CORS for all routes

const router = new Router();

router.get("/healthcheck", (context: Context) => {
  context.response.body = "OK";
  context.response.type = "text/plain; charset=utf-8";
});

router.get("/", (context: Context) => {
  context.response.body = landingPage;
  context.response.type = "text/html; charset=utf-8";
});

// Anything posted to a channel is broadcast to every listener on it, on every
// server instance. There is no sending socket to exclude, so everyone gets it.
router.post("/:channel", async (context) => {
  const channel = context.params.channel;
  const message = await context.request.body.text();
  sendToAll(channel, message);
  context.response.body = "OK!";
  context.response.type = "text/plain; charset=utf-8";
});

app.use(router.routes());
app.use(router.allowedMethods());

// The documentation site, built by vitepress with base "/docs/".
app.use(async (context: Context, next: () => Promise<unknown>) => {
  const pathname = context.request.url.pathname;
  if (pathname !== "/docs" && !pathname.startsWith("/docs/")) {
    await next();
    return;
  }

  if (!docsBuilt) {
    context.response.status = 503;
    context.response.body = DOCS_MISSING_HTML;
    context.response.type = "text/html; charset=utf-8";
    return;
  }

  if (pathname === "/docs") {
    context.response.redirect("/docs/");
    return;
  }

  const relative = pathname.substring("/docs/".length);
  const maxage = relative.startsWith("assets/") ? ONE_YEAR_MS : 0;
  const candidates = relative === ""
    ? ["index.html"]
    : [relative, `${relative}.html`, `${relative}/index.html`];

  if (await sendFirstMatch(context, DOCS_ROOT, candidates, maxage)) {
    return;
  }
  await sendFirstMatch(context, DOCS_ROOT, ["404.html"]);
  context.response.status = 404;
});

// Static assets from /public. Channel pages live at arbitrary paths and load
// their assets with absolute URLs, but historically any request whose final
// segment looked like a filename was served from /public, so keep that.
app.use(async (context: Context, next: () => Promise<unknown>) => {
  const pathname = context.request.url.pathname;
  const filename = pathname.split("/").pop() || "";
  if (!filename.includes(".")) {
    await next();
    return;
  }
  // No content hashing on these, so they must stay revalidated.
  if (
    await sendFirstMatch(context, PUBLIC_ROOT, [
      pathname.substring(1),
      filename,
    ])
  ) {
    return;
  }
  await next();
});

// Everything else is a channel: /<channel-name> renders the channel page.
app.use(async (context: Context) => {
  context.response.body = await renderChannelPage(context.request.url);
  context.response.type = "text/html; charset=utf-8";
});

export const handlerHttp = app.handle;
