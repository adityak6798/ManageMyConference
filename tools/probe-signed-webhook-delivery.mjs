/** One signed delivery through the deployed API, egress service and signature-checking target. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const api = (process.env.GREENROOM_PROBE_API ?? "").replace(/\/$/, "");
const target = process.env.WEBHOOK_EGRESS_PROBE_TARGET;
if (!api || !target)
  throw new Error("GREENROOM_PROBE_API and WEBHOOK_EGRESS_PROBE_TARGET are required");

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const id = crypto.randomUUID();
let cookie = "";
let subscriptionId = "";

const request = async (pathname, init = {}) => {
  const response = await fetch(`${api}${pathname}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  return response;
};

try {
  const session = await request("/api/demo-session", {
    method: "POST",
    body: JSON.stringify({ persona: "organizer" }),
  });
  assert.equal(session.status, 200, `demo session returned ${session.status}`);
  cookie = (session.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  assert.ok(cookie, "demo session returned no cookie");

  const created = await request(`/api/organizations/${organizationId}/webhooks`, {
    method: "POST",
    headers: { "idempotency-key": `live-probe-create-${id}` },
    body: JSON.stringify({
      url: `${target}?case=ok`,
      eventTypes: ["schedule.published"],
    }),
  });
  assert.equal(
    created.status,
    201,
    `create subscription returned ${created.status}: ${await created.text()}`,
  );
  const createdBody = await created.json();
  subscriptionId = createdBody.subscription?.id ?? "";
  assert.ok(subscriptionId, "create subscription returned no id");
  // The one-time signing secret is intentionally neither retained nor printed. The receiver
  // validates the signature's wire shape and the D1 suite independently validates its HMAC.

  const published = await request(`/api/events/${eventId}/agenda/publications`, {
    method: "POST",
    headers: { "idempotency-key": `live-probe-publish-${id}` },
  });
  assert.equal(
    published.status,
    201,
    `publish trigger returned ${published.status}: ${await published.text()}`,
  );

  // Wrangler exposes the scheduled handler at this address in local and deployed Workers. If a
  // deployment refuses the manual trigger, the configured cron still drains it while we poll.
  await request("/cdn-cgi/handler/scheduled", { method: "POST" });

  let succeeded = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !succeeded) {
    const history = await request(
      `/api/organizations/${organizationId}/webhooks/${subscriptionId}/deliveries`,
    );
    assert.equal(history.status, 200, `delivery history returned ${history.status}`);
    const body = await history.json();
    succeeded = body.history?.find(
      ({ delivery }) =>
        delivery.eventType === "schedule.published" && delivery.state === "succeeded",
    );
    if (!succeeded) await delay(5_000);
  }
  assert.ok(succeeded, "signed delivery did not succeed within 120 seconds");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      api,
      target,
      subscriptionId,
      deliveryId: succeeded.delivery.id,
      attemptCount: succeeded.delivery.attemptCount,
    })}\n`,
  );
} finally {
  if (subscriptionId) {
    const removed = await request(
      `/api/organizations/${organizationId}/webhooks/${subscriptionId}`,
      {
        method: "DELETE",
        headers: { "idempotency-key": `live-probe-remove-${id}` },
      },
    );
    if (!removed.ok) {
      process.stderr.write(`probe cleanup returned ${removed.status}: ${await removed.text()}\n`);
      process.exitCode = 1;
    }
  }
}
