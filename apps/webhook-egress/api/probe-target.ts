const delayed = async (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Public staging receiver. It retains nothing and lets probes assert target-facing behavior. */
export default {
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.searchParams.get("case") === "redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "/api/probe-target?case=reached" },
      });
    if (url.searchParams.get("case") === "timeout") await delayed(2_000);
    if (url.searchParams.get("case") === "malformed")
      return new Response(null, { status: 431, headers: { "x-probe": "bounded-refusal" } });
    const bearerLeaked = request.headers.has("authorization");
    const signature = request.headers.get("greenroom-signature");
    if (bearerLeaked || signature !== "t=1,v1=probe") return new Response(null, { status: 409 });
    return new Response(null, { status: 204 });
  },
};
