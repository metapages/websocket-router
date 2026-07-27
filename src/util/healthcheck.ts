const port = parseInt(Deno.env.get("PORT") || "3000");
const resp = await fetch(`http://localhost:${port}/healthcheck`);
Deno.exit(resp.status !== 200 ? 1 : 0);
