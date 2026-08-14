// @acceptance ACC-INTEGRATION
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createEgressServer } from "../src/server.js";

describe("container HTTP server", () => {
  it("streams a Node request through the Fetch boundary and writes its bounded response", async () => {
    const server = createEgressServer(async (request) =>
      Response.json({ method: request.method, body: await request.text() }, { status: 202 }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/egress`, {
        method: "POST",
        body: '{"operation":"validate"}',
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        method: "POST",
        body: '{"operation":"validate"}',
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("answers the Container startup health check without invoking the command handler", async () => {
    let handled = false;
    const server = createEgressServer(async () => {
      handled = true;
      return new Response();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(handled).toBe(false);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
