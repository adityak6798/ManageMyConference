export default {
  fetch() {
    return Response.json(
      {
        ok: true,
        service: "greenroom-webhook-egress",
        commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
};
