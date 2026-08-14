/**
 * Turning each domain's own read into the rows a report is answered from.
 *
 * One mapper per dataset, sitting next to the catalogue that advertises its fields, so a
 * catalogue promising a column nothing fills is a change to two adjacent functions rather than a
 * discovery at run time.
 *
 * **Every read goes through `PlatformSources`**, the same declared interfaces search and the
 * inbox use. Three things follow that are worth being explicit about, because they are what makes
 * reporting safe rather than merely convenient:
 *
 * - A report answers exactly what its caller's role can already open. A reviewer's contacts
 *   dataset degrades to `unauthorized` rather than to an empty table, because the CRM refuses the
 *   read and `readSource` classifies the refusal.
 * - A field a **custom role hides** never reaches here. The content workspace and the CRM
 *   directory redact before platform sees a row, so `speaker.email` is simply absent and the
 *   mapper writes `null` — which is the same thing a report would show for a speaker who has no
 *   address, and is the correct answer to both.
 * - Nothing joins another domain's tables. The cost is that a dataset is bounded by what the
 *   console's own projections carry, which `GAP-022` already records for search.
 *
 * @spec PRD-OPS-001 PRD-IAM-002 ARC-DOM-001
 */
import type { Actor } from "../identity/actor";
import type { ReportDatasetKey, ReportRow } from "./report-catalogue";
import { readSource, requireSource, type SourceOutcome } from "./section";
import type { PlatformSources } from "./sources";

/** Where a dataset's rows came from, or why they did not. Degrades exactly as a search section. */
export type ReportRowsOutcome = SourceOutcome<readonly ReportRow[]>;

export async function readReportRows(
  sources: PlatformSources,
  dataset: ReportDatasetKey,
  actor: Actor | null,
  eventId: string,
): Promise<ReportRowsOutcome> {
  switch (dataset) {
    case "sessions":
      return readSource(async () => {
        const workspace = await requireSource(sources.content, "Content").workspace(actor, eventId);
        return workspace.sessions.map((session) => ({
          title: session.title,
          // `?? null` throughout, and it is doing real work: a field the reader's custom role
          // hides arrives absent, and null is what an empty cell already means.
          format: session.format ?? null,
          track: session.tracks?.[0] ?? null,
          publicationState: session.publicationState ?? null,
          speakerCount: session.speakerProfileIds.length,
          abstractLength: (session.abstract ?? "").length,
        }));
      });
    case "speakers":
      return readSource(async () => {
        const workspace = await requireSource(sources.content, "Content").workspace(actor, eventId);
        return workspace.speakers.map((speaker) => ({
          name: speaker.name,
          email: speaker.email ?? null,
          organization: speaker.organization ?? null,
          workflowStatus: speaker.workflowStatus ?? null,
          openTasks: workspace.tasks.filter(
            (task) => task.speakerProfileId === speaker.id && task.status === "open",
          ).length,
        }));
      });
    case "submissions":
      return readSource(async () => {
        const workspace = await requireSource(sources.review, "Review").organizerWorkspace(
          actor,
          eventId,
        );
        return workspace.proposals.map((proposal) => ({
          title: proposal.title,
          submitterName: proposal.submitterName,
          status: proposal.status,
          assignmentCount: workspace.assignments.filter(
            (assignment) => assignment.proposalId === proposal.id,
          ).length,
        }));
      });
    case "reviews":
      return readSource(async () => {
        const workspace = await requireSource(sources.review, "Review").organizerWorkspace(
          actor,
          eventId,
        );
        const titles = new Map(
          workspace.proposals.map((proposal) => [proposal.id, proposal.title]),
        );
        return workspace.assignments.map((assignment) => ({
          proposalTitle: titles.get(assignment.proposalId) ?? assignment.proposalId,
          reviewerId:
            workspace.reviewerDirectory.find((entry) => entry.id === assignment.reviewerId)?.name ??
            assignment.reviewerId,
          state:
            workspace.evaluations.find((evaluation) => evaluation.assignmentId === assignment.id)
              ?.state ?? "not started",
          assignedAt: assignment.createdAt,
        }));
      });
    case "deliverables":
      return readSource(async () => {
        const workspace = await requireSource(sources.content, "Content").workspace(actor, eventId);
        const speakers = new Map(workspace.speakers.map((speaker) => [speaker.id, speaker.name]));
        return workspace.tasks.map((task) => ({
          title: task.title,
          speakerName: speakers.get(task.speakerProfileId) ?? task.speakerProfileId,
          status: task.status,
          dueAt: task.dueAt,
        }));
      });
    case "contacts":
      return readSource(async () => {
        const crm = requireSource(sources.crm, "CRM");
        const organizationId = await sources.events.organizationOf(eventId);
        if (!organizationId) return [];
        const [prospects, directory] = await Promise.all([
          crm.list(actor, eventId, {}),
          crm.listContacts(actor, organizationId, { eventId }),
        ]);
        // The pipeline stage lives on the prospect and the company on the directory contact; a
        // report about "contacts" wants both, and matching them by name here is what avoids
        // asking the CRM for a join it does not offer.
        const stages = new Map(prospects.map((prospect) => [prospect.name, prospect.stage]));
        return directory.contacts.map((contact) => ({
          name: contact.name,
          company: contact.company ?? null,
          stage: stages.get(contact.name) ?? "not tracked",
          // The directory projection carries no address, by design: a report cannot invent one.
          email: null,
        }));
      });
    case "agenda":
      return readSource(async () => {
        const draft = await requireSource(sources.agenda, "Agenda").draft(actor, eventId);
        const rooms = new Map(draft.rooms.map((room) => [room.id, room.name]));
        const slots = new Map(draft.slots.map((slot) => [slot.id, slot.startsAt]));
        return draft.sessions.map((session) => {
          const placement = draft.placements.find((entry) => entry.sessionId === session.id);
          return {
            sessionTitle: session.title,
            room: placement ? (rooms.get(placement.roomId) ?? null) : null,
            startsAt: placement ? (slots.get(placement.slotId) ?? null) : null,
            placed: placement ? "yes" : "no",
          };
        });
      });
    case "communications":
      return readSource(async () => {
        const communications = requireSource(sources.communications, "Communications");
        const organizationId = await sources.events.organizationOf(eventId);
        if (!organizationId) return [];
        const history = await communications.history(actor, organizationId, eventId, {
          limit: 500,
        });
        return history.history.map(({ delivery }) => ({
          subject: delivery.renderedSubject ?? "(no subject)",
          recipient: delivery.recipientRef,
          trigger: delivery.triggerType,
          state: delivery.state,
          attempts: delivery.attemptCount,
        }));
      });
  }
}
