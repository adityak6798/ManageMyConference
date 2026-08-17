/**
 * Asking one event a bounded question, and sharing the answer.
 *
 * The builder offers exactly what the server's catalogue advertises — datasets, their fields,
 * their comparisons — so a control that appears is a query that will run. That is the whole
 * reason the catalogue is a response rather than a constant in this file: a screen offering a
 * field the service refuses is a form that fails on submit with nothing to point at.
 *
 * **Masked columns are named, not blanked.** A field this reader's role and PII decision withheld
 * shows a masked value and is listed under the table, because a blank cell says "there is no
 * address" while the truth is "you are not being shown it".
 *
 * **Export is a link.** It carries the same `includePii` the run did, and the server refuses it
 * on the same terms — a download can never contain a column this screen did not show.
 *
 * **A schedule fires in the event's zone.** The empty state has always promised that; the create
 * button used to send the *reader's* zone, so an organizer in Berlin scheduling a Pacific event
 * created a delivery nine hours away from the one the screen described. The zone is now a
 * parameter of this workspace, printed beside the control that commits it.
 *
 * @spec PRD-OPS-004 PRD-IAM-002
 */
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { describeApiFailure } from "./api/config";
import {
  createReportSchedule,
  createReportShare,
  deleteReport,
  deleteReportSchedule,
  listReportSchedules,
  listReportShares,
  listReports,
  type ReportCatalogue,
  type ReportRunResponse,
  type ReportSchedulesResponse,
  type ReportSharesResponse,
  type ReportsResponse,
  readReportCatalogue,
  reportExportUrl,
  revokeReportShare,
  runReport,
  saveReport,
} from "./api/reports";
import "./styles/identity.css";
import "./styles/reports.css";
import { Checkbox, CopyableSecret, Field, Select } from "./ui/fields";
import { IconClock, IconDashboard, IconLink, IconSearch } from "./ui/icons";
import {
  Card,
  Drawer,
  EmptyState,
  GutterList,
  GutterRow,
  LoadFailure,
  Notice,
  Pill,
  Section,
  SkeletonForm,
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "./ui/primitives";
import { REPORT_DATASET_LABELS } from "./ui/vocabulary";

const describe = (reason: unknown) =>
  describeApiFailure(reason, "The reporting service did not answer.").message;

const OPERATOR_LABEL: Record<string, string> = {
  equals: "is",
  "not-equals": "is not",
  contains: "contains",
  "starts-with": "starts with",
  "greater-than": "is after or above",
  "less-than": "is before or below",
  "is-empty": "is empty",
  "is-not-empty": "is not empty",
};

/** The two comparisons that take no value, so the row drops its value box rather than ignoring it. */
const VALUELESS = new Set(["is-empty", "is-not-empty"]);

interface Filter {
  field: string;
  operator: string;
  value: string;
}

/** The weekly slot every schedule this screen creates fires in, named once so both readers agree. */
const WEEKLY_SLOT = { cadence: "weekly", minuteOfDay: 8 * 60, dayOfWeek: 1 } as const;

const clockOf = (minuteOfDay: number) =>
  `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;

export function ReportsWorkspace({
  eventId,
  timezone,
  canReadPii,
}: {
  eventId: string;
  /** The event's zone. A schedule fires in it, so it is never read from the reader's browser. */
  timezone: string;
  /** Whether to offer the unmasking control. The API refuses it regardless. */
  canReadPii: boolean;
}) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  /**
   * Empty until the catalogue arrives, and then whatever the catalogue's first dataset is.
   *
   * Not a hardcoded default: a deployment whose catalogue does not advertise the dataset this
   * file happened to name would render a builder with no columns, no filters and no explanation
   * of why. The server decides what can be asked; this only decides which question is open first.
   */
  const [dataset, setDataset] = useState<string>("");
  const [fields, setFields] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [groupBy, setGroupBy] = useState("");
  const [includePii, setIncludePii] = useState(false);
  const [result, setResult] = useState<ReportRunResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [shares, setShares] = useState<ReportSharesResponse | null>(null);
  const [schedules, setSchedules] = useState<ReportSchedulesResponse | null>(null);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scheduleRecipients, setScheduleRecipients] = useState("");
  /**
   * The report a Delete press is asking about.
   *
   * Deleting a report takes its share links and its schedules with it, and neither the rows nor
   * the links come back. The press opens this rather than doing it.
   */
  const [deleting, setDeleting] = useState<{ id: string; name: string; revision: number } | null>(
    null,
  );
  /**
   * The other two irreversible acts on this surface, and what they are about.
   *
   * Revoking a share link and removing a standing delivery are as final as deleting the report
   * — the address never resolves again, and the recipient list is gone with the schedule — but
   * both fired on the press while the six deletions around them asked first. A red button that
   * acts immediately teaches a reader that red buttons on this console are safe to try.
   */
  const [confirming, setConfirming] = useState<
    | { kind: "share"; reportId: string; id: string; expires: string }
    | { kind: "schedule"; reportId: string; id: string; at: string }
    | null
  >(null);

  const catalogue = useLoad<string, ReportCatalogue>(
    eventId,
    useCallback((id: string) => readReportCatalogue(id), []),
    describe,
  );
  const saved = useLoad<string, ReportsResponse>(
    eventId,
    useCallback((id: string) => listReports(id), []),
    describe,
  );

  const activeDataset = useMemo(
    () =>
      catalogue.data?.datasets.find((entry) => entry.key === dataset) ??
      catalogue.data?.datasets[0],
    [catalogue.data, dataset],
  );

  if (catalogue.error)
    return (
      <LoadFailure what="the report catalogue" error={catalogue.error} onRetry={catalogue.reload} />
    );
  const cat = catalogue.data;
  if (!cat)
    return (
      <Card>
        <SkeletonForm fields={4} label="Loading the report catalogue" />
      </Card>
    );

  const datasetFields = activeDataset?.fields ?? [];
  const selectedReport = saved.data?.reports.find((entry) => entry.id === selected) ?? null;

  const run = async (formEvent?: FormEvent) => {
    formEvent?.preventDefault();
    setBusy(true);
    try {
      setResult(
        await runReport(eventId, {
          // The resolved key, so a first run before anybody touched the picker asks about the
          // dataset the screen is actually showing.
          dataset: activeDataset?.key ?? dataset,
          fields,
          filters: filters
            .filter((filter) => filter.field && filter.operator)
            .map(({ field, operator, value }) => ({
              field,
              operator,
              ...(VALUELESS.has(operator) ? {} : { value }),
            })),
          ...(groupBy ? { groupBy } : {}),
          includePii,
        }),
      );
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const openSaved = async (reportId: string) => {
    const report = saved.data?.reports.find((entry) => entry.id === reportId);
    if (!report) return;
    setSelected(reportId);
    setDataset(report.dataset);
    setFields([...report.query.fields]);
    setFilters(
      report.query.filters.map((filter) => ({
        field: filter.field,
        operator: filter.operator,
        value: filter.value ?? "",
      })),
    );
    setGroupBy(report.query.groupBy ?? "");
    setName(report.name);
    // A share address belongs to the report that issued it; carrying one across a selection
    // would offer the previous report's link under this report's name.
    setIssuedUrl(null);
    setBusy(true);
    try {
      const [ran, sharesResponse, schedulesResponse] = await Promise.all([
        runReport(eventId, { reportId, includePii }),
        listReportShares(eventId, reportId),
        listReportSchedules(eventId, reportId),
      ]);
      setResult(ran);
      setShares(sharesResponse);
      setSchedules(schedulesResponse);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const act = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await saved.reload();
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Whether this report already has the standing weekly delivery this screen offers.
   *
   * The button only ever creates one shape of schedule, so pressing it twice used to create two
   * identical deliveries — the same rows, to the same people, at the same minute — which nothing
   * on the screen distinguished afterwards.
   */
  const duplicateSchedule = (schedules?.schedules ?? []).some(
    ({ schedule }) =>
      schedule.cadence === WEEKLY_SLOT.cadence &&
      schedule.minuteOfDay === WEEKLY_SLOT.minuteOfDay &&
      schedule.timezone === timezone,
  );

  const recipientList = scheduleRecipients
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);

  return (
    <div className="members reports">
      {feedback}

      <Section
        labelledBy="reports-build"
        title="Build a report"
        description="A report only includes information your role can already view."
      >
        <form className="stack" onSubmit={run}>
          <Select
            label="Dataset"
            value={activeDataset?.key ?? null}
            onChange={(next) => {
              setDataset(next);
              setFields([]);
              setFilters([]);
              setGroupBy("");
              setResult(null);
            }}
            options={cat.datasets.map((entry) => ({ value: entry.key, label: entry.label }))}
          />

          <Field
            label="Columns"
            labelAs="group"
            hint="Every column is included until you narrow it."
          >
            {(_control, labelId) => (
              // biome-ignore lint/a11y/useSemanticElements: `Field` already renders this group's caption and its id; a <fieldset> here would add a second grouping semantic, and its default min-inline-size: min-content stops the grid track shrinking.
              <div className="report-columns" aria-labelledby={labelId} role="group">
                {datasetFields.map((field) => (
                  <Checkbox
                    key={field.key}
                    label={
                      <span className="report-column-label">
                        {field.label}
                        {field.pii ? <Pill tone="warn">Personal</Pill> : null}
                      </span>
                    }
                    checked={fields.length === 0 || fields.includes(field.key)}
                    onChange={(checked) =>
                      setFields((current) => {
                        const all = datasetFields.map((entry) => entry.key);
                        const base = current.length === 0 ? all : current;
                        return checked
                          ? [...new Set([...base, field.key])]
                          : base.filter((key) => key !== field.key);
                      })
                    }
                  />
                ))}
              </div>
            )}
          </Field>

          {/*
            One row per condition, on a real grid.
            Before this the row was a bare `.actions` div with no rule behind it, so three
            controls stacked full-width with no gap and the Remove button — the least
            consequential control on the builder — rendered as the widest thing on it.
          */}
          {filters.map((filter, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a filter row has no identity but its position
            <div key={index} className="report-filter">
              <span className="report-filter-connector" aria-hidden="true">
                {index === 0 ? "where" : "and"}
              </span>
              <Select
                label={`Field for condition ${index + 1}`}
                labelHidden
                placeholder="Choose a field"
                value={filter.field || null}
                onChange={(next) =>
                  setFilters((current) =>
                    current.map((entry, at) => (at === index ? { ...entry, field: next } : entry)),
                  )
                }
                options={datasetFields.map((field) => ({ value: field.key, label: field.label }))}
              />
              <Select
                label={`Comparison for condition ${index + 1}`}
                labelHidden
                value={filter.operator || null}
                onChange={(next) =>
                  setFilters((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, operator: next } : entry,
                    ),
                  )
                }
                options={cat.operators.map((operator) => ({
                  value: operator,
                  label: OPERATOR_LABEL[operator] ?? operator,
                }))}
              />
              {VALUELESS.has(filter.operator) ? (
                <p className="report-filter-void">no value needed</p>
              ) : (
                <input
                  className="control"
                  value={filter.value}
                  aria-label={`Value for condition ${index + 1}`}
                  onChange={(changed) =>
                    setFilters((current) =>
                      current.map((entry, at) =>
                        at === index ? { ...entry, value: changed.target.value } : entry,
                      ),
                    )
                  }
                />
              )}
              {/*
                Not danger ink. Dropping a condition from a query nobody has run costs a press of
                "Add a condition" to undo, and it was the only red control on this console that
                destroyed nothing — which is what made the two beside it that *are* irreversible
                look equally safe. Danger is now reserved for the acts that ask first.
              */}
              <button
                className="ghost small report-filter-remove"
                type="button"
                onClick={() => setFilters((current) => current.filter((_, at) => at !== index))}
              >
                Remove
                <span className="visually-hidden"> condition {index + 1}</span>
              </button>
            </div>
          ))}
          <div className="report-filter-actions">
            <button
              type="button"
              className="secondary"
              disabled={filters.length >= 12}
              onClick={() =>
                setFilters((current) => [...current, { field: "", operator: "equals", value: "" }])
              }
            >
              Add a condition
            </button>
          </div>

          {/* "No grouping" is the first option, so it is a selected value rather than a
              placeholder: passed as `null` the trigger showed the right answer in the ink this
              product reserves for an empty field. */}
          <Select
            label="Group by"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "", label: "No grouping" },
              ...datasetFields.map((field) => ({ value: field.key, label: field.label })),
            ]}
          />

          {canReadPii ? (
            <Checkbox
              label="Show unmasked personal data (this action is recorded)"
              hint="Names, addresses and phone numbers appear in full, and the export carries them too."
              checked={includePii}
              onChange={setIncludePii}
            />
          ) : (
            <p className="hint">
              Personal columns are masked. Ask an administrator for personal-data report access if
              you need to view them.
            </p>
          )}

          <div className="report-run">
            <button className="primary" type="submit" disabled={busy}>
              Run
            </button>
          </div>

          <div className="report-save-row">
            <Field label="Report name" labelHidden>
              {(control) => (
                <input
                  {...control}
                  className="control"
                  placeholder="Report name"
                  value={name}
                  onChange={(changed) => setName(changed.target.value)}
                />
              )}
            </Field>
            <button
              className="secondary"
              type="button"
              disabled={busy || !name.trim()}
              onClick={() =>
                act("Report saved.", async () => {
                  const savedReport = await saveReport(eventId, {
                    name,
                    dataset: activeDataset?.key ?? dataset,
                    fields,
                    filters: filters
                      .filter((filter) => filter.field)
                      .map(({ field, operator, value }) => ({
                        field,
                        operator,
                        ...(VALUELESS.has(operator) ? {} : { value }),
                      })),
                    ...(groupBy ? { groupBy } : {}),
                    ...(selected
                      ? {
                          reportId: selected,
                          expectedRevision: selectedReport?.revision ?? 1,
                        }
                      : {}),
                  });
                  setSelected(savedReport.report.id);
                })
              }
            >
              {selected ? "Save changes" : "Save report"}
            </button>
          </div>
        </form>
      </Section>

      {result ? <ReportResult result={result} /> : null}

      {selected && result?.state === "ok" ? (
        <Section
          labelledBy="reports-export"
          title="Export"
          description="A format applied to the run above — never a second query."
        >
          <div className="toolbar">
            {(["csv", "xlsx", "json"] as const).map((format) => (
              <a
                key={format}
                className="btn secondary"
                href={reportExportUrl(eventId, selected, format, includePii)}
                download
              >
                Download {format.toUpperCase()}
              </a>
            ))}
          </div>
        </Section>
      ) : null}

      {selected ? (
        <Section
          labelledBy="reports-shares"
          title="Share links"
          description="A link resolves live data under its own policy. Revoking it is the whole of revoking access."
        >
          {issuedUrl ? (
            <Notice
              tone="info"
              title="Copy this address now"
              onDismiss={() => setIssuedUrl(null)}
              dismissLabel="I have copied the share address"
            >
              {/* Only the digest is stored, so this is the one moment the address exists on a
                  screen. It gets a copy button rather than a <code> nobody can select cleanly. */}
              <CopyableSecret label="Share address" value={issuedUrl} />
              Anybody holding it sees this report's live rows until it expires or is revoked.
            </Notice>
          ) : null}
          <div className="toolbar">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                act("Share link created.", async () => {
                  const created = await createReportShare(eventId, selected, {
                    lifetimeHours: 72,
                    ...(includePii && canReadPii ? { allowPii: true } : {}),
                  });
                  setIssuedUrl(created.url);
                  setShares(await listReportShares(eventId, selected));
                })
              }
            >
              Create a 72-hour link
            </button>
          </div>
          {shares && shares.shares.length > 0 ? (
            <GutterList label="Share links on this report">
              {shares.shares.map((share) => (
                <GutterRow
                  key={share.id}
                  measure={share.views}
                  measureLabel="Views so far"
                  title={`Expires ${new Date(share.expiresAt).toLocaleString()}`}
                  meta={
                    <>
                      {share.views}
                      {share.viewLimit ? ` of ${share.viewLimit}` : ""} views
                      {share.allowPii ? " · unmasked" : ""}
                    </>
                  }
                  status={
                    share.allowPii ? <Pill tone="warn">Unmasked</Pill> : <Pill tone="ok">Live</Pill>
                  }
                  actions={
                    share.revokedAt ? (
                      <Pill tone="neutral">Revoked</Pill>
                    ) : (
                      <button
                        className="danger small"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setConfirming({
                            kind: "share",
                            reportId: selected,
                            id: share.id,
                            expires: new Date(share.expiresAt).toLocaleString(),
                          })
                        }
                      >
                        Revoke
                        <span className="visually-hidden"> this share link</span>
                      </button>
                    )
                  }
                />
              ))}
            </GutterList>
          ) : (
            <EmptyState icon={<IconLink size={20} />} title="No links yet">
              A link carries an expiry, an optional view limit and an optional password, and can be
              revoked at any time.
            </EmptyState>
          )}
        </Section>
      ) : null}

      {selected ? (
        <Section
          labelledBy="reports-schedules"
          title="Scheduled delivery"
          description="Recipients are sent an expiring link rather than a copy of the rows."
        >
          <Field
            label="Recipients"
            hint="Separate up to 20 email addresses with commas."
            id="report-schedule-recipients"
          >
            {(control) => (
              <input
                {...control}
                className="control"
                type="text"
                value={scheduleRecipients}
                onChange={(event) => setScheduleRecipients(event.target.value)}
                placeholder="ops@example.com, producer@example.com"
              />
            )}
          </Field>
          <div className="toolbar">
            <button
              className="secondary"
              type="button"
              disabled={busy || duplicateSchedule || recipientList.length === 0}
              onClick={() =>
                act("Schedule created.", async () => {
                  await createReportSchedule(eventId, selected, {
                    ...WEEKLY_SLOT,
                    // The event's zone, which is what the line beside this button names.
                    timezone,
                    recipients: recipientList,
                  });
                  setSchedules(await listReportSchedules(eventId, selected));
                  setScheduleRecipients("");
                })
              }
            >
              Schedule weekly (Mondays, 08:00)
            </button>
            <p className="hint">
              {duplicateSchedule
                ? "This report already goes out every Monday at 08:00. Remove that schedule to change who receives it."
                : `Fires at 08:00 ${timezone}, the event's own zone.`}
            </p>
          </div>
          {schedules && schedules.schedules.length > 0 ? (
            <GutterList label="Standing deliveries for this report">
              {schedules.schedules.map(({ schedule, runs }) => (
                <GutterRow
                  key={schedule.id}
                  measure={clockOf(schedule.minuteOfDay)}
                  measureLabel="Fires at"
                  title={`${schedule.cadence === "weekly" ? "Every Monday" : schedule.cadence} · ${schedule.timezone}`}
                  meta={`${schedule.recipients.length} ${schedule.recipients.length === 1 ? "recipient" : "recipients"}${
                    runs.length > 0
                      ? ` · last run ${new Date(runs[0]?.ranAt ?? "").toLocaleString()} — ${runs[0]?.outcome}`
                      : " · not yet run"
                  }`}
                  actions={
                    <button
                      className="danger small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setConfirming({
                          kind: "schedule",
                          reportId: selected,
                          id: schedule.id,
                          at: clockOf(schedule.minuteOfDay),
                        })
                      }
                    >
                      Remove
                      <span className="visually-hidden">
                        {" "}
                        the {clockOf(schedule.minuteOfDay)} schedule
                      </span>
                    </button>
                  }
                />
              ))}
            </GutterList>
          ) : (
            <EmptyState icon={<IconClock size={20} />} title="Not scheduled">
              A schedule fires once per occurrence in {timezone}, the event's own zone, and records
              every run.
            </EmptyState>
          )}
        </Section>
      ) : null}

      <Section labelledBy="reports-saved" title="Saved reports">
        {saved.error ? (
          <LoadFailure what="the saved reports" error={saved.error} onRetry={saved.reload} />
        ) : !saved.data ? (
          <SkeletonRows rows={3} label="Loading the saved reports" />
        ) : saved.data.reports.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">Saved reports on this event</caption>
              <thead>
                <tr>
                  <th scope="col">Report</th>
                  <th scope="col">Dataset</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {saved.data.reports.map((report) => (
                  <tr key={report.id} aria-selected={report.id === selected ? true : undefined}>
                    <td className="primary-cell" data-label="Report">
                      {report.name}
                    </td>
                    <td data-label="Dataset">
                      {REPORT_DATASET_LABELS[report.dataset] ?? report.dataset}
                    </td>
                    <td data-label="Actions">
                      <div className="report-row-actions">
                        <button
                          className="secondary small"
                          type="button"
                          disabled={busy}
                          onClick={() => openSaved(report.id)}
                        >
                          Open
                        </button>
                        {/* Separated from Open, and asks before it acts: deleting takes the
                            report's share links and schedules with it and none of them return. */}
                        <button
                          className="danger small"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setDeleting({
                              id: report.id,
                              name: report.name,
                              revision: report.revision,
                            })
                          }
                        >
                          Delete
                          <span className="visually-hidden"> {report.name}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<IconDashboard size={20} />} title="No saved reports">
            Build a report above and give it a name to use it again later.
          </EmptyState>
        )}
      </Section>

      <Drawer
        open={confirming !== null}
        title={
          confirming?.kind === "schedule"
            ? `Stop the ${confirming.at} delivery?`
            : "Revoke this share link?"
        }
        busy={busy}
        onClose={() => setConfirming(null)}
        footer={
          <>
            <button
              type="button"
              className="danger primary"
              disabled={busy}
              onClick={() => {
                const target = confirming;
                if (!target) return;
                setConfirming(null);
                /*
                 * Both irreversible acts this drawer confirms are started here, and the branch
                 * chooses the operation rather than the discard: one `void`, so the intent below
                 * covers both arms. Written as two `void act(…)` statements, the second sat two
                 * lines past this comment and `tools/check-errors.mjs` read it as an unexplained
                 * discard — the gate is adjacency-scoped on purpose.
                 *
                 * ERROR-INTENT: handlers cannot await; `act` announces both outcomes.
                 */
                void (target.kind === "share"
                  ? act("Share link revoked.", async () => {
                      await revokeReportShare(eventId, target.reportId, target.id);
                      setShares(await listReportShares(eventId, target.reportId));
                    })
                  : act("Schedule removed.", async () => {
                      await deleteReportSchedule(eventId, target.reportId, target.id);
                      setSchedules(await listReportSchedules(eventId, target.reportId));
                    }));
              }}
            >
              {confirming?.kind === "schedule" ? "Remove the schedule" : "Revoke the link"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              {confirming?.kind === "schedule" ? "Keep sending it" : "Keep it working"}
            </button>
          </>
        }
      >
        {confirming?.kind === "schedule" ? (
          <p>
            Nobody receives this report at {confirming.at} again, and the recipient list goes with
            the schedule. Scheduling it again asks for those addresses from scratch.
          </p>
        ) : (
          <p>
            The address stops resolving immediately for everybody holding it, including anybody
            reading it right now, and it cannot be reinstated — it would have expired
            {confirming ? ` ${confirming.expires}` : ""}. A new link is a new address to hand out.
          </p>
        )}
      </Drawer>

      <Drawer
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete this report"}
        busy={busy}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button
              type="button"
              className="danger primary"
              disabled={busy}
              onClick={() => {
                const target = deleting;
                if (!target) return;
                setDeleting(null);
                // ERROR-INTENT: handlers cannot await; `act` announces both outcomes.
                void act(`Deleted ${target.name}.`, async () => {
                  await deleteReport(eventId, target.id, target.revision);
                  if (selected === target.id) {
                    setSelected(null);
                    setResult(null);
                    setShares(null);
                    setSchedules(null);
                  }
                });
              }}
            >
              Delete the report
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Keep it
            </button>
          </>
        }
      >
        <p>
          Every share link issued from this report stops resolving, and any standing weekly delivery
          stops being sent. Neither the report nor its links can be restored.
        </p>
      </Drawer>
    </div>
  );
}

function ReportResult({ result }: { result: ReportRunResponse }) {
  if (result.state === "unauthorized")
    return (
      <Notice tone="warn" role="status">
        Your role does not include access to this information. Choose another dataset or ask an
        administrator for access.
      </Notice>
    );
  if (result.state === "failed") return <Notice tone="error">{result.error.message}</Notice>;
  const { fields, rows, totalRows, groups, meta } = result.result;
  return (
    <Card labelledBy="reports-result" title="Result" hint={`${rows.length} of ${totalRows} rows`}>
      {meta.maskedFields.length > 0 ? (
        <Notice tone="info" role="status">
          Masked here: {meta.maskedFields.join(", ")}. A masked value is what you are shown, not
          what the record holds.
        </Notice>
      ) : null}
      {groups.length > 0 ? (
        <GutterList label="Grouped counts">
          {groups.map((group) => (
            <GutterRow
              key={group.value}
              measure={group.count}
              measureLabel="Rows"
              title={group.value}
            />
          ))}
        </GutterList>
      ) : null}
      <div className="table-wrap">
        <table className="data">
          <caption className="visually-hidden">Report result</caption>
          <thead>
            <tr>
              {fields.map((field) => (
                <th scope="col" key={field.key}>
                  {field.label}
                  {meta.maskedFields.includes(field.key) ? <Pill tone="warn">Masked</Pill> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a result row has no stable identity
              <tr key={index}>
                {fields.map((field) => (
                  <td key={field.key} data-label={field.label}>
                    {row[field.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<IconSearch size={20} />} title="No rows matched">
          Nothing in this dataset satisfies every condition. Widen one and run again.
        </EmptyState>
      ) : null}
    </Card>
  );
}
