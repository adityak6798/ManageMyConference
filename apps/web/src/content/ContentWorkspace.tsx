/*
 * Sessions & speakers — one component, two audiences.
 *
 * Organizers get a two-pane operations view: the accepted-content table on the left
 * and the people who still owe work on the right. Speakers get a portal that leads
 * with the work assigned to them, because that is the only reason they sign in.
 *
 * Every mutation runs through `run`, which refetches the workspace and reports the
 * outcome through useActionFeedback so the confirmation lands next to the control
 * that caused it instead of at the bottom of the page.
 */

import { useCallback, useState } from "react";
import { ContentApiError, getContent } from "../api/content";
import "../styles/content.css";
import { IconWarning } from "../ui/icons";
import { Card, EmptyState, Notice, useLoad } from "../ui/primitives";

import { OrganizerView } from "./OrganizerContent";
import { SpeakerView } from "./SpeakerContent";
import { type Props, type Run, withReference } from "./shared";

function LoadingWorkspace() {
  return (
    <div className="content-workspace">
      <div className="grid-auto" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="stat" key={index}>
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
            <div className="skeleton" style={{ height: 30, width: "35%", marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="card" aria-hidden="true">
        <div className="card-body">
          <div className="skeleton" style={{ height: 18, width: "40%" }} />
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} />
        </div>
      </div>
      <p className="visually-hidden" role="status">
        Loading the sessions and speakers workspace.
      </p>
    </div>
  );
}

/**
 * What the skeleton becomes when the workspace cannot be read.
 *
 * This is the only failure with nowhere else to go: there is no table to put an announcement
 * beside and no control that caused it. So it takes the workspace's own place, says which read
 * failed, carries the correlation id, and offers the one action that can still help.
 */
function LoadFailure({
  message,
  speaker,
  onRetry,
}: {
  message: string;
  speaker: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="content-workspace">
      <Card>
        <Notice tone="error">{message}</Notice>
        <EmptyState
          title={speaker ? "Your portal could not be loaded" : "This workspace could not be loaded"}
          icon={<IconWarning size={20} />}
          action={
            <button type="button" className="secondary" onClick={onRetry}>
              Try again
            </button>
          }
        >
          Nothing on the event has changed. Try again, and quote the reference above if it keeps
          failing.
        </EmptyState>
      </Card>
    </div>
  );
}

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export function ContentWorkspace({ eventId, role }: Props) {
  const [busy, setBusy] = useState(false);
  const describeLoadFailure = useCallback(
    (reason: unknown) =>
      withReference(
        reason instanceof ContentApiError ? reason.message : "This workspace could not be loaded.",
        reason,
      ),
    [],
  );
  const fetchWorkspace = useCallback((id: string) => getContent(id), []);
  const {
    data: workspace,
    error: loadFailure,
    reload,
  } = useLoad(eventId, fetchWorkspace, describeLoadFailure);

  const run: Run = async (action) => {
    setBusy(true);
    try {
      await action();
      await reload();
      return { ok: true };
    } catch (error) {
      // ERROR-INTENT: the rejection is handed back to the caller, which announces it next to
      // the control that triggered it — with the correlation id, via withReference — and
      // renders any field-level detail the server attached against the input that caused it.
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  };

  if (loadFailure)
    return (
      <LoadFailure
        message={loadFailure}
        speaker={role === "speaker"}
        onRetry={() => {
          // ERROR-INTENT: useLoad renders the retry failure in this workspace.
          void reload().catch(() => undefined);
        }}
      />
    );

  if (!workspace) return <LoadingWorkspace />;

  if (role === "organizer") return <OrganizerView workspace={workspace} busy={busy} run={run} />;

  const profile = workspace.speakers[0];
  if (!profile)
    return (
      <Card>
        <EmptyState title="No speaker profile here" icon={<IconWarning size={20} />}>
          This identity is not linked to a speaker record on this event. Switch events, or ask an
          organizer to accept your proposal first.
        </EmptyState>
      </Card>
    );

  return (
    <SpeakerView eventId={eventId} workspace={workspace} profile={profile} busy={busy} run={run} />
  );
}
