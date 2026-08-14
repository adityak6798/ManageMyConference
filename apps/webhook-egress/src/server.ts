import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pathToFileURL } from "node:url";
import { handleEgress } from "./http.js";

const headersFrom = (headers: IncomingHttpHeaders): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(name, item);
    else if (value !== undefined) result.set(name, value);
  }
  return result;
};

const writeResponse = async (response: Response, output: ServerResponse): Promise<void> => {
  output.statusCode = response.status;
  response.headers.forEach((value, name) => {
    output.setHeader(name, value);
  });
  if (!response.body) {
    output.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(response.body as unknown as NodeReadableStream))
    output.write(chunk);
  output.end();
};

export function createEgressServer(handler: typeof handleEgress = handleEgress) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === "/health" && incoming.method === "GET") {
        await writeResponse(Response.json({ ok: true }), outgoing);
        return;
      }
      const method = incoming.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
      const request = new Request(new URL(incoming.url ?? "/", "http://container.internal"), {
        method,
        headers: headersFrom(incoming.headers),
        ...(body ? { body, duplex: "half" as const } : {}),
      } as RequestInit & { duplex?: "half" });
      await writeResponse(await handler(request), outgoing);
    } catch {
      // ERROR-INTENT: request failures may contain attacker-controlled destination data; log and
      // return only a bounded error, never the original exception.
      // biome-ignore lint/suspicious/noConsole: structured telemetry contains no target or credential.
      console.error(
        JSON.stringify({ level: "error", message: "webhook_egress.server_request_failed" }),
      );
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("cache-control", "no-store");
        outgoing.setHeader("content-type", "application/json");
        outgoing.end('{"error":"INTERNAL_ERROR"}');
      } else outgoing.destroy();
    }
  });
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 32;
  return server;
}

export function listen(portValue = process.env.PORT): void {
  const port = Number(portValue ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be an integer from 1 through 65535");
  createEgressServer().listen(port, "0.0.0.0", () => {
    // biome-ignore lint/suspicious/noConsole: structured startup telemetry contains no secret.
    console.info(JSON.stringify({ level: "info", message: "webhook_egress.listening", port }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) listen();
