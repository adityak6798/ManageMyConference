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
 * Every write on this page is somebody else's access, so none of them happens on a value change.
 * A grant is chosen from a menu and a removal is confirmed by name; see `run` and `removing`.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import { type FormEvent, useCallback, useState } from "react";
import {
  inviteMember,
  listAuditEvents,
  listMembers,
  type MembersResponse,
  removeMember,
  revokeEventRole,
  revokeInvitation,
  setEventRole,
} from "./api/membership";
import { describeApiFailure } from "./api/config";
import "./styles/identity.css";
import { Select } from "./ui/fields";
import { IconClock, IconSend, IconSpeakers } from "./ui/icons";
import { Menu } from "./ui/menu";
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
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "./ui/primitives";
import { humanizeKey } from "./ui/vocabulary";

type Role = "organizer" | "reviewer" | "speaker";
const ROLES: Role[] = ["organizer", "reviewer", "speaker"];
type Member = MembersResponse["members"][number];

/**
 * What each role lets somebody do, in the words the product uses elsewhere.
 *
 * Not `CAPABILITY_TERMS`: a role is a bundle of capabilities and the reader granting one is
 * deciding about the bundle. The consequence sentence is what makes "Grant a role" a decision
 * rather than a picklist.
 */
const ROLE_TERMS: Record<Role, { label: string; consequence: string }> = {
  organizer: {
    label: "Organizer",
    consequence: "Runs the event: settings, programme, people and access.",
  },
  reviewer: {
    label: "Reviewer",
    consequence: "Scores the submissions assigned to them, and sees no others.",
  },
  speaker: {
    label: "Speaker",
    consequence: "Opens the speaker portal for their own sessions and profile.",
  },
};
const roleLabel = (role: string) => ROLE_TERMS[role as Role]?.label ?? humanizeKey(role);

/*
 * The reference travels beside the sentence, never inside it.
 *
 * This used to answer "…could not be saved. Reference: 01JD…", which buries the one value the
 * reader is asked to quote in the one part of the message nobody reads character by character.
 * `Notice`, `LoadFailure` and `useActionFeedback` all take an `ApiFailure` and render its
 * reference as a selectable measure with its own copy control.
 */
const describe = (reason: unknown) =>
  describeApiFailure(
    reason,
    "Something went wrong. Please retry; if it continues, contact support.",
  );

/* The exact expiry, beside the rounded one in the gutter. No seconds: `toLocaleString()` prints
   them, and an invitation that expires at 11:00:00 does not expire more precisely than 11:00. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Whole days between now and an expiry, rounded up, floored at zero.
 *
 * The measure an invitation row is about. Rounded *up* so an invitation with four hours left
 * reads "1d" rather than "0d": zero is reserved for one that has run out, which the list should
 * not be holding but can, between the expiry and the next reload.
 */
const daysLeft = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

/** The audit stamp as a measure: date over time, so the gutter column reads as a run sheet. */
const auditDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/* `h23` rather than the locale's own cycle: "05:00 AM" is eight characters and the measure
   column is 56px wide, so a 12-hour clock is a figure that wraps out of its own gutter. */
const auditTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

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
  /** The member a removal has been offered for, held until it is confirmed by name. */
  const [removing, setRemoving] = useState<Member | null>(null);

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

  if (members.loading && !members.data)
    return (
      <Card>
        <SkeletonRows rows={4} label="Loading the member list" />
      </Card>
    );
  if (members.error)
    return (
      <LoadFailure
        what="the member list"
        error={members.error}
        reference={members.reference}
        onRetry={members.reload}
      />
    );

  const data = members.data;
  const pending = (data?.invitations ?? []).filter(
    (invitation) => !invitation.acceptedAt && !invitation.revokedAt,
  );

  return (
    /* A reload over a member list already on screen is a busy region, not a second spinner: the
       page stays readable and `[aria-busy]` says it is working. */
    <div className="members" aria-busy={members.isRefreshing || undefined}>
      {feedback}

      <Card title="Invite somebody">
        <form onSubmit={submitInvitation} className="member-invite-form">
          {/* A `.field`, like the two listboxes beside it: the hand-rolled `<label>` wrapper this
              replaces set its own caption gap, so the three captions on one row did not sit on
              one line. */}
          <div className="field">
            <label htmlFor="member-invite-email">Email address</label>
            <input
              className="control"
              id="member-invite-email"
              type="email"
              required
              value={email}
              onChange={(changed) => setEmail(changed.target.value)}
            />
          </div>
          {/*
            Scope first, because it decides what the role control may offer.
            An organization invitation grants membership, and membership is only ever the
            organizer role — that is what `organization_memberships` stores, and the contract
            refuses any other combination. Offering `reviewer` beside "the whole organization"
            would have built a request the API always answers 400 to, so the control offers what
            can succeed instead of validating after the fact.

            Both are the shared listbox rather than native selects. Nothing here depends on the
            native element — the clamp is state, and the disabled state is a prop — and a control
            the operating system drew, at its own height and with its own chevron, beside the
            email input the product drew was the mismatch that made this form look assembled.
            The role's consequence sentence rides along as each option's hint, which an
            `<option>` had nowhere to put.
          */}
          <Select
            label="Scope"
            value={scope}
            onChange={(chosen) => {
              setScope(chosen as "organization" | "event");
              if (chosen === "organization") setRole("organizer");
            }}
            options={[
              { value: "event", label: "This event only" },
              { value: "organization", label: "The whole organization" },
            ]}
          />
          <Select
            label="Role"
            value={role}
            onChange={(chosen) => setRole(chosen as Role)}
            disabled={scope === "organization"}
            options={(scope === "organization" ? (["organizer"] as Role[]) : ROLES).map((name) => ({
              value: name,
              label: ROLE_TERMS[name].label,
              hint: ROLE_TERMS[name].consequence,
            }))}
          />
          {/* The clamp is explained across the whole form rather than under the one control, so a
              two-line sentence cannot stretch a 0.7fr column past the two beside it. */}
          {scope === "organization" ? (
            <p className="hint">
              Organization membership is the organizer role. Invite somebody to this event instead
              to make them a reviewer or a speaker.
            </p>
          ) : null}
          <button className="primary member-invite-submit" type="submit" disabled={busy}>
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

      <Section
        title="Members"
        description="Who belongs to this organization, and what they can open on its events."
      >
        {data && data.members.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">
                Members of this organization and their roles on its events
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  {/*
                    Two columns rather than one, because one was answering two questions at once.
                    The old "Event roles" cell joined every role the member held across *every*
                    event, with no event names, while the Revoke controls two columns over acted
                    on this event alone — so the row and its own buttons described different
                    scopes, on the page the triage notice sends an organizer to when a round has
                    no reviewers.
                  */}
                  <th scope="col">On this event</th>
                  <th scope="col" className="num">
                    Elsewhere
                  </th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => {
                  const here = member.eventRoles.filter(({ eventId: held }) => held === eventId);
                  const elsewhere = new Set(
                    member.eventRoles
                      .filter(({ eventId: held }) => held !== eventId)
                      .map(({ eventId: held }) => held),
                  ).size;
                  const grantable = ROLES.filter(
                    (name) => !here.some(({ role: held }) => held === name),
                  );
                  return (
                    <tr key={member.userId}>
                      <td className="primary-cell" data-label="Name">
                        {member.name}
                      </td>
                      <td data-label="Email">{member.email ?? "—"}</td>
                      <td data-label="On this event">
                        {here.length > 0 ? (
                          <span className="role-chips">
                            {/* Neutral, not info-blue. A role somebody holds is the plain content
                                of this column — the answer to "On this event" — and a tone is for
                                a state a reader has to weigh. Blue on every row of the table put
                                a colour on the one fact that is never remarkable, and it was the
                                only place a role is tinted: the same role reads as plain text in
                                the invitation rows and the removal list further down this file. */}
                            {here.map(({ role: held }) => (
                              <Pill key={held} tone="neutral">
                                {roleLabel(held)}
                              </Pill>
                            ))}
                          </span>
                        ) : (
                          <span className="hint">No role here</span>
                        )}
                      </td>
                      <td className="num" data-label="Elsewhere">
                        <span className="figure">{elsewhere}</span>
                        <span className="visually-hidden">
                          {elsewhere === 1 ? " other event" : " other events"}
                        </span>
                      </td>
                      <td className="member-actions" data-label="Actions">
                        {/*
                          A menu, not a select. The control this replaces called `setEventRole`
                          from `onChange` and then reset its own value: a mis-click granted
                          somebody organizer with no way back, and a keyboard user arrowing
                          through a *closed* list on Windows fired a grant per keystroke, because
                          a closed select changes value on every arrow press.
                        */}
                        <Menu
                          label={`Grant a role to ${member.name}`}
                          triggerClassName="secondary small"
                          trigger="Grant a role"
                          align="end"
                          disabled={busy || grantable.length === 0}
                          items={grantable.map((name) => ({
                            id: name,
                            label: ROLE_TERMS[name].label,
                            hint: ROLE_TERMS[name].consequence,
                            onSelect: () => {
                              // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                              void run(
                                `Granted ${ROLE_TERMS[name].label} to ${member.name} on this event.`,
                                () => setEventRole(organizationId, eventId, member.userId, name),
                              );
                            },
                          }))}
                        />
                        {/*
                          Taking a role away is not the same weight as handing one out, and it
                          used to be drawn identically — "Revoke Reviewer" as a `secondary small`
                          immediately beside "Grant a role" as a `secondary small`, so the row's
                          only destructive control looked exactly like its only additive one. It
                          steps down to `ghost`, which leaves three weights in the cell that read
                          in the order they should be reached: grant, revoke, remove.
                        */}
                        {here.map(({ role: held }) => (
                          <button
                            key={held}
                            type="button"
                            className="ghost small member-revoke"
                            disabled={busy}
                            onClick={() =>
                              // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                              void run(
                                `Revoked ${roleLabel(held)} from ${member.name} on this event.`,
                                () =>
                                  revokeEventRole(
                                    organizationId,
                                    eventId,
                                    member.userId,
                                    held as Role,
                                  ),
                              )
                            }
                          >
                            Revoke {roleLabel(held)}
                          </button>
                        ))}
                        {/*
                          Removal ends the organization membership, which takes every event role
                          with it. It sat here styled exactly like "Revoke reviewer" beside it and
                          fired on the first click; it now looks like what it is and is confirmed
                          by name in the drawer below.
                        */}
                        <button
                          type="button"
                          className="danger small member-remove"
                          disabled={busy}
                          onClick={() => setRemoving(member)}
                        >
                          Remove from organization
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<IconSpeakers size={20} />} title="Nobody else is here yet">
            Invite a co-organizer or a reviewer above, and they will appear once they accept.
          </EmptyState>
        )}
      </Section>

      <Drawer
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : "Remove member"}
        description="Removing somebody ends their organization membership."
        busy={busy}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button
              type="button"
              className="danger primary"
              disabled={busy}
              onClick={() => {
                const member = removing;
                if (!member) return;
                setRemoving(null);
                // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                void run(`Removed ${member.name} from the organization.`, () =>
                  removeMember(organizationId, member.userId),
                );
              }}
            >
              Remove {removing?.name ?? "member"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Keep them
            </button>
          </>
        }
      >
        {removing ? (
          <div className="stack">
            <p>
              {removing.name} loses every role they hold in this organization, on this event and on
              the {removing.eventRoles.length === 1 ? "other" : "others"} listed below. Invite them
              again to restore access; the roles do not come back with the invitation.
            </p>
            {removing.eventRoles.length > 0 ? (
              <ul className="plain-list">
                {removing.eventRoles.map(({ eventId: held, role: name }) => (
                  <li key={`${held}:${name}`}>
                    {roleLabel(name)}
                    {held === eventId ? " on this event" : " on another event"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">They hold no event roles today.</p>
            )}
          </div>
        ) : null}
      </Drawer>

      {/*
        An outstanding invitation is a thing with a clock on it, so it is a run sheet rather than
        a paragraph.

        It used to read "ada@example.test — Reviewer on this event, expires 8/23/2026, 11:00:00 AM
        [Withdraw]": one sentence per row, with the only figure that decides whether to act — how
        long is left — buried at the end in a 22-character machine stamp. The cue gutter carries
        that figure, one measure per row behind a spine that does not break between them, and the
        sentence becomes the row's meta.
      */}
      <Section title="Outstanding invitations">
        {pending.length > 0 ? (
          <GutterList label="Outstanding invitations">
            {pending.map((invitation) => {
              const left = daysLeft(invitation.expiresAt);
              return (
                <GutterRow
                  key={invitation.id}
                  measure={left <= 0 ? "now" : `${left}d`}
                  measureLabel="Expires in"
                  title={invitation.email}
                  meta={
                    <>
                      {roleLabel(invitation.role)}
                      {invitation.eventId ? " on this event" : " in the organization"} · expires{" "}
                      {when(invitation.expiresAt)}
                    </>
                  }
                  actions={
                    <button
                      type="button"
                      className="secondary small"
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
                  }
                />
              );
            })}
          </GutterList>
        ) : (
          <EmptyState icon={<IconSend size={20} />} title="No invitations are outstanding">
            Everything sent has been accepted or withdrawn.
          </EmptyState>
        )}
      </Section>

      {/*
        The audit log resolves on its own request, so its region has to have its own three states.
        It used to render "Nothing recorded yet" for the whole of that wait, which organizers read
        as an empty log on a live one — the emptiness design-language.md forbids claiming before
        the answer is in.
      */}
      <Section title="Recent identity activity">
        {audit.error ? (
          <LoadFailure
            what="the identity activity"
            error={audit.error}
            reference={audit.reference}
            onRetry={audit.reload}
          />
        ) : !audit.data ? (
          <SkeletonRows rows={3} label="Loading recent identity activity" />
        ) : audit.data.events.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">
                Identity actions recorded for this organization, newest first
              </caption>
              <thead>
                <tr>
                  {/* The cue gutter: an audit log is a run sheet, and the figure each row is
                      about is when it happened. */}
                  <th scope="col" className="gutter">
                    When
                  </th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.events.map((entry) => (
                  <tr key={entry.id}>
                    <td className="gutter" data-label="When">
                      <span className="figure">
                        <span className="visually-hidden">Recorded </span>
                        {auditTime(entry.occurredAt)}
                      </span>
                      <span className="sub figure">{auditDay(entry.occurredAt)}</span>
                    </td>
                    <td data-label="Action">
                      {ACTIONS[entry.action] ?? humanizeKey(entry.action)}
                    </td>
                    <td data-label="Outcome">
                      <Pill tone={entry.outcome === "refused" ? "warn" : "ok"}>
                        {entry.outcome === "refused" ? "Refused" : "Succeeded"}
                      </Pill>
                    </td>
                    <td data-label="Reference">
                      <span className="figure">{entry.correlationId}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<IconClock size={20} />} title="Nothing recorded yet">
            Invitations, membership changes and role grants appear here as they happen.
          </EmptyState>
        )}
      </Section>
    </div>
  );
}
