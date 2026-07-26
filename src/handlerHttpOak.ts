import { render } from 'https://deno.land/x/eta@v2.2.0/mod.ts';
import { qrcode } from 'https://deno.land/x/qrcode@v2.0.0/mod.ts';
import { oakCors } from 'https://deno.land/x/cors@v1.2.2/mod.ts';
import {
  Application,
  Context,
  Router,
  send,
} from 'https://deno.land/x/oak@v17.1.3/mod.ts';

import { sendToAll } from './handlerWs.ts';

const APP_FQDN = Deno.env.get("APP_FQDN");

// Resolve assets relative to this module, not the process working directory,
// so the server behaves the same when run locally from any directory and when
// run by deno deploy.
const ROOT = import.meta.dirname ? `${import.meta.dirname}/..` : Deno.cwd();

const html :string = await Deno.readTextFile(`${ROOT}/views/index.ejs`);

const renderHtml = async (url:URL) => {
  // generate a QR code for the current URL
  // so phones can easily connect to the presentation (scan and connect)
  let base64Image :unknown = undefined;
  if (url.searchParams.get("hidden") !== "true") {
    base64Image = await qrcode("https://" + APP_FQDN + url.pathname + url.search, { size: 200 }); // data:image/gif;base64,...    
  }
  const renderedHtml = render(html, { qrcodeImage: base64Image ?  '<img src="' + base64Image + '">' :""}, {autoEscape:false});
  return renderedHtml;
}

const createIndexResponse = async (context :Context) => {
  const url = context.request.url;
  const renderedHtml = await renderHtml(url);
  context.response.body = renderedHtml;
  context.response.type = "text/html; charset=utf-8";
}

// initialize our app and router
const app = new Application();


app.use(oakCors()); // Enable CORS for All Routes
const router = new Router();
app.use(router.routes());
app.use(router.allowedMethods());

// serving our static files from /public
app.use(async (context:Context, next:() => void) => {
  try {
    const pathname = context.request.url.pathname.split("/").pop() || "/";
    if (!pathname.includes(".")) {
      next();
      return;
    }
    await send(context, pathname, {
      root: `${ROOT}/public`,
      immutable: true,
    });
  } catch (error) {
    console.error(error);
    next();
  }
});

app.use((context:Context, next:() => void) => {
  // console.log('pathname', context.request.url.pathname);
  const p = context.request.url.pathname.split("/").pop() || "/";
  if (p.includes(".")) {
    next();
    return;
  }
  createIndexResponse(context);
});

// route for index
router
  .get("/", (context :Context<Record<string, any>, Record<string, any>>) => {
    createIndexResponse(context);
  })
  .get("/healthcheck", (context :Context<Record<string, any>, Record<string, any>>) => {
    context.response.body = "OK";
    context.response.type = "text/html; charset=utf-8";
  });

router.post("/:channel", async (context) => {
  const channel = context.params.channel;
  const message = await context.request.body.text();
  sendToAll(channel, message);
  context.response.body = "OK!";
  context.response.type = "text/html; charset=utf-8";
});

export const handlerHttp = app.handle;

