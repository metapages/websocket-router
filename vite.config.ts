import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Builds the two browser bundles into `dist/web`, which the server serves as
 * static assets under /_/.
 *
 *   channel/  the page rendered at /<channel-name>
 *   admin/    the password-protected admin panel at /admin
 *   inspect/  the connection inspector at /<INSPECT_KEY>
 *
 * Everything the browser needs is bundled. The previous Deno version loaded
 * @metapages/* and reconnecting-websocket from a CDN at runtime, which made
 * every channel page depend on jsdelivr being up; they are npm dependencies
 * now and ship inside the bundle.
 */
export default defineConfig({
  root: "web",
  base: "/_/",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        channel: resolve(import.meta.dirname, "web/channel/index.html"),
        landing: resolve(import.meta.dirname, "web/channel/landing.html"),
        admin: resolve(import.meta.dirname, "web/admin/index.html"),
        inspect: resolve(import.meta.dirname, "web/inspect/index.html"),
      },
    },
  },
});
