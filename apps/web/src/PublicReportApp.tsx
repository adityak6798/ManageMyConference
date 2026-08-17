/**
 * Anonymous report capability-link viewer.
 *
 * It is a public page, so it wears the public shell rather than the console's. That is not only
 * consistency: importing `styles.css` here put the entire organizer stylesheet — the shell, every
 * workspace, the command palette — into the entry chunk that an attendee downloads to read a
 * schedule. The two public stylesheets it loads instead are the same ones the event pages load.
 *
 * @spec PRD-OPS-004
 */
import { type FormEvent, useEffect, useState } from "react";
import { type PublicReportResponse, ReportApiError, resolvePublicReport } from "./api/reports";
import "./public-event.css";
import "./styles/public-pages.css";
import { Field } from "./ui/fields";

/**
 * The shape of the report that is coming, rather than the word "Loading".
 *
 * Declared here rather than imported from the event pages' `cards.tsx`: a shared report belongs
 * to `platform` and those pages to `publishing`, and five spans are not worth a cross-domain
 * import. The classes are the shared ones, so the two look identical.
 */
function ReportSkeleton() {
  return (
    <div className="pub-skeleton" role="status" aria-label="Opening the shared report">
      <span className="pub-skeleton-bar is-title" aria-hidden="true" />
      <span className="pub-skeleton-bar is-short" aria-hidden="true" />
      <span className="pub-skeleton-bar" aria-hidden="true" />
      <span className="pub-skeleton-bar" aria-hidden="true" />
    </div>
  );
}

const initialRequests = new Map<string, Promise<PublicReportResponse>>();
const initialReport = (token: string) => {
  const existing = initialRequests.get(token);
  if (existing) return existing;
  const request = resolvePublicReport(token);
  initialRequests.set(token, request);
  return request;
};

const tokenFromPath = () => {
  const match = window.location.pathname.match(/^\/reports\/([^/]+)\/?$/);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // ERROR-INTENT: malformed capability paths are rendered as unavailable below.
    return "";
  }
};

export function PublicReportApp() {
  const [password, setPassword] = useState("");
  const [report, setReport] = useState<PublicReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * Whether a password has actually been tried yet.
   *
   * The API refuses an unknown token, a revoked one, an expired one and a protected one
   * identically and on purpose — telling them apart would say whether a guessed token named a
   * real report. So the first refusal cannot be reported as a failure: needing a password is the
   * expected state of a protected link, and a red alert over it says the reader did something
   * wrong by opening a link somebody sent them. After they answer, a refusal *is* news.
   */
  const [attempted, setAttempted] = useState(false);
  const token = tokenFromPath();

  const load = async (event?: FormEvent) => {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setAttempted(true);
    try {
      setReport(await resolvePublicReport(token, password || undefined));
    } catch (reason) {
      setError(
        reason instanceof ReportApiError ? reason.message : "That report link is not available.",
      );
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolving spends a view; password keystrokes must not spend more.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    // StrictMode replays mount effects. Both mounts share one spending request so a finite-view
    // capability is consumed exactly once, while a password submission remains an explicit retry.
    // ERROR-INTENT: the effect owns completion through the attached success and failure handlers.
    void initialReport(token)
      .then((result) => {
        if (active) setReport(result);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof ReportApiError
              ? reason.message
              : "That report link is not available.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const shell = (children: React.ReactNode) => (
    <div className="public-shell">
      <header>
        <a className="brand" href="/">
          Greenroom
        </a>
      </header>
      <main>{children}</main>
      <footer>
        <p>Shared from Project Greenroom. This link shows one report, as it stands now.</p>
      </footer>
    </div>
  );

  if (error)
    return shell(
      <article className="pub-detail">
        <div className="pub-head">
          <h1>{attempted ? "That did not open the report" : "This report needs a password"}</h1>
          <p className="pub-tz">
            {attempted
              ? "Check the password with whoever shared the link. A link can also expire, be revoked, or run out of views, and all four refusals look the same from here."
              : "Shared reports can be protected. Enter the password you were given to open it."}
          </p>
        </div>
        {/* Only after an attempt: the first refusal is the expected state of a protected link,
            not a failure to report. */}
        {attempted ? (
          <p className="pub-notice is-error" role="alert">
            {error}
          </p>
        ) : null}
        <form className="pub-form" onSubmit={load}>
          <div className="pub-form-field">
            <Field label="Password" id="report-password">
              {(control) => (
                <input
                  {...control}
                  className="control"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="pub-form-actions">
            <button className="primary" type="submit" disabled={loading || !token}>
              {loading ? "Opening…" : "Open report"}
            </button>
          </div>
        </form>
      </article>,
    );

  if (!report) return shell(<ReportSkeleton />);

  return shell(
    <article className="pub-detail pub-report">
      <div className="pub-head">
        <h1>{report.report.name}</h1>
        {report.report.description ? <p className="pub-tz">{report.report.description}</p> : null}
        <p className="pub-count">
          <span className="figure">
            {report.result.rows.length} / {report.result.totalRows}
          </span>{" "}
          rows shown
        </p>
      </div>
      <div className="pub-table-wrap">
        <table className="pub-table">
          <thead>
            <tr>
              {report.result.fields.map((field) => (
                <th key={field.key}>{field.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.result.rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: shared report rows have no identity.
              <tr key={index}>
                {report.result.fields.map((field) => (
                  <td key={field.key} data-label={field.label}>
                    {row[field.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>,
  );
}
