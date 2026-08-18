/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { resolveWorktreeEnvironment } from "../../tools/worktree-env.mjs";

const { apiPort, webPort } = resolveWorktreeEnvironment();

/**
 * The framing policy for `/embed/*`, in one place.
 *
 * The embed views are only useful inside somebody else's page, so "may this be
 * framed" has to be an explicit, testable answer rather than a browser default that
 * a future host could quietly change.
 *
 * It is declared twice on purpose, because nothing serves both cases:
 *  - `public/_headers` covers the built output on a static host that reads it
 *    (Cloudflare Pages, Netlify). It is data, not code, and cannot apply in dev.
 *  - this plugin covers `vite dev` and `vite preview`, which serve the SPA from
 *    Node and ignore `_headers` entirely.
 *
 * A plain static file server (nginx, `python -m http.server`) honours neither and
 * needs its own rule; the `_headers` file documents the exact policy to copy.
 */
const EMBED_FRAME_POLICY = "frame-ancestors *";

function embedFramingPolicy(): Plugin {
  const pin = (
    request: { url?: string | undefined },
    response: { setHeader(name: string, value: string): unknown },
    next: () => void,
  ) => {
    if (request.url?.startsWith("/embed/"))
      response.setHeader("content-security-policy", EMBED_FRAME_POLICY);
    next();
  };
  return {
    name: "greenroom-embed-framing",
    configureServer(server) {
      server.middlewares.use(pin);
    },
    configurePreviewServer(server) {
      server.middlewares.use(pin);
    },
  };
}

export default defineConfig({
  plugins: [react(), embedFramingPolicy()],
  server: {
    // Bind IPv4 explicitly. Vite's default binds ::1 only, which makes the documented
    // http://127.0.0.1:5173 start URL connection-refused; browsers fall back to IPv4 for
    // "localhost", so this address works for both spellings.
    host: "127.0.0.1",
    // Resolved, never guessed. `strictPort` matters as much as the number: without it Vite
    // silently takes the next free port when the derived one is busy, and Playwright then
    // waits on a URL nothing is serving until it times out with no hint why.
    port: webPort,
    strictPort: true,
    /*
     * The Worker's own routes, so a local run answers them the way a deployment does.
     *
     * `wrangler.toml` runs the Worker first for `/api/*`, `/health`, `/openapi.json` and
     * `/docs`; the dev server proxied only the first of those, so the two links the developer
     * page exists to hand a reader — the generated reference and the document behind it — fell
     * through to the SPA fallback and rendered the console's not-found card. They worked in
     * production and were broken in the one place somebody would be editing the page.
     */
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/health": `http://127.0.0.1:${apiPort}`,
      "/openapi.json": `http://127.0.0.1:${apiPort}`,
      "/docs": `http://127.0.0.1:${apiPort}`,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
