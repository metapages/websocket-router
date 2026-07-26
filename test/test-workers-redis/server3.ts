// deno run --allow-net --allow-read standard-library.ts
// Docs: https://deno.land/std/http
import { server } from '../src/server.ts';

const port = parseInt(Deno.env.get("PORT") || "3000");
const APP_FQDN = Deno.env.get("APP_FQDN") || `http://localhost:${port}`;

server({port, fqdn:APP_FQDN});

