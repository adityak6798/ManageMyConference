/**
 * Accepting an invitation, from the link the organizer sent.
 *
 * This surface exists because the link has to lead somewhere. The token is answered once when the
 * invitation is created and only its digest is stored, so an organizer copies a URL and sends it;
 * a URL that resolved to nothing would silently discard the token and strand the invitee on
 * whatever their home workspace happened to be.
 *
 * It is reachable by **every** signed-in persona, deliberately. An invitee is usually being
 * offered a reviewer or speaker role, and those personas can reach neither `/settings` nor the
 * members workspace — the surface that administers membership requires `identity:manage`, which
 * is exactly what somebody being invited does not yet have.
 *
 * The token names the invitation; this browser's session names the person. There is no field here
 * for who is accepting and there cannot be one — see `docs/architecture/authorization.md`, rule 1.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import { type FormEvent, useEffect, useState } from "react";
import { type ApiFailure, describeApiFailure } from "./api/config";
import { acceptInvitation } from "./api/membership";
import { Card, Notice, Outcome, PageHeader } from "./ui/primitives";

export function AcceptInvitationPage({
  search,
  durableSession,
}: {
  search: string;
  /**
   * Whether this browser holds a real account rather than a demo persona.
   *
   * The route refuses a persona outright — `authentication === "session"` is the whole of rule 1
   * in docs/architecture/authorization.md — and the transport reports that refusal with the
   * standard 401 sentence, "Sign in to continue.". To somebody who has just signed in and
   * pressed Accept, that is both untrue and a dead end: the form stays on screen, the token is
   * still in it, and pressing again says the same thing. So the surface answers before the
   * press, the way the API-clients workspace answers the same rule.
   */
  durableSession: boolean;
}) {
  const fromLink = new URLSearchParams(search).get("token") ?? "";
  const [token, setToken] = useState(fromLink);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [accepted, setAccepted] = useState(false);

  // The link carries the token, so a visitor who followed one should not have to press anything
  // to use it. Keyed on the token rather than run once, so arriving with a second link works.
  useEffect(() => setToken(fromLink), [fromLink]);

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await acceptInvitation(token.trim());
      setAccepted(true);
    } catch (reason) {
      // ERROR-INTENT: rendered as the surface's recoverable state rather than rethrown — the
      // refusal is the answer here, and it carries the correlation reference a report needs.
      setFailure(describeApiFailure(reason, "The invitation could not be accepted."));
    } finally {
      setBusy(false);
    }
  }

  if (accepted)
    return (
      <>
        <PageHeader eyebrow="Invitation" title="You're in" />
        <Card>
          <Outcome
            tone="success"
            title="The invitation is accepted"
            action={
              /*
                A full document load rather than a client navigation: the shell was built from a
                session read that predates this membership, so its navigation and event list are
                both stale until the session is read again.
              */
              <button className="primary" type="button" onClick={() => window.location.assign("/")}>
                Open the workspace
              </button>
            }
          >
            Your access is live from your next request. Open the workspace to see what you can now
            reach.
          </Outcome>
        </Card>
      </>
    );

  if (!durableSession)
    return (
      <>
        <PageHeader
          eyebrow="Invitation"
          title="Accept an invitation"
          subtitle="You are accepting as the account you are signed in with."
        />
        <Card>
          {/* The refusal and the way out are one thing to read, as on API clients. */}
          <Notice tone="warn" role="status">
            <span>
              A demo identity cannot accept an invitation: it is temporary, and the membership it
              would create is real. Sign in with the address the invitation was sent to, then
              follow this link again — it still carries the token.
            </span>
          </Notice>
        </Card>
      </>
    );

  return (
    <>
      <PageHeader
        eyebrow="Invitation"
        title="Accept an invitation"
        subtitle="You are accepting as the account you are signed in with."
      />
      <Card>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="invitation-token">Invitation token</label>
            <input
              id="invitation-token"
              className="control"
              value={token}
              onChange={(changed) => setToken(changed.target.value)}
              required
            />
          </div>
          <button className="primary" type="submit" disabled={busy || token.trim() === ""}>
            Accept
          </button>
        </form>
        {failure ? (
          <Notice tone="error" reference={failure.reference}>
            {failure.message}
          </Notice>
        ) : null}
        {/*
          No "not now" control: this surface renders inside the shell, so its sidebar is the way
          out and a second one would only be another thing to explain.
        */}
        <p className="hint">
          An invitation that has expired, been withdrawn, or already been accepted cannot be used
          again. Ask whoever invited you to send a new one.
        </p>
      </Card>
    </>
  );
}
