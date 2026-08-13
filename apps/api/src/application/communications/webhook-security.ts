/** Ports for webhook secret storage and the trusted outbound-egress boundary. @spec PRD-INT-001 */
export interface WebhookSecretProtector {
  seal(plaintext: string, purpose: string): Promise<string>;
  open(envelope: string, purpose: string): Promise<string>;
}

export interface WebhookEgressRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
}
export type WebhookEgressResult =
  | { kind: "delivered"; targetStatus: number }
  | { kind: "retryable" | "terminal"; code: string; targetStatus?: number };
export interface WebhookEgress {
  validate(url: string): Promise<void>;
  dispatch(request: WebhookEgressRequest): Promise<WebhookEgressResult>;
}
