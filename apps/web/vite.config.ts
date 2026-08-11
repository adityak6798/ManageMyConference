/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

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
    proxy: { "/api": `http://127.0.0.1:${process.env.GREENROOM_API_PORT ?? "8787"}` },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
