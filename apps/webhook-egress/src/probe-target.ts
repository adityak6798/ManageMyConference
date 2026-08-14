const delayed = async (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Public staging receiver. It retains nothing and lets live probes assert target-facing behavior. */
export async function probeTarget(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const url = new URL(request.url);
  if (url.searchParams.get("case") === "redirect")
    return new Response(null, {
      status: 302,
      headers: { location: "/probe-target?case=reached" },
    });
  if (url.searchParams.get("case") === "timeout") await delayed(2_000);
  if (url.searchParams.get("case") === "malformed")
    return new Response(null, { status: 431, headers: { "x-probe": "bounded-refusal" } });
  const bearerLeaked = request.headers.has("authorization");
  const signature = request.headers.get("greenroom-signature");
  const signatureLooksValid =
    signature !== null && /^t=\d{1,16},v1=[a-f0-9]{64}(?:,v1=[a-f0-9]{64})?$/.test(signature);
  if (bearerLeaked || !signatureLooksValid) return new Response(null, { status: 409 });
  return new Response(null, { status: 204 });
}
