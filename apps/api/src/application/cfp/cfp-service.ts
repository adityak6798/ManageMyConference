import {
  type CfpField,
  type CfpForm,
  type CfpCondition,
  type CfpRoutingRule,
  cfpFieldMaxLength,
  type ProposalSubmission,
} from "../../domain/cfp/cfp";
import type { Actor } from "../identity/actor";
import { CapabilityDeniedError, requireEventCapability } from "../identity/actor";
import type { CfpRepository } from "./cfp-repository";
import type { SubmittedProposalReference } from "./public";
import type { SubmittedProposalQuery } from "./submitted-proposal-interface";

export class CfpUnavailableError extends Error {}
export class CfpStateError extends Error {}
export class CfpRoutingConfigurationError extends Error {}
export class CfpDraftConflictError extends Error {}
export class CfpValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[]>) {
    super("Proposal validation failed");
  }
}
const organizerFor = (actor: Actor | null, eventId: string) => {
  try {
    requireEventCapability(actor, eventId, "events:settings:update");
  } catch (error) {
    if (error instanceof CapabilityDeniedError)
      throw new CapabilityDeniedError("Organizer event access denied");
    throw error;
  }
};

// @spec PRD-CFP-001 PRD-CFP-002
export class CfpService {
  constructor(
    private readonly repository: CfpRepository,
    private readonly newId: () => string,
    private readonly now: () => Date,
    private readonly proposals?: Pick<SubmittedProposalQuery, "listStatuses">,
  ) {}
  async routingStatuses(actor: Actor | null, eventId: string) {
    organizerFor(actor, eventId);
    return this.proposals?.listStatuses(eventId) ?? [];
  }
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
    input: Omit<CfpForm, "status" | "version" | "publishedAt" | "publishedStatus"> & {
      expectedVersion: number;
    },
  ): Promise<CfpForm> {
    organizerFor(actor, input.eventId);
    const published = await this.repository.findPublished(input.eventId);
    const { expectedVersion, ...editable } = input;
    if (editable.routing?.length) {
      const configured = new Set(
        (await this.routingStatuses(actor, input.eventId)).map(({ key }) => key),
      );
      const invalid = editable.routing.find(({ routeTo }) => !configured.has(routeTo.status));
      if (invalid)
        throw new CfpRoutingConfigurationError(
          `Choose a configured proposal status for routing rule ${invalid.id}`,
        );
    }
    const form: CfpForm = {
      ...editable,
      status: "draft",
      version: expectedVersion + 1,
      publishedAt: null,
      publishedStatus:
        published?.status === "open" || published?.status === "closed" ? published.status : null,
    };
    try {
      if (!(await this.repository.saveForm(form, expectedVersion)))
        throw new CfpDraftConflictError("This CFP draft changed in another editor");
    } catch (error) {
      if (String(error).includes("CFP_ROUTE_STATUS_NOT_CONFIGURED"))
        throw new CfpRoutingConfigurationError("Choose a configured proposal status");
      throw error;
    }
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
    /*
     * Publishing changes the form applicants see. It does not decide whether they may submit.
     *
     * Republishing used to overwrite a `closed` publication with `open`, so an organizer who
     * had closed submissions after the deadline and later fixed a typo reopened the call by
     * accident — silently, since the only message named the new version of the form. Open and
     * closed is what "Close live CFP" and "Reopen live CFP" are for, and those two are the only
     * things that may change it. A first publication has no live state to preserve and opens.
     */
    const live: "open" | "closed" = published?.status === "closed" ? "closed" : "open";
    const status = state === "publish" ? live : state === "close" ? "closed" : "open";
    const form: CfpForm = {
      ...source,
      status,
      publishedAt: source.publishedAt ?? this.now().toISOString(),
      publishedStatus: status,
    };
    if (
      !(await this.repository.savePublished(
        form,
        state === "publish" || draft.status !== "draft",
        draft.version,
      ))
    )
      throw new CfpDraftConflictError("This CFP draft changed in another editor");
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
    const resolvedRoute = resolveRoute(form.routing ?? [], answers);
    const created = await this.repository.createSubmission({
      id: this.newId(),
      eventId,
      cfpVersion: form.version,
      idempotencyKey,
      answers,
      fields: form.fields,
      resolvedRoute,
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
export function conditionMatches(
  condition: CfpCondition | undefined,
  answers: Readonly<Record<string, string>>,
) {
  if (!condition) return true;
  const value = answers[condition.fieldId]?.trim() ?? "";
  if (condition.operator === "notEmpty") return Boolean(value);
  if (condition.operator === "equals") return value === (condition.values[0] ?? "");
  return condition.values.includes(value);
}

function resolveRoute(
  routing: readonly CfpRoutingRule[],
  answers: Readonly<Record<string, string>>,
) {
  const rule = routing.find(({ when }) => conditionMatches(when, answers));
  return rule ? { ruleId: rule.id, status: rule.routeTo.status } : null;
}
function validateAnswers(fields: readonly CfpField[], answers: Record<string, string>) {
  const errors: Record<string, string[]> = {};
  const ids = new Set(fields.map(({ id }) => id));
  for (const key of Object.keys(answers))
    if (!ids.has(key)) errors[`answers.${key}`] = ["This field is not part of the published form."];
  for (const field of fields) {
    const visible = conditionMatches(field.visibleWhen, answers);
    if (!visible && Object.hasOwn(answers, field.id)) {
      errors[`answers.${field.id}`] = ["This field is hidden for the answers you selected."];
      continue;
    }
    if (!visible) continue;
    const value = answers[field.id]?.trim() ?? "";
    const limit = cfpFieldMaxLength(field);
    if (field.required && !value) errors[`answers.${field.id}`] = ["This field is required."];
    // The limit the published form advertises is the limit the submission is held to, so a
    // form cannot promise room the server refuses — nor accept a 120 KB answer it never asked
    // for. `submitProposalInputSchema` bounds the body first; this bounds each field.
    else if (value.length > limit)
      errors[`answers.${field.id}`] = [`Keep this answer under ${limit} characters.`];
    else if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      errors[`answers.${field.id}`] = ["Enter a valid email address."];
    else if (value && field.type === "select" && !field.options.includes(value))
      errors[`answers.${field.id}`] = ["Choose one of the available options."];
  }
  return errors;
}
