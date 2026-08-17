/**
 * Organization API-client administration. The plaintext credential is rendered only once.
 *
 * Granting a scope to a machine credential is the most consequential form somebody fills in on
 * this console: nobody is watching what the credential does afterwards. So the form prints what
 * each capability *lets the holder do* rather than the token it is stored as — `crm:manage` beside
 * a tick box never said that private notes travel with it — and it groups them by the part of the
 * product they open, because thirteen ungrouped tick boxes are read as one decision.
 */
import { type FormEvent, useCallback, useState } from "react";
import { describeApiFailure } from "../api/config";
import {
  createApiClient,
  listApiClients,
  revokeApiClient,
  rotateApiClient,
} from "../api/api-clients";
import "../styles/identity.css";
import { Checkbox, CopyableSecret, DateTimeField, Field } from "../ui/fields";
import { IconKey, IconShield } from "../ui/icons";
import {
  Card,
  Drawer,
  EmptyState,
  LoadFailure,
  Notice,
  Pill,
  Section,
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "../ui/primitives";
import {
  CAPABILITY_TERMS,
  capabilityLabel,
  GRANTABLE_CAPABILITIES,
  groupCapabilities,
} from "../ui/vocabulary";
import type { HubTabModule, WorkspaceModule } from "./contract";

/** How many scopes a row prints before the rest go behind a disclosure. */
const CHIPS_SHOWN = 3;

const describe = (reason: unknown) =>
  describeApiFailure(reason, "The API-client service did not answer.").message;

/** Whether a credential can still be used, which is what "Status" is actually about. */
function clientState(client: { revokedAt: string | null; expiresAt: string | null }) {
  if (client.revokedAt) return { label: "Revoked", tone: "neutral" as const, usable: false };
  if (client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now())
    return { label: "Expired", tone: "neutral" as const, usable: false };
  return { label: "Active", tone: "ok" as const, usable: true };
}

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
  const [credential, setCredential] = useState<{ value: string; of: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The client a Revoke press is asking about. Revoking cannot be undone from anywhere. */
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  /*
   * A demo persona genuinely cannot hold a durable credential — the secret is hashed and shown
   * once, so there is nothing for a throwaway session to own. What this surface used to render
   * beside that refusal was a permanently disabled "Create API client" with no handler behind
   * it at all: a control that could never act, in a workspace whose only purpose is that
   * action. It is replaced by the way out (#206).
   */
  if (!realSession)
    return (
      <Section labelledBy="api-clients-demo" title="API clients">
        {/* The refusal and the way out are one thing to read. They were two blocks — a warning
            band, then a loose sentence under it at body size — so the answer to "what do I do
            about this" sat outside the box that raised the question. */}
        <Notice tone="warn" role="status">
          <span>
            API clients require a signed-in organizer account. Demo identities are temporary, so
            they cannot safely own credentials. <a href="/">Sign in with Google</a> to create,
            rotate, or revoke API credentials for this organization.
          </span>
        </Notice>
      </Section>
    );
  if (clients.error)
    return <LoadFailure what="the API clients" error={clients.error} onRetry={clients.reload} />;
  if (!clients.data)
    return (
      <Card>
        <SkeletonRows rows={3} label="Loading the API clients" />
      </Card>
    );

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
      setCredential({ value: created.credential, of: created.client.name });
      setName("");
      await clients.reload();
      announce("success", `Created ${created.client.name}.`);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  }

  async function run(message: string, of: string, action: () => Promise<unknown>) {
    setBusy(true);
    setCredential(null);
    try {
      const result = await action();
      if (result && typeof result === "object" && "credential" in result)
        setCredential({ value: String(result.credential), of });
      await clients.reload();
      announce("success", message);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="members">
      {feedback}
      <Section
        labelledBy="api-clients-create"
        title="Create API client"
        description="The client is limited to this event and the capabilities you tick."
      >
        <form className="stack" onSubmit={submit}>
          <Field label="Client name" id="api-client-name" required>
            {(control) => (
              <input
                {...control}
                className="control"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>

          {/*
            Grouped, and each box says what granting it does. The form used to print the storage
            token — `events:settings:update` — beside an unlabelled tick, which asks somebody to
            authorise an act this product has a sentence for and refuses to say.
          */}
          <Field label="Capabilities" labelAs="group">
            {(_control, labelId) => (
              // biome-ignore lint/a11y/useSemanticElements: `Field` already renders this group's caption and its id; a <fieldset> here would add a second grouping semantic, and its default min-inline-size: min-content stops the grid track shrinking.
              <div role="group" aria-labelledby={labelId} className="stack">
                {groupCapabilities(GRANTABLE_CAPABILITIES).map((group) => (
                  <div key={group.title} className="stack">
                    <h3>{group.title}</h3>
                    {group.scopes.map((scope) => {
                      const term = CAPABILITY_TERMS[scope];
                      return (
                        <Checkbox
                          key={scope}
                          label={
                            term.sensitive ? (
                              <span className="inline">
                                {term.label}
                                <Pill tone="warn">Personal data</Pill>
                              </span>
                            ) : (
                              term.label
                            )
                          }
                          hint={term.consequence}
                          checked={scopes.includes(scope)}
                          onChange={(checked) =>
                            setScopes((current) =>
                              checked
                                ? [...current, scope]
                                : current.filter((value) => value !== scope),
                            )
                          }
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </Field>

          <DateTimeField
            label="Expires at"
            hint="Optional. Leave it empty and the credential works until it is revoked."
            value={expiresAt}
            onChange={setExpiresAt}
          />
          <div className="toolbar">
            <button className="primary" type="submit" disabled={busy || scopes.length === 0}>
              Create client
            </button>
          </div>
        </form>

        {credential ? (
          <Notice
            tone="info"
            role="status"
            title={`Copy ${credential.of}'s credential now`}
            onDismiss={() => setCredential(null)}
            dismissLabel="I have stored the credential"
          >
            {/* Shown once and stored only as a hash, so it gets a copy affordance rather than a
                <code> a reader has to select by dragging. */}
            <CopyableSecret
              label="API credential"
              value={credential.value}
              hint="It is stored as a hash. Nothing here or anywhere else can show it again."
            />
          </Notice>
        ) : null}
      </Section>

      <Section labelledBy="api-clients-list" title="API clients">
        {clients.data.clients.length === 0 ? (
          <EmptyState icon={<IconShield size={20} />} title="No API clients">
            Create a least-privilege client above.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">API clients in this organization</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Prefix</th>
                  <th scope="col">Can do</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {clients.data.clients.map((client) => {
                  const state = clientState(client);
                  const shown = client.scopes.slice(0, CHIPS_SHOWN);
                  const rest = client.scopes.slice(CHIPS_SHOWN);
                  return (
                    <tr key={client.id}>
                      <td className="primary-cell" data-label="Name">
                        {client.name}
                      </td>
                      <td data-label="Prefix">
                        <code className="figure">grn_{client.keyPrefix}</code>
                      </td>
                      {/* Three chips and a count: a client holding nine scopes used to print a
                          comma-joined line of raw tokens wider than the column. */}
                      <td data-label="Can do">
                        {shown.map((scope) => (
                          <Pill key={scope} tone="neutral">
                            {capabilityLabel(scope)}
                          </Pill>
                        ))}
                        {rest.length ? (
                          <details className="hint">
                            <summary>+{rest.length} more</summary>
                            <ul className="plain-list">
                              {rest.map((scope) => (
                                <li key={scope}>{capabilityLabel(scope)}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </td>
                      <td data-label="Status">
                        <Pill tone={state.tone}>{state.label}</Pill>
                      </td>
                      <td data-label="Actions" className="member-actions">
                        <button
                          type="button"
                          className="secondary small"
                          disabled={busy || !state.usable}
                          onClick={() =>
                            // ERROR-INTENT: event handlers cannot await; run reports every failure.
                            void run(`Rotated ${client.name}.`, client.name, () =>
                              rotateApiClient(organizationId, client.id),
                            )
                          }
                        >
                          Rotate
                          <span className="visually-hidden"> {client.name}</span>
                        </button>
                        {/* Held apart from Rotate, and asks first: revoking is immediate,
                            permanent, and breaks whatever is using the credential right now. */}
                        <button
                          type="button"
                          className="danger small member-remove"
                          disabled={busy || Boolean(client.revokedAt)}
                          onClick={() => setRevoking({ id: client.id, name: client.name })}
                        >
                          Revoke
                          <span className="visually-hidden"> {client.name}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Drawer
        open={revoking !== null}
        title={revoking ? `Revoke ${revoking.name}?` : "Revoke this client"}
        busy={busy}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <button
              type="button"
              className="danger primary"
              disabled={busy}
              onClick={() => {
                const target = revoking;
                if (!target) return;
                setRevoking(null);
                // ERROR-INTENT: handlers cannot await; run reports both outcomes.
                void run(`Revoked ${target.name}.`, target.name, () =>
                  revokeApiClient(organizationId, target.id),
                );
              }}
            >
              Revoke the credential
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setRevoking(null)}
            >
              Keep it
            </button>
          </>
        }
      >
        <p>
          Every request carrying this credential starts failing immediately, including whatever is
          using it right now. Revoking cannot be undone and the credential cannot be reissued —
          rotating gives the same client a new secret instead.
        </p>
      </Drawer>
    </div>
  );
}

export const apiClientsWorkspace: WorkspaceModule = {
  domain: "identity-access",
  path: "/integrations/api-clients",
  label: "API clients",
  group: "reach",
  order: 5.8,
  icon: <IconKey />,
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

/** Identity-owned half of Settings > Integrations; #237 composes same-tab contributions. */
export const apiClientsHubTab: HubTabModule = {
  domain: "identity-access",
  hub: "settings",
  tab: "integrations",
  label: "Integrations",
  order: 40,
  personas: ["organizer"],
  legacyPaths: ["/integrations/api-clients"],
  canAccess: (access) => apiClientsWorkspace.canAccess?.(access) ?? false,
  header: () => ({
    eyebrow: "Settings",
    title: "Integrations",
    subtitle: "Manage least-privilege API access and signed outbound connections.",
  }),
  render: apiClientsWorkspace.render,
};
