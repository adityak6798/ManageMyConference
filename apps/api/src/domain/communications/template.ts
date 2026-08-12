/**
 * Turning a stored template version and a payload snapshot into the message that gets sent.
 *
 * Templates were stored, versioned and authorized, and then the text was discarded: a delivery
 * carried `templateId` and `payload` but no subject or body, so nothing downstream could read
 * what the message actually said, and no provider could send one. This is the missing step.
 *
 * Rendering happens once, at enqueue, and the result is stored on the delivery. That is what
 * makes a message auditable: the delivery holds the exact text that was sent, pinned to the
 * template version it came from, and a retry three days later re-sends that text rather than
 * re-rendering against a template someone has since edited.
 *
 * @spec PRD-COM-001
 */

/** A `{{placeholder}}` in the template has no value in the payload snapshot. */
export class TemplatePlaceholderError extends Error {
  constructor(readonly key: string) {
    super(`Template placeholder {{${key}}} has no value in the delivery payload`);
  }
}

/** A payload value exists but is not something that can appear in a message. */
export class TemplateValueError extends Error {
  constructor(readonly key: string) {
    super(`Template placeholder {{${key}}} resolved to a value that is not text or a number`);
  }
}

/**
 * Any brace-delimited key, not just word characters.
 *
 * A narrower pattern would leave `{{speaker-name}}` in the message verbatim instead of refusing
 * the enqueue, which is precisely the half-rendered message this module exists to prevent —
 * payload keys are arbitrary strings, so the template author can write one this has to notice.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

const resolve = (payload: Readonly<Record<string, unknown>>, key: string): string => {
  if (!Object.hasOwn(payload, key)) throw new TemplatePlaceholderError(key);
  const value = payload[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new TemplateValueError(key);
};

/**
 * Substitute every `{{placeholder}}` from the payload, in one pass.
 *
 * One pass on purpose: a payload value that itself contains `{{something}}` is inserted as
 * literal text rather than expanded again, so a speaker whose name or session title happens to
 * contain braces cannot reach another field's value — the template author decides what a
 * message can say, and the data never gets to add a placeholder of its own.
 *
 * A placeholder with no value throws rather than rendering an empty string or leaving the braces
 * in the message. A half-substituted body reaching a recipient is worse than a delivery that
 * refuses to enqueue, and the caller supplies both halves, so it is a caller mistake either way.
 */
export function renderTemplate(
  template: { readonly subject: string | null; readonly body: string },
  payload: Readonly<Record<string, unknown>>,
): { subject: string | null; body: string } {
  const substitute = (text: string) =>
    text.replace(PLACEHOLDER, (_match, key: string) => resolve(payload, key.trim()));
  return {
    subject: template.subject === null ? null : substitute(template.subject),
    body: substitute(template.body),
  };
}
