/**
 * The lifecycle messages every organization starts with.
 *
 * ## What this fixes
 *
 * Every lifecycle message resolves a `message_templates` row scoped to the **organization**, and
 * until this existed the only rows anywhere were in the demo seed. For every other organization —
 * every self-serve Google signup, and every organization on a deployment nobody seeded —
 * `CommunicationsService.prepare` threw `Template version not found`, `notifyLifecycle` caught it
 * as it is designed to, and the lifecycle action succeeded while **nothing was ever sent**. Nine
 * triggers, silently, on every organization but one (issue #217).
 *
 * ## Why a copy per organization rather than a system-owned row
 *
 * Organization scoping is not the bug — an organization editing its own copy is the feature — so
 * the fix is provisioning, and it provisions *rows the organization owns*. Two alternatives were
 * weighed and rejected:
 *
 * - **A system-owned version the resolver falls back to.** `message_templates.organization_id` is
 *   `NOT NULL REFERENCES organizations(id)`, so a system row needs either a nullable column (a
 *   table rebuild, and a `MessageTemplate.organizationId` that is null through every layer that
 *   touches it) or a sentinel organization row that would then appear to `GAP-019`'s data-aware
 *   demo-reset guard as real data. A delivery's `template_id` is a foreign key into this table, so
 *   an in-memory default that is not a row would have to store `NULL` and lose the delivery's
 *   provenance.
 * - **Provisioning inside organization creation.** `SignupService` writes the organization row
 *   *before* the identity batch precisely so it can discard it when that batch fails (issue #164),
 *   and `discardUnusedOrganization` is a `DELETE` that a `message_templates` row would refuse. A
 *   template written at creation would turn a lost signup race into a permanently orphaned
 *   organization — the exact row `GAP-019`'s guard then refuses on for ever.
 *
 * So provisioning is **idempotent, and driven by use**: `CommunicationsService` materializes this
 * catalogue for an organization the first time it resolves a template for one, and the first time
 * an organizer lists them. Migration `1706` does the same for every organization that already
 * exists, so nothing waits for a first message. All three routes converge on the same rows because
 * `(organization_id, template_key, version)` is unique and version 1 is what each of them writes.
 *
 * ## Editing
 *
 * These are version 1. An organization that wants different words publishes version 2 through the
 * ordinary composer, and `findTemplate` returns the newest version — so a customized template
 * shadows this one permanently and nothing here ever overwrites it. Versions are immutable, so a
 * delivery sent last week still names the text it was sent with.
 *
 * The text is deliberately identical to `apps/api/seed/domains/communications-integrations/
 * data.sql`, which held these nine for the demo organization before any other organization could
 * have them. `default-templates.integration.test.ts` asserts migration `1706` and this file agree,
 * so the two cannot drift.
 *
 * @spec PRD-COM-001
 */
import type { MessageTemplate } from "./delivery";

/** One default, before it is given an id and an organization. */
export type DefaultTemplate = Pick<MessageTemplate, "key" | "channel" | "subject" | "body">;

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    key: "speaker-invite",
    channel: "email",
    subject: "Welcome to Greenroom",
    body: "Hello {{speakerName}}, your session is confirmed. Please complete your speaker profile before the event.",
  },
  {
    key: "speaker-task",
    channel: "email",
    subject: "A new task is waiting for you",
    body: 'Hello {{speakerName}}, please complete "{{taskTitle}}" by {{dueAt}}. You can do it from your speaker portal.',
  },
  {
    key: "speaker-task-reminder",
    channel: "email",
    subject: "Reminder: {{taskTitle}}",
    body: 'Hello {{speakerName}}, "{{taskTitle}}" is due {{dueAt}} and is still open. You can complete it from your speaker portal.',
  },
  {
    key: "schedule-published",
    channel: "email",
    subject: "The schedule is published",
    body: "Hello {{speakerName}}, the schedule is published and your session has a time. Add it to your calendar: {{calendarUrl}}",
  },
  {
    key: "reviewer-assignment",
    channel: "email",
    subject: "Abstracts are waiting for your review",
    body: "Hello {{reviewerName}}, abstracts have been assigned to you for round {{round}}. Open your review queue when you have time.",
  },
  {
    key: "decision-accepted",
    channel: "email",
    subject: "Your proposal was accepted",
    body: 'Hello {{submitterName}}, we are delighted to tell you that "{{proposalTitle}}" has been accepted. We will be in touch with next steps shortly.',
  },
  {
    key: "decision-declined",
    channel: "email",
    subject: "About your proposal",
    body: 'Hello {{submitterName}}, thank you for submitting "{{proposalTitle}}". We had more strong proposals than slots this year and will not be able to programme it. We hope you will submit again.',
  },
  {
    key: "speaker-calendar-invite",
    channel: "email",
    subject: "Your session at {{eventName}}",
    body: "Hello {{speakerName}}, here is the calendar invitation for {{sessionTitle}} at {{eventName}}. Accept it to add the session to your calendar; if the time changes we will send an update that replaces this entry.",
  },
  {
    key: "proposal-submitted",
    channel: "email",
    subject: "We have your proposal",
    body: 'Hello {{submitterName}}, thank you — "{{proposalTitle}}" is with the programme team. You can read or revise it from your proposals page while the call is open, and its decision will appear there.',
  },
];

/** Whether a key is one this catalogue provisions, so a miss can be told from a typo. */
export const isDefaultTemplateKey = (key: string): boolean =>
  DEFAULT_TEMPLATES.some((template) => template.key === key);
