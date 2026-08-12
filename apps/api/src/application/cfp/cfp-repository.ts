import type { CfpForm, ProposalSubmission } from "../../domain/cfp/cfp";

export interface CfpRepository {
  findForm(eventId: string): Promise<CfpForm | null>;
  findPublished(eventId: string): Promise<CfpForm | null>;
  saveForm(form: CfpForm, expectedVersion: number): Promise<boolean>;
  savePublished(form: CfpForm, updateEditable: boolean, expectedVersion: number): Promise<boolean>;
  findSubmission(eventId: string, idempotencyKey: string): Promise<ProposalSubmission | null>;
  findSubmissionById(eventId: string, proposalId: string): Promise<ProposalSubmission | null>;
  createSubmission(submission: ProposalSubmission): Promise<ProposalSubmission | null>;
}
