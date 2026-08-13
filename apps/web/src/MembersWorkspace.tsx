/**
 * Who belongs to this organization, who has been invited, and what has been done to either.
 *
 * The surface issue #12 was missing. An organizer could create an event and then had no way to
 * add a reviewer or a co-organizer to it; this is where that happens, and where the identity
 * audit log becomes something a person can read rather than a table.
 *
 * Two things about the shape are deliberate. The invitation link is shown **once**, immediately
 * after it is created, because the API answers the token once and stores only its digest — there
 * is no screen that can show it again, and saying so beats letting somebody discover it. And the
 * audit log is a plain reverse-chronological list rather than a filterable timeline: the
 * cross-domain timeline is issue #99's, and half of one here would be the thing #99 has to
 * unpick.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import { type FormEvent, useCallback, useState } from "react";
import {
  inviteMember,
  listAuditEvents,
  listMembers,
  MembershipApiError,
  type MembersResponse,
  removeMember,
  revokeEventRole,
  revokeInvitation,
  setEventRole,
} from "./api/membership";
import "./styles/identity.css";
import { Card, EmptyState, Notice, useActionFeedback, useLoad } from "./ui/primitives";

type Role = "organizer" | "reviewer" | "speaker";
const ROLES: Role[] = ["organizer", "reviewer", "speaker"];

const describe = (reason: unknown) =>
  reason instanceof MembershipApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

const when = (iso: string) => new Date(iso).toLocaleString();

/** The action vocabulary, in words rather than in its storage form. */
const ACTIONS: Record<string, string> = {
  "session.issued": "Signed in",
  "session.signed_out": "Signed out",
  "session.revoked_all": "Signed out everywhere",
  "membership.invited": "Invited",
  "membership.invitation_revoked": "Withdrew an invitation",
  "membership.accepted": "Accepted an invitation",
  "membership.removed": "Removed a member",
  "membership.role_changed": "Changed a role",
  "event_role.granted": "Granted an event role",
  "event_role.revoked": "Revoked an event role",
};

export function MembersWorkspace({
  organizationId,
  eventId,
}: {
  organizationId: string;
  eventId: string;
}) {
  const { announce, node: feedback } = useActionFeedback();
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("reviewer");
  const [scope, setScope] = useState<"organization" | "event">("event");
  const [busy, setBusy] = useState(false);

  const members = useLoad<string, MembersResponse>(
    organizationId,
    useCallback((id: string) => listMembers(id), []),
    describe,
  );
  const audit = useLoad(
    organizationId,
    useCallback((id: string) => listAuditEvents(id), []),
    describe,
  );

  const refresh = async () => {
    await Promise.all([members.reload(), audit.reload()]);
  };

  /** Every mutation takes this path, so one place owns busy state, feedback and reloading. */
  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  async function submitInvitation(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setIssuedToken(null);
    try {
      const created = await inviteMember(organizationId, {
        email,
        role,
        ...(scope === "event" ? { eventId } : {}),
      });
      setIssuedToken(created.token);
      setEmail("");
      await refresh();
      announce("success", `Invited ${created.invitation.email}.`);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  }

  if (members.loading && !members.data) return <Card>Loading members…</Card>;
  if (members.error) return <Notice tone="error">{members.error}</Notice>;

  const data = members.data;
  const pending = (data?.invitations ?? []).filter(
    (invitation) => !invitation.acceptedAt && !invitation.revokedAt,
  );

  return (
    <div className="members">
      {feedback}

      <Card title="Invite somebody">
        <form onSubmit={submitInvitation} className="stack">
          <label>
            Email address
            <input
              type="email"
              required
              value={email}
              onChange={(changed) => setEmail(changed.target.value)}
            />
          </label>
          <label>
            Role
            <select value={role} onChange={(changed) => setRole(changed.target.value as Role)}>
              {ROLES.map((name) => (
                <option key={name} value={name}>
                  {name.charAt(0).toUpperCase() + name.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Scope
            <select
              value={scope}
              onChange={(changed) => setScope(changed.target.value as "organization" | "event")}
            >
              <option value="event">This event only</option>
              <option value="organization">The whole organization</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>
            Send invitation
          </button>
        </form>

        {/*
          Shown once, and labelled as such. The API answers the token exactly once and keeps only
          its digest, so there is no later screen that could show it again — leaving that
          unexplained would look like a bug the first time somebody reloaded.
        */}
        {issuedToken ? (
          <Notice tone="info">
            <strong>Copy this invitation link now.</strong> It is shown once and cannot be retrieved
            again; withdraw the invitation and send another if it is lost.
            <br />
            <code className="invitation-link">{`${window.location.origin}/invitations/accept?token=${issuedToken}`}</code>
          </Notice>
        ) : null}
      </Card>

      <Card title="Members">
        {data && data.members.length > 0 ? (
          <div className="table-wrap">
            <table className="members-table">
              <caption className="visually-hidden">
                Members of this organization and their roles on its events
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Event roles</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => (
                  <tr key={member.userId}>
                    <td data-label="Name">{member.name}</td>
                    <td data-label="Email">{member.email ?? "—"}</td>
                    <td data-label="Event roles">
                      {member.eventRoles.length > 0
                        ? member.eventRoles.map(({ role: held }) => held).join(", ")
                        : "None"}
                    </td>
                    <td className="member-actions" data-label="Actions">
                      <select
                        aria-label={`Grant a role on this event to ${member.name}`}
                        defaultValue=""
                        disabled={busy}
                        onChange={(changed) => {
                          const chosen = changed.target.value as Role;
                          changed.target.value = "";
                          // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                          if (chosen)
                            void run(`Granted ${chosen} to ${member.name}.`, () =>
                              setEventRole(organizationId, eventId, member.userId, chosen),
                            );
                        }}
                      >
                        <option value="">Grant a role…</option>
                        {ROLES.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      {member.eventRoles
                        .filter(({ eventId: held }) => held === eventId)
                        .map(({ role: held }) => (
                          <button
                            key={held}
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() =>
                              // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                              void run(`Revoked ${held} from ${member.name}.`, () =>
                                revokeEventRole(
                                  organizationId,
                                  eventId,
                                  member.userId,
                                  held as Role,
                                ),
                              )
                            }
                          >
                            Revoke {held}
                          </button>
                        ))}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                          void run(`Removed ${member.name}.`, () =>
                            removeMember(organizationId, member.userId),
                          )
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Nobody else is here yet">
            Invite a co-organizer or a reviewer above, and they will appear once they accept.
          </EmptyState>
        )}
      </Card>

      <Card title="Outstanding invitations">
        {pending.length > 0 ? (
          <ul className="invitation-list">
            {pending.map((invitation) => (
              <li key={invitation.id}>
                {invitation.email} — {invitation.role}
                {invitation.eventId ? " on this event" : " in the organization"}, expires{" "}
                {when(invitation.expiresAt)}{" "}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                    void run(`Withdrew the invitation to ${invitation.email}.`, () =>
                      revokeInvitation(organizationId, invitation.id),
                    )
                  }
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No invitations are outstanding">
            Everything sent has been accepted or withdrawn.
          </EmptyState>
        )}
      </Card>

      <Card title="Recent identity activity">
        {audit.error ? <Notice tone="error">{audit.error}</Notice> : null}
        {audit.data && audit.data.events.length > 0 ? (
          <div className="table-wrap">
            <table className="members-table">
              <caption className="visually-hidden">
                Identity actions recorded for this organization, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.events.map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="When">{when(entry.occurredAt)}</td>
                    <td data-label="Action">{ACTIONS[entry.action] ?? entry.action}</td>
                    <td data-label="Outcome">
                      {entry.outcome === "refused" ? "Refused" : "Succeeded"}
                    </td>
                    <td data-label="Reference">
                      <code>{entry.correlationId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Nothing recorded yet">
            Invitations, membership changes and role grants appear here as they happen.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
