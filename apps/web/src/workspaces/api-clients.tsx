/** Organization API-client administration. The plaintext credential is rendered only once. */
import { type FormEvent, useCallback, useState } from "react";
import {
  ApiClientsApiError,
  createApiClient,
  listApiClients,
  revokeApiClient,
  rotateApiClient,
} from "../api/api-clients";
import "../styles/identity.css";
import { IconSettings } from "../ui/icons";
import { Card, EmptyState, Notice, useActionFeedback, useLoad } from "../ui/primitives";
import type { WorkspaceModule } from "./contract";

const CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "communications:manage",
  "agenda:manage",
  "crm:manage",
  "content:read",
  "content:manage",
  "review:manage",
  "review:evaluate",
  "identity:manage",
] as const;

const describe = (reason: unknown) =>
  reason instanceof ApiClientsApiError
    ? `${reason.message} Reference: ${reason.envelope.error.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

export function ApiClientsWorkspace({
  organizationId,
  eventId,
  realSession,
}: {
  organizationId: string;
  eventId: string;
  realSession: boolean;
}) {
  const { announce, node: feedback } = useActionFeedback();
  const clients = useLoad(
    organizationId,
    useCallback(
      (id: string) => (realSession ? listApiClients(id) : Promise.resolve({ clients: [] })),
      [realSession],
    ),
    describe,
  );
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["events:read"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [credential, setCredential] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!realSession)
    return (
      <Card title="Create API client">
        <Notice tone="warn">
          API clients can be administered only from a real organizer session. Demo personas cannot
          create durable credentials.
        </Notice>
        <button type="button" disabled>
          Create API client
        </button>
      </Card>
    );
  if (clients.loading && !clients.data) return <Card>Loading API clients…</Card>;
  if (clients.error) return <Notice tone="error">{clients.error}</Notice>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setCredential(null);
    try {
      const created = await createApiClient(organizationId, {
        name,
        scopes,
        eventIds: [eventId],
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      setCredential(created.credential);
      setName("");
      await clients.reload();
      announce("success", `Created ${created.client.name}.`);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  }

  async function run(message: string, action: () => Promise<unknown>) {
    setBusy(true);
    setCredential(null);
    try {
      const result = await action();
      if (result && typeof result === "object" && "credential" in result)
        setCredential(String(result.credential));
      await clients.reload();
      announce("success", message);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copyCredential() {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(credential);
      announce("success", "API credential copied to the clipboard.");
    } catch {
      // ERROR-INTENT: clipboard access can be blocked; the credential remains visible and
      // selectable beside this keyboard-operable control for a manual copy.
      announce("error", "Copying was blocked. Select the credential and copy it manually.");
    }
  }

  return (
    <div className="members">
      {feedback}
      <Card
        title="Create API client"
        hint="The client is limited to this event and selected capabilities."
      >
        <form className="stack" onSubmit={submit}>
          <label>
            Client name
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Capabilities</legend>
            <div className="stack">
              {CAPABILITIES.map((capability) => (
                <label key={capability}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(capability)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, capability]
                          : current.filter((value) => value !== capability),
                      )
                    }
                  />{" "}
                  {capability}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Expires at (optional)
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || scopes.length === 0}>
            Create client
          </button>
        </form>
        {credential ? (
          <Notice tone="info" role="status">
            <strong>Copy this credential now. It is shown once.</strong>
            <code className="invitation-link">{credential}</code>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                // ERROR-INTENT: event handlers cannot await; copyCredential announces failures.
                void copyCredential();
              }}
            >
              Copy credential
            </button>
          </Notice>
        ) : null}
      </Card>
      <Card title="API clients">
        {(clients.data?.clients.length ?? 0) === 0 ? (
          <EmptyState title="No API clients">Create a least-privilege client above.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="members-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Scopes</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {clients.data?.clients.map((client) => (
                  <tr key={client.id}>
                    <td data-label="Name">{client.name}</td>
                    <td data-label="Prefix">
                      <code>grn_{client.keyPrefix}</code>
                    </td>
                    <td data-label="Scopes">{client.scopes.join(", ")}</td>
                    <td data-label="Status">
                      {client.revokedAt
                        ? "Revoked"
                        : client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now()
                          ? "Expired"
                          : "Active"}
                    </td>
                    <td data-label="Actions" className="member-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          busy ||
                          Boolean(client.revokedAt) ||
                          Boolean(
                            client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now(),
                          )
                        }
                        onClick={() =>
                          // ERROR-INTENT: event handlers cannot await; run reports every failure.
                          void run(`Rotated ${client.name}.`, () =>
                            rotateApiClient(organizationId, client.id),
                          )
                        }
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || Boolean(client.revokedAt)}
                        onClick={() =>
                          // ERROR-INTENT: event handlers cannot await; run reports every failure.
                          void run(`Revoked ${client.name}.`, () =>
                            revokeApiClient(organizationId, client.id),
                          )
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export const apiClientsWorkspace: WorkspaceModule = {
  domain: "identity-access",
  path: "/integrations/api-clients",
  label: "API clients",
  group: "Audience",
  order: 5.8,
  icon: <IconSettings size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("identity:manage") && (session?.organizations.length ?? 0) > 0,
  header: () => ({
    eyebrow: "Integrations",
    title: "API clients",
    subtitle: "Create, rotate, and revoke least-privilege machine credentials.",
  }),
  render: ({ event, session }) => (
    <ApiClientsWorkspace
      organizationId={event.organizationId}
      eventId={event.id}
      realSession={session?.authentication === "session"}
    />
  ),
};
