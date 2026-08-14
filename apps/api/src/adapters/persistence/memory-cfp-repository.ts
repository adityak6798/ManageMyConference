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
  /**
   * Both scoped reads, faithful to the adapter down to *why* they are scoped.
   *
   * The map is keyed on `(eventId, idempotencyKey)` exactly as `UNIQUE (event_id,
   * idempotency_key)` is — so a fake that looked up by that key alone would reproduce the
   * cross-account leak silently, which is what it did until two reviewers found it.
   */
  findAnonymousSubmission(eventId: string, key: string) {
    const found = this.submissions.get(`${eventId}:${key}`);
    return Promise.resolve(
      found && found.submitterUserId == null && found.lifecycle !== "draft" ? found : null,
    );
  }
  findOwnedProposalByKey(eventId: string, key: string, submitterUserId: string) {
    const found = this.submissions.get(`${eventId}:${key}`);
    return Promise.resolve(found?.submitterUserId === submitterUserId ? found : null);
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
  /**
   * The same two rules the D1 statement applies: published, closing in the window, drafts only.
   *
   * The deadline comes from `windowOf` rather than from the stored form, for the reason the class
   * comment gives: the window is live state on the row, and a fake that read a copy off the
   * snapshot would answer "when does this close" differently from the adapter the product runs on
   * — which is exactly the bug this whole feature is about.
   */
  listDeadlineNotices(window: { from: string; to: string }, limit: number) {
    const closing = [...this.forms.values()]
      .map((form) => ({ ...form, ...this.windowOf(form.eventId) }))
      .filter(
        (form) =>
          form.publishedAt !== null &&
          form.closesAt !== null &&
          form.closesAt >= window.from &&
          form.closesAt < window.to,
      )
      .sort(
        (left, right) =>
          (left.closesAt ?? "").localeCompare(right.closesAt ?? "") ||
          left.eventId.localeCompare(right.eventId),
      )
      .slice(0, limit);
    return Promise.resolve(
      closing.map((form) => {
        const drafts = new Map<string, number>();
        for (const proposal of this.submissions.values())
          if (
            proposal.eventId === form.eventId &&
            proposal.lifecycle === "draft" &&
            proposal.submitterUserId
          )
            drafts.set(proposal.submitterUserId, (drafts.get(proposal.submitterUserId) ?? 0) + 1);
        return {
          eventId: form.eventId,
          closesAt: form.closesAt as string,
          draftHolders: [...drafts]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([userId, draftCount]) => ({ userId, draftCount })),
        };
      }),
    );
  }
  createSubmission(proposal: ProposalSubmission) {
    const key = `${proposal.eventId}:${proposal.idempotencyKey}`;
    const prior = this.submissions.get(key);
    // A key held by anything else — an owned draft, another account's proposal — is a skipped
    // insert converging on nothing, not a success. Same as `INSERT OR IGNORE` plus a scoped read.
    if (prior)
      return Promise.resolve(
        prior.submitterUserId == null && prior.lifecycle !== "draft" ? prior : null,
      );
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
    // Converges only on this account's own row; anything else is a refusal.
    if (prior)
      return Promise.resolve(prior.submitterUserId === draft.submitterUserId ? prior : null);
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
      // The fake carried only the answers while D1's statement did the same, so the divergence a
      // fake exists to catch was in both. Both now store the snapshot the answers were validated
      // against — see `ProposalOwnerWrite`.
      fields: write.fields,
      cfpVersion: write.cfpVersion,
      revision: (entry.proposal.revision ?? 1) + 1,
      updatedAt: write.updatedAt,
    });
    return Promise.resolve(true);
  }
  submitProposal(write: ProposalSubmitWrite) {
    // `lifecycle: "draft"` is this write's fixed precondition rather than a value it carries —
    // submitting is one-way — so it is supplied here, exactly as the statement states it literally.
    const entry = this.ownedFor({ ...write, lifecycle: "draft" });
    if (!entry) return Promise.resolve(false);
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
  /**
   * The same conjunction the adapter's statement is: owner, revision, lifecycle, and open call.
   *
   * The lifecycle belongs here rather than in the callers for the reason `ProposalOwnerWrite`
   * gives: which snapshot a write stores is decided from a read *before* it, so a row that moved
   * between the two has to miss rather than be written under the earlier decision.
   */
  private ownedFor(write: ProposalOwnerWrite) {
    if (!this.openAt(write.eventId, write.at)) return null;
    for (const [key, proposal] of this.submissions)
      if (
        proposal.eventId === write.eventId &&
        proposal.id === write.proposalId &&
        proposal.submitterUserId === write.submitterUserId &&
        (proposal.revision ?? 1) === write.expectedRevision &&
        (proposal.lifecycle ?? "submitted") === write.lifecycle
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
