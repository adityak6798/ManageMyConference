import { CommunicationsInputError } from "../../application/communications/errors";
import type {
  WebhookEgress,
  WebhookEgressRequest,
  WebhookEgressResult,
} from "../../application/communications/webhook-security";

const validCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9_]{1,80}$/.test(value);

/** Fetch adapter for the separately operated DNS-validating, address-pinning egress service. */
export class TrustedWebhookEgress implements WebhookEgress {
  private readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error("WEBHOOK_EGRESS_ENDPOINT must be an HTTPS URL without credentials");
    if (!token) throw new Error("WEBHOOK_EGRESS_TOKEN is required");
    this.endpoint = parsed.toString();
  }
  private async call(payload: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("Trusted webhook egress redirected");
    if (!response.ok) throw new Error(`Trusted webhook egress refused (${response.status})`);
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Trusted webhook egress returned a malformed result");
    return body as Record<string, unknown>;
  }
  async validate(url: string): Promise<void> {
    const result = await this.call({ operation: "validate", url });
    if (result.result !== "safe")
      throw new CommunicationsInputError(
        validCode(result.code)
          ? `Webhook destination refused (${result.code})`
          : "Webhook destination refused",
      );
  }
  async dispatch(request: WebhookEgressRequest): Promise<WebhookEgressResult> {
    const result = await this.call({ operation: "dispatch", ...request });
    const status = result.targetStatus;
    if (
      result.result === "delivered" &&
      Number.isInteger(status) &&
      Number(status) >= 200 &&
      Number(status) <= 299
    )
      return { kind: "delivered", targetStatus: Number(status) };
    if (
      (result.result === "retryable" || result.result === "terminal") &&
      validCode(result.code) &&
      (status === undefined ||
        (Number.isInteger(status) && Number(status) >= 300 && Number(status) <= 599))
    )
      return {
        kind: result.result,
        code: result.code,
        ...(Number.isInteger(status) ? { targetStatus: Number(status) } : {}),
      };
    throw new Error("Trusted webhook egress returned a malformed result");
  }
}
