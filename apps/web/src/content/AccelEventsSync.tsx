/*
 * The organizer surface for the Accelevents registration sync (#58).
 *
 * Before this existed the feature had no surface at all: `accelevents` was an enum value and a
 * `CHECK` constraint. The panel answers the three questions an organizer actually has — is this
 * connected, what would it do, and what did it last do — and it answers the first one honestly:
 * `mode` is on screen, so nobody reads "3 imported" from the in-repository fixture roster and
 * believes their registration platform was contacted.
 *
 * It lives beside the CSV import because it is the same job without the file.
 */
import {
  type AccelEventsIntegrationDto,
  accelEventsIntegrationSchema,
  type AccelEventsSyncReportDto,
  accelEventsSyncReportSchema,
  type ApiErrorEnvelope,
} from "@greenroom/contracts";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { apiFetch, decodeResponse } from "../api/config";
import { Notice, useActionFeedback } from "../ui/primitives";
import type { Run } from "./shared";

/*
 * The client lives here rather than in its own module because this component is its only
 * consumer, and every module in `apps/web/src` is one more request the dev server serves on
 * every route — including the public event page, whose resource budget
 * `lifecycle-demo.spec.ts` enforces. A one-consumer client is not worth a file.
 *
 * The endpoints are served by the communications-integrations route module, which owns the port,
 * the credential and the last-run state. The split is deliberate and is described in
 * `PRD-INT-001`: the integration is communications', the surface and what it produces are
 * content's.
 */
class IntegrationApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

const decode = <T,>(response: Response, schema: z.ZodType<T>): Promise<T> =>
  decodeResponse(response, schema, (envelope) => new IntegrationApiError(envelope));

/** The Accelevents integration's state and its last apply. */
const getAccelEventsIntegration = async (eventId: string): Promise<AccelEventsIntegrationDto> =>
  decode(
    await apiFetch(`/api/events/${encodeURIComponent(eventId)}/integrations/accelevents`),
    accelEventsIntegrationSchema,
  );

/**
 * Preview or apply the registration sync.
 *
 * `commit: false` writes nothing — not into content, not into the last-run record — so the
 * organizer can see exactly what would happen before anything does.
 */
const syncAccelEvents = async (
  eventId: string,
  commit: boolean,
): Promise<AccelEventsSyncReportDto> =>
  decode(
    await apiFetch(`/api/events/${encodeURIComponent(eventId)}/integrations/accelevents/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit }),
    }),
    accelEventsSyncReportSchema,
  );

const DISPOSITION_LABEL: Record<AccelEventsSyncReportDto["rows"][number]["disposition"], string> = {
  create: "Will import",
  skip: "Already imported",
  invalid: "Not imported",
};

export function AccelEventsSync({
  eventId,
  busy,
  run,
}: {
  eventId: string;
  busy: boolean;
  run: Run;
}) {
  const feedback = useActionFeedback();
  const [integration, setIntegration] = useState<AccelEventsIntegrationDto | null>(null);
  const [report, setReport] = useState<AccelEventsSyncReportDto | null>(null);

  // Read once on mount, and again after an apply, because the apply is what changes it.
  useEffect(() => {
    let live = true;
    // ERROR-INTENT: an unreadable integration renders as "never run" rather than taking the
    // workspace down; the apply below reports its own failures where the organizer is looking.
    void getAccelEventsIntegration(eventId)
      .then((value) => live && setIntegration(value))
      .catch(() => live && setIntegration(null));
    return () => {
      live = false;
    };
  }, [eventId]);

  function sync(commit: boolean) {
    if (busy) return;
    let next: AccelEventsSyncReportDto | null = null;
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(async () => {
      next = await syncAccelEvents(eventId, commit);
      if (commit) setIntegration(await getAccelEventsIntegration(eventId));
    }).then((result) => {
      if (!result.ok || !next) {
        // The registration platform being unreachable is the failure state this panel exists to
        // make visible, so it is said here rather than left to a console.
        feedback.announce(
          "error",
          commit
            ? "The sync could not be applied. The last run below shows what happened."
            : "The registration platform could not be read.",
        );
        return;
      }
      const value = next as AccelEventsSyncReportDto;
      // An apply clears the preview rather than replacing it, so the next import is again gated
      // behind a fresh look at what it would do. Keeping the apply's own report here would leave
      // Import enabled forever after the first one.
      setReport(value.preview ? value : null);
      feedback.announce(
        value.invalid ? "error" : "success",
        commit
          ? `Imported ${value.created}, skipped ${value.skipped} already present, ${value.invalid} could not be imported.`
          : `Preview only — nothing was written. ${value.created} would be imported, ${value.skipped} already present, ${value.invalid} invalid.`,
      );
    });
  }

  const lastRun = integration?.lastRun ?? null;
  // No Card of its own: this renders inside a tool disclosure that already carries the heading
  // and the one-way hint (#144). A nested card here would draw a second border around them.
  return (
    <>
      {feedback.node}
      {integration ? (
        <Notice tone={integration.mode === "live" ? "success" : "warn"}>
          {integration.mode === "live"
            ? "Reading the live Accelevents registration platform."
            : "Demo mode — preview uses a sample registration list and does not contact Accelevents."}
        </Notice>
      ) : null}
      <p className="sub">
        {lastRun
          ? `Last run ${new Date(lastRun.completedAt).toLocaleString()} — ${
              lastRun.outcome === "succeeded"
                ? `${lastRun.created} imported, ${lastRun.skipped} already present, ${lastRun.invalid} invalid`
                : `failed (${lastRun.errorCode ?? "unknown"})`
            }`
          : "This integration has never been applied."}
      </p>
      <div className="row-actions">
        <button className="secondary" type="button" onClick={() => sync(false)} disabled={busy}>
          Preview registrations
        </button>
        {/* Apply is offered only after a preview: nothing writes to the roster from a surface
            the organizer has not first seen the consequences on. */}
        <button
          className="primary"
          type="button"
          onClick={() => sync(true)}
          disabled={busy || !report}
        >
          Import registrants
        </button>
      </div>
      {report ? (
        <>
          <Notice tone={report.invalid ? "warn" : "success"}>
            {report.preview ? "Preview — nothing written. " : "Applied. "}
            {report.total} registrants · {report.created}{" "}
            {report.preview ? "to import" : "imported"} · {report.skipped} already present ·{" "}
            {report.invalid} invalid
          </Notice>
          <ul>
            {report.rows.map((row) => (
              <li key={row.sourceRef || row.email}>
                {row.name || "Unnamed"} · {row.email || "No email"} ·{" "}
                {DISPOSITION_LABEL[row.disposition]}
                {row.errors.length ? ` — ${row.errors.join("; ")}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
