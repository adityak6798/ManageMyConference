import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const endpoint = process.env.WEBHOOK_EGRESS_ENDPOINT;
const token = process.env.WEBHOOK_EGRESS_TOKEN;
const targetBase = process.env.WEBHOOK_EGRESS_PROBE_TARGET;
const monitorOnly = process.argv.includes("--monitor");
if (!endpoint || !token || !targetBase)
  throw new Error(
    "WEBHOOK_EGRESS_ENDPOINT, WEBHOOK_EGRESS_TOKEN, and WEBHOOK_EGRESS_PROBE_TARGET are required",
  );

const call = async (command) => {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `egress returned HTTP ${response.status}`);
  return response.json();
};

const dispatch = (url, timeoutMs = 1_000) =>
  call({
    operation: "dispatch",
    url,
    timeoutMs,
    headers: {
      "content-type": "application/json",
      "Greenroom-Signature": `t=1,v1=${"0".repeat(64)}`,
      "Greenroom-Event-Id": "probe-event",
      "Greenroom-Event-Type": "schedule.published",
      "Greenroom-Delivery-Id": "probe-delivery",
      "x-correlation-id": "probe-correlation",
    },
    body: "{}",
  });

assert.deepEqual(await call({ operation: "validate", url: `${targetBase}?case=ok` }), {
  result: "safe",
});
assert.deepEqual(await dispatch(`${targetBase}?case=ok`), {
  result: "delivered",
  targetStatus: 204,
});
assert.deepEqual(await dispatch(`${targetBase}?case=redirect`), {
  result: "terminal",
  code: "TARGET_REDIRECT",
  targetStatus: 302,
});

if (!monitorOnly) {
  for (const url of [
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
  ]) {
    assert.deepEqual(await call({ operation: "validate", url }), {
      result: "refused",
      code: "DNS_NOT_GLOBAL",
    });
  }
  assert.deepEqual(await dispatch(`${targetBase}?case=timeout`, 250), {
    result: "retryable",
    code: "TARGET_TIMEOUT",
  });
  assert.deepEqual(await dispatch(`${targetBase}?case=malformed`), {
    result: "terminal",
    code: "TARGET_431",
    targetStatus: 431,
  });

  if (process.env.WEBHOOK_EGRESS_MIXED_URL) {
    assert.deepEqual(
      await call({ operation: "validate", url: process.env.WEBHOOK_EGRESS_MIXED_URL }),
      {
        result: "refused",
        code: "DNS_NOT_GLOBAL",
      },
    );
  }

  // rbndr.us returns either a public resolver address or loopback with a very low TTL. First prove
  // validation can observe the public phase, then prove a fresh dispatch refuses the private phase.
  const rebindUrl = process.env.WEBHOOK_EGRESS_REBIND_URL ?? "https://01010101.7f000001.rbndr.us/";
  let validated = false;
  for (let attempt = 0; attempt < 20 && !validated; attempt += 1) {
    validated = (await call({ operation: "validate", url: rebindUrl })).result === "safe";
    if (!validated) await delay(1_100);
  }
  assert.equal(validated, true, "rebinding probe never returned its public DNS phase");
  let rebound = false;
  for (let attempt = 0; attempt < 20 && !rebound; attempt += 1) {
    const result = await dispatch(rebindUrl);
    rebound = result.result === "terminal" && result.code === "DNS_REBIND_REFUSED";
    if (!rebound) await delay(1_100);
  }
  assert.equal(rebound, true, "dispatch never observed and refused the rebound private phase");
}

process.stdout.write(
  `${JSON.stringify({ ok: true, endpoint, mode: monitorOnly ? "monitor" : "full" })}\n`,
);
