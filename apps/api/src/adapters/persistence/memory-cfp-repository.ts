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
  saveForm(form: CfpForm) {
    this.forms.set(form.eventId, structuredClone(form));
    return Promise.resolve();
  }
  savePublished(form: CfpForm, updateEditable: boolean) {
    this.published.set(form.eventId, structuredClone(form));
    if (updateEditable) this.forms.set(form.eventId, structuredClone(form));
    return Promise.resolve();
  }
  findSubmission(eventId: string, key: string) {
    return Promise.resolve(this.submissions.get(`${eventId}:${key}`) ?? null);
  }
  createSubmission(submission: ProposalSubmission) {
    const key = `${submission.eventId}:${submission.idempotencyKey}`;
    const prior = this.submissions.get(key);
    if (prior) return Promise.resolve(prior);
    this.submissions.set(key, structuredClone(submission));
    return Promise.resolve(submission);
  }
}
