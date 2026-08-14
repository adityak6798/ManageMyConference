import type {
  CfpRepository,
  ProposalDraftCreate,
  ProposalOwnerWrite,
  ProposalSubmitWrite,
} from "../../application/cfp/cfp-repository";
import {
  CFP_DRAFT_STATUS,
  type CfpForm,
  type CfpSubmissionWindow,
  cfpEffectiveState,
  type ProposalSubmission,
} from "../../domain/cfp/cfp";

export class MemoryCfpRepository implements CfpRepository {
  private readonly forms = new Map<string, CfpForm>();
  private readonly published = new Map<string, CfpForm>();
  private readonly windows = new Map<string, CfpSubmissionWindow>();
  private readonly submissions = new Map<string, ProposalSubmission>();
  /**
   * The window as live state, exactly as D1 holds it: on the row, not in the published snapshot.
   * Both `findForm` and `findPublished` overlay it, so this fake cannot answer "when does it
   * close" differently from the adapter the product runs on.
   */
  private windowOf(eventId: string): CfpSubmissionWindow {
    return this.windows.get(eventId) ?? { opensAt: null, closesAt: null };
  }
  findForm(eventId: string) {
    const form = this.forms.get(eventId);
    return Promise.resolve(form ? { ...form, ...this.windowOf(eventId) } : null);
  }
  findPublished(eventId: string) {
    const form = this.published.get(eventId);
    return Promise.resolve(form ? { ...form, ...this.windowOf(eventId) } : null);
  }
  saveForm(form: CfpForm, expectedVersion: number) {
    if ((this.forms.get(form.eventId)?.version ?? 0) !== expectedVersion)
      return Promise.resolve(false);
    this.forms.set(form.eventId, structuredClone(form));
    return Promise.resolve(true);
  }
  savePublished(form: CfpForm, updateEditable: boolean, expectedVersion: number) {
    if ((this.forms.get(form.eventId)?.version ?? 0) !== expectedVersion)
      return Promise.resolve(false);
    this.published.set(form.eventId, structuredClone(form));
    if (updateEditable) this.forms.set(form.eventId, structuredClone(form));
    return Promise.resolve(true);
  }
  saveWindow(eventId: string, window: CfpSubmissionWindow) {
    if (!this.forms.has(eventId)) return Promise.resolve(false);
    this.windows.set(eventId, { ...window });
    return Promise.resolve(true);
  }
  findSubmission(eventId: string, key: string) {
    return Promise.resolve(this.submissions.get(`${eventId}:${key}`) ?? null);
  }
  findSubmissionById(eventId: string, proposalId: string) {
    return Promise.resolve(
      [...this.submissions.values()].find(
        (item) => item.eventId === eventId && item.id === proposalId && item.lifecycle !== "draft",
      ) ?? null,
    );
  }
  findProposalForOwner(eventId: string, proposalId: string, submitterUserId: string) {
    return Promise.resolve(
      [...this.submissions.values()].find(
        (item) =>
          item.eventId === eventId &&
          item.id === proposalId &&
          item.submitterUserId === submitterUserId,
      ) ?? null,
    );
  }
  listProposalsForOwner(eventId: string, submitterUserId: string) {
    return Promise.resolve(
      [...this.submissions.values()]
        .filter((item) => item.eventId === eventId && item.submitterUserId === submitterUserId)
        .sort(
          (left, right) =>
            left.submittedAt.localeCompare(right.submittedAt) || left.id.localeCompare(right.id),
        ),
    );
  }
  createSubmission(proposal: ProposalSubmission) {
    const key = `${proposal.eventId}:${proposal.idempotencyKey}`;
    const prior = this.submissions.get(key);
    if (prior) return Promise.resolve(prior);
    const published = this.findPublishedNow(proposal.eventId);
    if (!published || published.version !== proposal.cfpVersion) return Promise.resolve(null);
    if (cfpEffectiveState(published, new Date(proposal.submittedAt)) !== "open")
      return Promise.resolve(null);
    const stored: ProposalSubmission = {
      ...proposal,
      lifecycle: "submitted",
      revision: proposal.revision ?? 1,
      updatedAt: proposal.updatedAt ?? proposal.submittedAt,
      status: proposal.resolvedRoute?.status ?? "submitted",
      submitterUserId: proposal.submitterUserId ?? null,
    };
    this.submissions.set(key, structuredClone(stored));
    return Promise.resolve(stored);
  }
  createDraft(draft: ProposalDraftCreate) {
    const key = `${draft.eventId}:${draft.idempotencyKey}`;
    const prior = this.submissions.get(key);
    if (prior) return Promise.resolve(prior);
    if (!this.openAt(draft.eventId, draft.at)) return Promise.resolve(null);
    const stored: ProposalSubmission = {
      ...draft,
      fields: [],
      resolvedRoute: null,
      lifecycle: "draft",
      revision: 1,
      updatedAt: draft.updatedAt ?? draft.submittedAt,
      status: CFP_DRAFT_STATUS,
    };
    this.submissions.set(key, structuredClone(stored));
    return Promise.resolve(stored);
  }
  saveProposalAnswers(write: ProposalOwnerWrite) {
    const entry = this.ownedFor(write);
    if (!entry) return Promise.resolve(false);
    this.submissions.set(entry.key, {
      ...entry.proposal,
      answers: { ...write.answers },
      revision: (entry.proposal.revision ?? 1) + 1,
      updatedAt: write.updatedAt,
    });
    return Promise.resolve(true);
  }
  submitProposal(write: ProposalSubmitWrite) {
    const entry = this.ownedFor(write);
    if (entry?.proposal.lifecycle !== "draft") return Promise.resolve(false);
    this.submissions.set(entry.key, {
      ...entry.proposal,
      answers: { ...write.answers },
      fields: write.fields,
      resolvedRoute: write.resolvedRoute,
      cfpVersion: write.cfpVersion,
      status: write.status,
      lifecycle: "submitted",
      submittedAt: write.submittedAt,
      revision: (entry.proposal.revision ?? 1) + 1,
      updatedAt: write.updatedAt,
    });
    return Promise.resolve(true);
  }
  /** The same conjunction the adapter's `OPEN_WINDOW_GUARD` is: owner, revision, and open call. */
  private ownedFor(write: ProposalOwnerWrite) {
    if (!this.openAt(write.eventId, write.at)) return null;
    for (const [key, proposal] of this.submissions)
      if (
        proposal.eventId === write.eventId &&
        proposal.id === write.proposalId &&
        proposal.submitterUserId === write.submitterUserId &&
        (proposal.revision ?? 1) === write.expectedRevision
      )
        return { key, proposal };
    return null;
  }
  private findPublishedNow(eventId: string) {
    const form = this.published.get(eventId);
    return form ? { ...form, ...this.windowOf(eventId) } : null;
  }
  private openAt(eventId: string, at: string) {
    const published = this.findPublishedNow(eventId);
    return Boolean(published) && cfpEffectiveState(published as CfpForm, new Date(at)) === "open";
  }
}
