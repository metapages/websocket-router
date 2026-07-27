import { defineConfig } from "vitepress";

// The docs are served by the router itself, mounted under /docs. `base` has to
// match that mount point or every asset URL will 404 in production.
export default defineConfig({
  base: "/docs/",
  outDir: ".vitepress/dist",
  cacheDir: ".vitepress/cache",
  lang: "en-US",
  title: "Websocket Router",
  description:
    "A public address space for realtime messages: connect a websocket to a URL and everything you send reaches every other client on that URL.",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: "/favicon.ico" }]],
  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
  },
  themeConfig: {
    siteTitle: "Websocket Router",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/api", activeMatch: "/reference/" },
      {
        text: "Live server ↗",
        link: "https://websocket-router.metapage.deno.net/",
      },
    ],
    sidebar: [
      {
        text: "Understanding it",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Channels", link: "/guide/channels" },
          { text: "Messages", link: "/guide/messages" },
        ],
      },
      {
        text: "Building with it",
        items: [
          { text: "Use cases", link: "/guide/use-cases" },
          { text: "Patterns", link: "/guide/patterns" },
          { text: "Metapages & metaframes", link: "/guide/metapages" },
          { text: "Production notes", link: "/guide/production" },
        ],
      },
      {
        text: "Running it",
        items: [
          { text: "Architecture", link: "/guide/architecture" },
          { text: "Self-hosting", link: "/guide/self-hosting" },
          { text: "Contributing", link: "/guide/contributing" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/reference/api" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Guarantees & limits", link: "/reference/guarantees" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/metapages/websocket-router" },
    ],
    editLink: {
      pattern:
        "https://github.com/metapages/websocket-router/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Built by metapage",
    },
  },
});
