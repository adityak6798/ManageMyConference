/** Anonymous report capability-link viewer. @spec PRD-OPS-004 */
import { type FormEvent, useEffect, useState } from "react";
import { type PublicReportResponse, ReportApiError, resolvePublicReport } from "./api/reports";
import "./styles.css";
import { Card, Notice, PageHeader } from "./ui/primitives";

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
  const token = tokenFromPath();

  const load = async (event?: FormEvent) => {
    event?.preventDefault();
    setLoading(true);
    setError(null);
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

  return (
    <main className="page-body">
      <PageHeader
        title={report?.report.name ?? "Shared report"}
        subtitle={report?.report.description}
      />
      {error ? (
        <Card title="Open this report">
          <Notice tone="error">{error}</Notice>
          <form onSubmit={load}>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button type="submit" disabled={loading || !token}>
              {loading ? "Opening…" : "Open report"}
            </button>
          </form>
        </Card>
      ) : report ? (
        <Card
          title="Result"
          hint={`${report.result.rows.length} of ${report.result.totalRows} rows`}
        >
          <div className="table-wrap">
            <table className="data">
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
        </Card>
      ) : (
        <p role="status">Opening report…</p>
      )}
    </main>
  );
}
