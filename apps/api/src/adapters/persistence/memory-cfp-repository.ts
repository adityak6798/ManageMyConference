import type { CfpRepository } from "../../application/cfp/cfp-repository";
import type { CfpForm, ProposalSubmission } from "../../domain/cfp/cfp";

export class MemoryCfpRepository implements CfpRepository {
  private readonly forms = new Map<string, CfpForm>();
  private readonly published = new Map<string, CfpForm>();
  private readonly submissions = new Map<string, ProposalSubmission>();
  findForm(eventId: string) {
    return Promise.resolve(this.forms.get(eventId) ?? null);
  }
  findPublished(eventId: string) {
    return Promise.resolve(this.published.get(eventId) ?? null);
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
  findSubmission(eventId: string, key: string) {
    return Promise.resolve(this.submissions.get(`${eventId}:${key}`) ?? null);
  }
  findSubmissionById(eventId: string, proposalId: string) {
    return Promise.resolve(
      [...this.submissions.values()].find(
        (item) => item.eventId === eventId && item.id === proposalId,
      ) ?? null,
    );
  }
  createSubmission(submission: ProposalSubmission) {
    const key = `${submission.eventId}:${submission.idempotencyKey}`;
    const prior = this.submissions.get(key);
    if (prior) return Promise.resolve(prior);
    const published = this.published.get(submission.eventId);
    if (published?.status !== "open" || published.version !== submission.cfpVersion)
      return Promise.resolve(null);
    this.submissions.set(key, structuredClone(submission));
    return Promise.resolve(submission);
  }
}
