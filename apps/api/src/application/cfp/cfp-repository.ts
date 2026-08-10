import type { CfpForm, ProposalSubmission } from "../../domain/cfp/cfp";

export interface CfpRepository {
  findForm(eventId: string): Promise<CfpForm | null>;
  saveForm(form: CfpForm): Promise<void>;
  findSubmission(eventId: string, idempotencyKey: string): Promise<ProposalSubmission | null>;
  createSubmission(submission: ProposalSubmission): Promise<ProposalSubmission>;
}
