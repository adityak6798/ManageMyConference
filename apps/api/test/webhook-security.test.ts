// @acceptance ACC-INTEGRATION
import { describe, expect, it, vi } from "vitest";
import { AesGcmWebhookSecretProtector } from "../src/adapters/persistence/webhook-secret-protector";
import { TrustedWebhookEgress } from "../src/adapters/providers/trusted-webhook-egress";
import type {
  WebhookEgress,
  WebhookEgressRequest,
  WebhookEgressResult,
} from "../src/application/communications/webhook-security";

const request = (): WebhookEgressRequest => ({
  url: "https://receiver.example.com/hook",
  headers: { "Greenroom-Signature": "t=1,v1=signed" },
  body: "{}",
  timeoutMs: 1_000,
});

describe("trusted webhook egress", () => {
  it("sends its credential only to the enforcement origin and refuses its redirect", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://egress.example.net/v1/webhooks");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer proxy-secret");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operation: "dispatch",
        url: "https://receiver.example.com/hook",
      });
      return new Response(null, { status: 302, headers: { location: request().url } });
    });
    const egress = new TrustedWebhookEgress(
      "https://egress.example.net/v1/webhooks",
      "proxy-secret",
      fetcher as typeof fetch,
    );
    await expect(egress.dispatch(request())).rejects.toThrow("redirected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts only coherent structured target results", async () => {
    for (const body of [
      { result: "delivered", targetStatus: 503 },
      { result: "retryable", code: "TARGET_TIMEOUT", targetStatus: 204 },
      { result: "terminal", code: "contains spaces", targetStatus: 400 },
      { result: "delivered" },
    ]) {
      const egress = new TrustedWebhookEgress(
        "https://egress.example.net/v1/webhooks",
        "proxy-secret",
        vi.fn(async () => Response.json(body)) as typeof fetch,
      );
      await expect(egress.dispatch(request())).rejects.toThrow("malformed result");
    }
    const egress = new TrustedWebhookEgress(
      "https://egress.example.net/v1/webhooks",
      "proxy-secret",
      vi.fn(async () => Response.json({ result: "delivered", targetStatus: 204 })) as typeof fetch,
    );
    await expect(egress.dispatch(request())).resolves.toEqual({
      kind: "delivered",
      targetStatus: 204,
    });
  });

  it("rejects missing and malformed wrapping configuration and authenticates envelopes", async () => {
    await expect(AesGcmWebhookSecretProtector.fromConfiguration({})).rejects.toThrow("missing");
    await expect(
      AesGcmWebhookSecretProtector.fromConfiguration({ currentVersion: "v1", keyringJson: "{}" }),
    ).rejects.toThrow("absent");
    const encoded = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const protector = await AesGcmWebhookSecretProtector.fromConfiguration({
      currentVersion: "v1",
      keyringJson: JSON.stringify({ v1: encoded }),
    });
    const envelope = await protector.seal("plaintext-secret", "purpose-a");
    expect(envelope).not.toContain("plaintext-secret");
    await expect(protector.open(envelope, "purpose-a")).resolves.toBe("plaintext-secret");
    await expect(protector.open(envelope, "purpose-b")).rejects.toThrow("authentication failed");
  });
});

/** Executable model of the separately deployed service's DNS/pinning contract. */
class EnforcementFixture implements WebhookEgress {
  answers = new Map<string, { address: string; globallyRoutable: boolean }[]>();
  targetInvocations = 0;
  private safe(url: string) {
    const answers = this.answers.get(new URL(url).hostname) ?? [];
    return answers.length > 0 && answers.every(({ globallyRoutable }) => globallyRoutable);
  }
  async validate(url: string) {
    if (!this.safe(url)) throw new Error("DNS_NOT_GLOBAL");
  }
  async dispatch(input: WebhookEgressRequest): Promise<WebhookEgressResult> {
    if (!this.safe(input.url)) return { kind: "terminal", code: "DNS_REBIND_REFUSED" };
    // The real enforcement service pins one address from this validated set to the target socket.
    this.targetInvocations += 1;
    return { kind: "delivered", targetStatus: 204 };
  }
}

describe("enforcement-service DNS contract", () => {
  it("rejects mixed global/private answers", async () => {
    const fixture = new EnforcementFixture();
    fixture.answers.set("receiver.example.com", [
      { address: "93.184.216.34", globallyRoutable: true },
      { address: "10.0.0.8", globallyRoutable: false },
    ]);
    await expect(fixture.validate(request().url)).rejects.toThrow("DNS_NOT_GLOBAL");
    expect(fixture.targetInvocations).toBe(0);
  });

  it("revalidates at send time and refuses rebinding without reaching target transport", async () => {
    const fixture = new EnforcementFixture();
    fixture.answers.set("receiver.example.com", [
      { address: "93.184.216.34", globallyRoutable: true },
      { address: "2001:4860:4860::8888", globallyRoutable: true },
    ]);
    await expect(fixture.validate(request().url)).resolves.toBeUndefined();
    fixture.answers.set("receiver.example.com", [
      { address: "127.0.0.1", globallyRoutable: false },
    ]);
    await expect(fixture.dispatch(request())).resolves.toEqual({
      kind: "terminal",
      code: "DNS_REBIND_REFUSED",
    });
    expect(fixture.targetInvocations).toBe(0);
  });
});
