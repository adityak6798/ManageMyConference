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
import { describeApiFailure } from "../api/config";
import { getContent } from "../api/content";
import "../styles/content.css";
import { IconWarning } from "../ui/icons";
import { Card, EmptyState, LoadFailure, SkeletonPage, useLoad } from "../ui/primitives";

import { OrganizerView } from "./OrganizerContent";
import { SpeakerView } from "./SpeakerContent";
import type { Props, Run } from "./shared";

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export function ContentWorkspace({
  eventId,
  role,
  canAdministerShares = role === "organizer",
  sessionsOnly = false,
}: Props & { sessionsOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const describeLoadFailure = useCallback(
    (reason: unknown) => describeApiFailure(reason, "This workspace could not be loaded."),
    [],
  );
  const fetchWorkspace = useCallback((id: string) => getContent(id), []);
  const {
    data: workspace,
    error: loadFailure,
    reference,
    reload,
  } = useLoad(eventId, fetchWorkspace, describeLoadFailure);

  const run: Run = async (action) => {
    setBusy(true);
    try {
      await action();
      await reload();
      return { ok: true };
    } catch (error) {
      // ERROR-INTENT: the rejection is handed back to the caller, which announces it next to the
      // control that triggered it — as a sentence and a correlation reference, through
      // `describeApiFailure` — and renders any field-level detail the server attached against the
      // input that caused it.
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  };

  /*
   * The one failure with nowhere else to go: no table to put an announcement beside, no control
   * that caused it. `LoadFailure` is the shared shape for exactly that — a title naming the read,
   * the server's sentence, the reference as a copyable value, and the retry. This file declared a
   * second component of the same name over `Notice` + `EmptyState`, which shadowed the primitive
   * and printed the reference glued to the end of the sentence.
   */
  if (loadFailure)
    return (
      <div className="content-workspace">
        <LoadFailure
          what={role === "speaker" ? "your portal" : "this workspace"}
          error={loadFailure}
          reference={reference}
          onRetry={reload}
        >
          {loadFailure} Nothing on the event has changed.
        </LoadFailure>
      </div>
    );

  if (!workspace)
    return (
      <div className="content-workspace">
        <SkeletonPage label="Loading the sessions and speakers workspace." />
      </div>
    );

  if (role === "organizer")
    return (
      <OrganizerView
        eventId={eventId}
        workspace={workspace}
        busy={busy}
        run={run}
        canAdministerShares={canAdministerShares}
        sessionsOnly={sessionsOnly}
      />
    );

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
