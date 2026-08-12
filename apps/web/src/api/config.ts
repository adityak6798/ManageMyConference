/**
 * API origin baked into the production bundle by Vite.
 *
 * The empty default preserves the local Vite proxy and same-origin Worker deployment. A
 * separately hosted frontend can instead set `VITE_API_BASE_URL=https://api.example.com`.
 */
export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

function apiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input !== "string" || !input.startsWith("/")) return input;
  return `${apiBase}${input}`;
}

/** Fetch through the configured API origin while retaining the native fetch signature. */
export const apiFetch: typeof fetch = (input, init) =>
  init === undefined ? globalThis.fetch(apiUrl(input)) : globalThis.fetch(apiUrl(input), init);
