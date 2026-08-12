/**
 * The live Airtable projection adapter.
 *
 * Outbound only: SQL stays canonical and Airtable is a view of it (`PRD-INT-001`). One PATCH per
 * delivery, upserting on the Greenroom resource reference, so the same versioned projection
 * applied twice converges on one record instead of appending a second — the property that lets a
 * retried lease and a redelivered projection both be safe.
 *
 * The adapter maps a projection payload onto columns and nothing more. It does not decide what
 * to project, when to supersede, or what a conflict means: the outbox already answered those
 * before the call is made.
 *
 * @spec PORT-AIRTABLE PRD-INT-001
 */
import type { DeliveryProvider, ProviderResult } from "../../application/communications/ports";
import type { Delivery } from "../../domain/communications/delivery";
import {
  MALFORMED,
  PROVIDER_TIMEOUT_MS,
  UNREACHABLE,
  outcomeForStatus,
  readJsonBody,
} from "./http-outcome";

export interface AirtableProviderConfiguration {
  readonly baseId: string;
  readonly tableId: string;
  /** Personal access token, scoped to this base with write access to this table only. */
  readonly token: string;
  /**
   * The Airtable column holding the Greenroom reference. It is the merge key, so it must be
   * unique in the table; the connection test is what proves it exists before a sync runs.
   */
  readonly referenceField?: string;
  readonly versionField?: string;
  readonly apiOrigin?: string;
  readonly timeoutMs?: number;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Airtable cells hold scalars. A projection payload is ours and may nest, so anything that is
 * not already a scalar is serialized rather than dropped: a column showing JSON is debuggable,
 * a silently absent column is not.
 */
const cell = (value: unknown): string | number | boolean => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  return JSON.stringify(value) ?? "";
};

export class AirtableProjectionProvider implements DeliveryProvider {
  constructor(
    private readonly configuration: AirtableProviderConfiguration,
    private readonly fetch: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async deliver(delivery: Delivery): Promise<ProviderResult> {
    const referenceField = this.configuration.referenceField ?? "Greenroom Ref";
    const versionField = this.configuration.versionField ?? "Greenroom Version";
    const origin = this.configuration.apiOrigin ?? "https://api.airtable.com";
    const url = `${origin}/v0/${encodeURIComponent(this.configuration.baseId)}/${encodeURIComponent(this.configuration.tableId)}`;

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${this.configuration.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          // Airtable's own upsert: match on our reference column, insert when absent, update
          // when present. This is what makes a repeated apply converge rather than duplicate.
          performUpsert: { fieldsToMergeOn: [referenceField] },
          records: [
            {
              fields: {
                // The payload goes first and the two controlled columns overwrite it. Order is
                // load-bearing: Airtable matches `fieldsToMergeOn` against the value in the
                // submitted record, so a payload carrying its own `Greenroom Ref` would choose
                // which existing row this projection overwrites. Content must not be able to
                // pick its own merge key — an Airtable write cannot be un-sent.
                ...Object.fromEntries(
                  Object.entries(delivery.payload).map(([key, value]) => [key, cell(value)]),
                ),
                [referenceField]: delivery.recipientRef,
                [versionField]: delivery.projectionVersion ?? 0,
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(this.configuration.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      });
    } catch {
      // ERROR-INTENT: transport failures are normalized into a bounded retry; the underlying
      // message is untrusted and never stored.
      return UNREACHABLE;
    }

    const failure = outcomeForStatus(response.status);
    if (failure) return failure;
    const body = await readJsonBody(response);
    const records =
      body && typeof body === "object" && "records" in body && Array.isArray(body.records)
        ? body.records
        : null;
    const first = records?.[0] as { id?: unknown } | undefined;
    return typeof first?.id === "string"
      ? { kind: "success", providerReference: `airtable:${first.id}` }
      : MALFORMED;
  }
}
