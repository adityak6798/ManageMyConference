/**
 * Sending a scheduled report's expiring link.
 *
 * **A link, never a rendered report.** Two reasons, and the second is the one that decided the
 * shape. A report can carry personal data, and a message sits in a mailbox for ever while a link
 * expires and can be revoked — so the recipient is sent an address rather than a copy. And
 * queueing a message through the communications domain would need a new
 * `communication_deliveries.trigger_type`, which is a pinned `CHECK` and therefore a table
 * rebuild in a block another lane is working in; keeping delivery here is what lets scheduled
 * reports ship without reaching into that.
 *
 * The trade, stated rather than hidden: these sends do **not** appear in the communications
 * history, do not share its retry ladder, and are recorded only in `report_runs`. That is the
 * right record for "did the report go out", and it is the wrong one for "what has this person
 * been sent" — folding scheduled reports into the outbox is the follow-up, and it belongs in a
 * lane that owns the communications block.
 *
 * Provider-neutral in the same shape the emailed sign-in code uses: one configured endpoint, one
 * bearer token, and a payload that never enters an application contract.
 *
 * @spec PRD-OPS-004
 */
import type { ReportDeliveryPort } from "../../application/platform/public";

export interface ReportMailConfiguration {
  readonly endpoint: string;
  readonly token: string;
}

export function createReportLinkDelivery(
  configuration: ReportMailConfiguration | null,
  send: typeof fetch = fetch,
): ReportDeliveryPort {
  return {
    async deliver(delivery) {
      if (!configuration)
        // Thrown rather than swallowed: the scheduler records the run as `failed` with this
        // message, which is what an operator reads when somebody says the report never arrived.
        // A silent success would make an unconfigured deployment look like a working one.
        throw new Error("Scheduled report delivery is not configured on this deployment");
      const response = await send(configuration.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuration.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: [...delivery.recipients],
          subject: `${delivery.reportName} — scheduled report`,
          // The body is a link and an expiry, and deliberately no rows: whatever the report says
          // stays behind the link, where revoking it still means something.
          text:
            `${delivery.reportName} is ready.\n\n${delivery.url}\n\n` +
            `This link stops working at ${delivery.expiresAt}.`,
        }),
      });
      if (!response.ok) throw new Error(`Report delivery provider returned ${response.status}`);
    },
  };
}
