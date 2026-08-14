const delayed = async (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Public staging receiver. It retains nothing and lets live probes assert target-facing behavior. */
export async function probeTarget(request: Request): Promise<Response> {
  const respond = (status: number, headers?: HeadersInit) =>
    new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
  if (request.method !== "POST") return respond(405);
  const url = new URL(request.url);
  if (url.searchParams.get("case") === "redirect")
    return respond(302, { location: "/probe-target?case=reached" });
  if (url.searchParams.get("case") === "timeout") await delayed(2_000);
  if (url.searchParams.get("case") === "malformed")
    return respond(431, { "x-probe": "bounded-refusal" });
  const bearerLeaked = request.headers.has("authorization");
  const signature = request.headers.get("greenroom-signature");
  const signatureLooksValid =
    signature !== null && /^t=\d{1,16},v1=[a-f0-9]{64}(?:,v1=[a-f0-9]{64})?$/.test(signature);
  if (bearerLeaked || !signatureLooksValid) return respond(409);
  return respond(204);
}
