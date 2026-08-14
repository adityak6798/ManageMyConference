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
 * @spec PRD-OPS-004 PRD-IAM-002
 */
import { type FormEvent, useCallback, useMemo, useState } from "react";
import {
  createReportSchedule,
  createReportShare,
  deleteReport,
  listReportSchedules,
  listReportShares,
  listReports,
  readReportCatalogue,
  type ReportCatalogue,
  ReportApiError,
  reportExportUrl,
  type ReportRunResponse,
  type ReportSchedulesResponse,
  type ReportSharesResponse,
  type ReportsResponse,
  revokeReportShare,
  runReport,
  saveReport,
} from "./api/reports";
import "./styles/identity.css";
import { Card, EmptyState, Notice, Pill, useActionFeedback, useLoad } from "./ui/primitives";

const describe = (reason: unknown) =>
  reason instanceof ReportApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

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

interface Filter {
  field: string;
  operator: string;
  value: string;
}

export function ReportsWorkspace({
  eventId,
  canReadPii,
}: {
  eventId: string;
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

  if (catalogue.loading && !catalogue.data) return <Card>Loading the report catalogue…</Card>;
  if (catalogue.error) return <Notice tone="error">{catalogue.error}</Notice>;
  const cat = catalogue.data;
  if (!cat) return <Card>Loading the report catalogue…</Card>;

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
              ...(operator === "is-empty" || operator === "is-not-empty" ? {} : { value }),
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

  return (
    <div className="members">
      {feedback}

      <Card
        title="Ask a question"
        hint="Every dataset is authorized by the domain that owns it, so a report shows exactly what your role can already open."
      >
        <form className="stack" onSubmit={run}>
          <label>
            Dataset
            <select
              value={activeDataset?.key ?? ""}
              onChange={(changed) => {
                setDataset(changed.target.value);
                setFields([]);
                setFilters([]);
                setGroupBy("");
                setResult(null);
              }}
            >
              {cat.datasets.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Columns</legend>
            {(activeDataset?.fields ?? []).map((field) => (
              <label key={field.key} className="inline">
                <input
                  type="checkbox"
                  checked={fields.length === 0 || fields.includes(field.key)}
                  onChange={(changed) =>
                    setFields((current) => {
                      const all = (activeDataset?.fields ?? []).map((entry) => entry.key);
                      const base = current.length === 0 ? all : current;
                      return changed.target.checked
                        ? [...new Set([...base, field.key])]
                        : base.filter((key) => key !== field.key);
                    })
                  }
                />
                {field.label}
                {field.pii ? <Pill tone="warn">Personal</Pill> : null}
              </label>
            ))}
          </fieldset>
          {filters.map((filter, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a filter row has no identity but its position
            <div key={index} className="actions">
              <select
                value={filter.field}
                onChange={(changed) =>
                  setFilters((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, field: changed.target.value } : entry,
                    ),
                  )
                }
              >
                <option value="">Choose a field</option>
                {(activeDataset?.fields ?? []).map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </select>
              <select
                value={filter.operator}
                onChange={(changed) =>
                  setFilters((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, operator: changed.target.value } : entry,
                    ),
                  )
                }
              >
                {cat.operators.map((operator) => (
                  <option key={operator} value={operator}>
                    {OPERATOR_LABEL[operator] ?? operator}
                  </option>
                ))}
              </select>
              {filter.operator !== "is-empty" && filter.operator !== "is-not-empty" ? (
                <input
                  value={filter.value}
                  aria-label="Filter value"
                  onChange={(changed) =>
                    setFilters((current) =>
                      current.map((entry, at) =>
                        at === index ? { ...entry, value: changed.target.value } : entry,
                      ),
                    )
                  }
                />
              ) : null}
              <button
                type="button"
                onClick={() => setFilters((current) => current.filter((_, at) => at !== index))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="actions">
            <button
              type="button"
              disabled={filters.length >= 12}
              onClick={() =>
                setFilters((current) => [...current, { field: "", operator: "equals", value: "" }])
              }
            >
              Add a filter
            </button>
          </div>
          <label>
            Group by
            <select value={groupBy} onChange={(changed) => setGroupBy(changed.target.value)}>
              <option value="">No grouping</option>
              {(activeDataset?.fields ?? []).map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
          </label>
          {canReadPii ? (
            <label className="inline">
              <input
                type="checkbox"
                checked={includePii}
                onChange={(changed) => setIncludePii(changed.target.checked)}
              />
              Show personal data unmasked — recorded in the audit timeline
            </label>
          ) : (
            <p className="hint">
              Personal columns are masked. Unmasking needs the <code>reports:pii</code> capability,
              and is recorded in the audit timeline when it is used.
            </p>
          )}
          <div className="actions">
            <button type="submit" disabled={busy}>
              Run
            </button>
            <input
              aria-label="Report name"
              placeholder="Name to save as"
              value={name}
              onChange={(changed) => setName(changed.target.value)}
            />
            <button
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
                        ...(operator === "is-empty" || operator === "is-not-empty"
                          ? {}
                          : { value }),
                      })),
                    ...(groupBy ? { groupBy } : {}),
                    ...(selected
                      ? {
                          reportId: selected,
                          expectedRevision:
                            saved.data?.reports.find((entry) => entry.id === selected)?.revision ??
                            1,
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
      </Card>

      {result ? <ReportResult result={result} /> : null}

      {selected && result?.state === "ok" ? (
        <Card title="Export" hint="A format applied to the run above — never a second query.">
          <div className="actions">
            {(["csv", "xlsx", "json"] as const).map((format) => (
              <a
                key={format}
                href={reportExportUrl(eventId, selected, format, includePii)}
                download
              >
                Download {format.toUpperCase()}
              </a>
            ))}
          </div>
        </Card>
      ) : null}

      {selected ? (
        <Card
          title="Share links"
          hint="A link resolves live data under its own policy. Revoking it is the whole of revoking access."
        >
          {issuedUrl ? (
            <Notice tone="info">
              This link is shown once: <code>{issuedUrl}</code>
            </Notice>
          ) : null}
          <div className="actions">
            <button
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
            <ul>
              {shares.shares.map((share) => (
                <li key={share.id}>
                  Expires {new Date(share.expiresAt).toLocaleString()} · {share.views} views
                  {share.viewLimit ? ` of ${share.viewLimit}` : ""}
                  {share.allowPii ? <Pill tone="warn">Unmasked</Pill> : null}
                  {share.revokedAt ? (
                    <Pill tone="neutral">Revoked</Pill>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act("Share link revoked.", async () => {
                          await revokeReportShare(eventId, selected, share.id);
                          setShares(await listReportShares(eventId, selected));
                        })
                      }
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No links yet">
              A link carries an expiry, an optional view limit and an optional password, and can be
              revoked at any time.
            </EmptyState>
          )}
        </Card>
      ) : null}

      {selected ? (
        <Card
          title="Scheduled delivery"
          hint="Recipients are sent an expiring link rather than a copy of the rows."
        >
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act("Schedule created.", async () => {
                  await createReportSchedule(eventId, selected, {
                    cadence: "weekly",
                    minuteOfDay: 8 * 60,
                    dayOfWeek: 1,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    recipients: [],
                  });
                  setSchedules(await listReportSchedules(eventId, selected));
                })
              }
            >
              Schedule weekly (Mondays, 08:00)
            </button>
          </div>
          {schedules && schedules.schedules.length > 0 ? (
            <ul>
              {schedules.schedules.map(({ schedule, runs }) => (
                <li key={schedule.id}>
                  {schedule.cadence} at{" "}
                  {String(Math.floor(schedule.minuteOfDay / 60)).padStart(2, "0")}:
                  {String(schedule.minuteOfDay % 60).padStart(2, "0")} {schedule.timezone} ·{" "}
                  {schedule.recipients.length} recipients
                  {runs.length > 0 ? (
                    <span className="sub">
                      Last run {new Date(runs[0]?.ranAt ?? "").toLocaleString()} —{" "}
                      {runs[0]?.outcome}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Not scheduled">
              A schedule fires once per occurrence in the event's timezone, and records every run.
            </EmptyState>
          )}
        </Card>
      ) : null}

      <Card title="Saved reports">
        {saved.data && saved.data.reports.length > 0 ? (
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
                  <tr key={report.id}>
                    <td className="primary-cell" data-label="Report">
                      {report.name}
                    </td>
                    <td data-label="Dataset">{report.dataset}</td>
                    <td data-label="Actions">
                      <button type="button" disabled={busy} onClick={() => openSaved(report.id)}>
                        Open
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          act("Report deleted.", async () => {
                            await deleteReport(eventId, report.id, report.revision);
                            if (selected === report.id) {
                              setSelected(null);
                              setResult(null);
                            }
                          })
                        }
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No saved reports">
            Build a question above and save it. A saved report stores the question, never the
            answer, so it is re-run under the reader's own access every time.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}

function ReportResult({ result }: { result: ReportRunResponse }) {
  if (result.state === "unauthorized")
    return (
      <Notice tone="warn">
        Your role cannot read this dataset. That is the authorization model working — the report
        itself is fine.
      </Notice>
    );
  if (result.state === "failed") return <Notice tone="error">{result.error.message}</Notice>;
  const { fields, rows, totalRows, groups, meta } = result.result;
  return (
    <Card title="Result" hint={`${rows.length} of ${totalRows} rows · scanned ${meta.scannedRows}`}>
      {meta.maskedFields.length > 0 ? (
        <Notice tone="info">
          Masked here: {meta.maskedFields.join(", ")}. A masked value is what you are shown, not
          what the record holds.
        </Notice>
      ) : null}
      {groups.length > 0 ? (
        <ul>
          {groups.map((group) => (
            <li key={group.value}>
              {group.value} · {group.count}
            </li>
          ))}
        </ul>
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
        <EmptyState title="No rows matched">
          Nothing in this dataset satisfies every filter. Widen one and run again.
        </EmptyState>
      ) : null}
    </Card>
  );
}
