// deno run --allow-net --allow-read standard-library.ts
// Docs: https://deno.land/std/http
import {
  createHandler,
} from "https://deno.land/x/metapages@v0.0.25/worker/routing/handlerDeno.ts";

import { handlerHttp } from "./handlerHttpOak.ts";
import { handleWebsocketConnection } from "./handlerWs.ts";

export const server = (opts: { port: number; fqdn: string }) => {
  const { port, fqdn } = opts;
  Deno.serve(
    {
      port,
      hostname: "0.0.0.0",
      onListen: () => {
        console.log(`🚀🐋 Listening on ${fqdn}`);
      },
      onError: (e: unknown) => {
        console.error(e);
        return Response.error();
      },
    },
    createHandler(handlerHttp, handleWebsocketConnection),
  );
};
