import { probeTarget } from "./probe-target.js";

export async function routeRequest(
  request: Request,
  container: { fetch(request: Request): Promise<Response> },
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health" && request.method === "GET")
    return Response.json(
      { ok: true, service: "greenroom-webhook-egress" },
      { headers: { "cache-control": "no-store" } },
    );
  if (pathname === "/probe-target") return probeTarget(request);
  if (pathname === "/egress") return container.fetch(request);
  return Response.json(
    { error: "NOT_FOUND" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}
