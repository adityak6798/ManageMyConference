import type { CfpField, CfpForm, ProposalSubmission } from "../../domain/cfp/cfp";
import type { Actor } from "../identity/actor";
import { AuthenticationRequiredError, CapabilityDeniedError } from "../identity/actor";
import type { CfpRepository } from "./cfp-repository";
import type { SubmittedProposalReference } from "./public";

export class CfpUnavailableError extends Error {}
export class CfpStateError extends Error {}
export class CfpValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[]>) {
    super("Proposal validation failed");
  }
}
const organizerFor = (actor: Actor | null, eventId: string) => {
  if (!actor) throw new AuthenticationRequiredError("Authentication is required");
  if (
    !actor.eventAccess.some((access) => access.eventId === eventId && access.role === "organizer")
  )
    throw new CapabilityDeniedError("Organizer event access denied");
};

// @spec PRD-CFP-001 PRD-CFP-002
export class CfpService {
  constructor(
    private readonly repository: CfpRepository,
    private readonly newId: () => string,
    private readonly now: () => Date,
  ) {}
  async getForOrganizer(actor: Actor | null, eventId: string) {
    organizerFor(actor, eventId);
    const [form, published] = await Promise.all([
      this.repository.findForm(eventId),
      this.repository.findPublished(eventId),
    ]);
    return form
      ? {
          ...form,
          publishedStatus:
            published?.status === "open" || published?.status === "closed"
              ? published.status
              : null,
        }
      : null;
  }
  async save(
    actor: Actor | null,
    input: Omit<CfpForm, "status" | "version" | "publishedAt" | "publishedStatus">,
  ): Promise<CfpForm> {
    organizerFor(actor, input.eventId);
    const [prior, published] = await Promise.all([
      this.repository.findForm(input.eventId),
      this.repository.findPublished(input.eventId),
    ]);
    const form: CfpForm = {
      ...input,
      status: "draft",
      version: (prior?.version ?? 0) + 1,
      publishedAt: null,
      publishedStatus:
        published?.status === "open" || published?.status === "closed" ? published.status : null,
    };
    await this.repository.saveForm(form);
    return form;
  }
  async changeState(
    actor: Actor | null,
    eventId: string,
    state: "publish" | "close" | "reopen",
  ): Promise<CfpForm> {
    organizerFor(actor, eventId);
    const draft = await this.repository.findForm(eventId);
    if (!draft) throw new CfpUnavailableError("Create the CFP before changing its state");
    const published = await this.repository.findPublished(eventId);
    if (state === "close" && published?.status !== "open")
      throw new CfpStateError("Only an open CFP can be closed");
    if (state === "reopen" && published?.status !== "closed")
      throw new CfpStateError("Only a closed CFP can be reopened");
    const source = state === "publish" ? draft : published;
    if (!source) throw new CfpUnavailableError("Publish the CFP before changing its state");
    const form: CfpForm = {
      ...source,
      status: state === "close" ? "closed" : "open",
      publishedAt: source.publishedAt ?? this.now().toISOString(),
      publishedStatus: state === "close" ? "closed" : "open",
    };
    await this.repository.savePublished(form, state === "publish" || draft.status !== "draft");
    return (await this.getForOrganizer(actor, eventId)) ?? form;
  }
  async getPublished(eventId: string): Promise<CfpForm> {
    const form = await this.repository.findPublished(eventId);
    if (!form) throw new CfpUnavailableError("The CFP is not published");
    return form;
  }
  async submit(
    eventId: string,
    idempotencyKey: string,
    answers: Record<string, string>,
  ): Promise<ProposalSubmission> {
    const prior = await this.repository.findSubmission(eventId, idempotencyKey);
    if (prior) return prior;
    const form = await this.getPublished(eventId);
    if (form.status !== "open") throw new CfpUnavailableError("The CFP is closed");
    const fieldErrors = validateAnswers(form.fields, answers);
    if (Object.keys(fieldErrors).length) throw new CfpValidationError(fieldErrors);
    const created = await this.repository.createSubmission({
      id: this.newId(),
      eventId,
      cfpVersion: form.version,
      idempotencyKey,
      answers,
      fields: form.fields,
      submittedAt: this.now().toISOString(),
    });
    if (!created) throw new CfpStateError("The CFP changed before this proposal was saved");
    return created;
  }
  async proposalReference(
    proposalId: string,
    eventId: string,
  ): Promise<SubmittedProposalReference | null> {
    const proposal = await this.repository.findSubmissionById(eventId, proposalId);
    return proposal
      ? { proposalId, eventId, cfpVersion: proposal.cfpVersion, submittedAt: proposal.submittedAt }
      : null;
  }
}
function validateAnswers(fields: readonly CfpField[], answers: Record<string, string>) {
  const errors: Record<string, string[]> = {};
  const ids = new Set(fields.map(({ id }) => id));
  for (const key of Object.keys(answers))
    if (!ids.has(key)) errors[`answers.${key}`] = ["This field is not part of the published form."];
  for (const field of fields) {
    const value = answers[field.id]?.trim() ?? "";
    if (field.required && !value) errors[`answers.${field.id}`] = ["This field is required."];
    else if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      errors[`answers.${field.id}`] = ["Enter a valid email address."];
    else if (value && field.type === "select" && !field.options.includes(value))
      errors[`answers.${field.id}`] = ["Choose one of the available options."];
  }
  return errors;
}
