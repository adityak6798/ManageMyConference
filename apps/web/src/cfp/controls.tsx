/*
 * Call for proposals composer.
 *
 * This is the public front door of the product: whatever is published here is the
 * form applicants actually fill in, so the surface is built around the two ways it
 * used to mislead the organizer.
 *
 * 1. "Draft saved." rendered roughly 750px below the button that caused it and was
 *    never announced. Every outcome now goes through useActionFeedback(), which
 *    keeps the confirmation beside the toolbar and inside a live region.
 * 2. Saving an edit to a published form forks the draft away from the snapshot the
 *    public is still submitting against — the API keeps serving the old published
 *    version until the organizer publishes again. That divergence used to be
 *    invisible, so the composer shows the live published form next to the draft and
 *    states, in words, which one applicants can see.
 */

import type { CfpField } from "@greenroom/contracts";
import "../styles/cfp.css";

function FieldControl({
  field,
  idPrefix,
  value,
  errors,
  onChange,
}: {
  field: CfpField;
  idPrefix: string;
  value: string;
  errors: string[];
  onChange?: (next: string) => void;
}) {
  const controlId = `${idPrefix}-${field.id}`;
  const errorId = `${controlId}-error`;
  const guidanceId = `${controlId}-guidance`;
  const describedBy =
    [field.guidance ? guidanceId : null, errors.length ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const shared = {
    id: controlId,
    required: field.required,
    "aria-invalid": errors.length > 0,
    "aria-describedby": describedBy,
    value,
    onChange: (event: { target: { value: string } }) => onChange?.(event.target.value),
  };

  return (
    <div className="cfp-answer">
      <label htmlFor={controlId}>
        {field.label || "Untitled question"}
        {field.required ? <span className="cfp-required-mark"> *</span> : null}
      </label>
      {field.guidance ? (
        <p className="cfp-answer-guidance" id={guidanceId}>
          {field.guidance}
        </p>
      ) : null}
      {field.type === "long_text" ? (
        <textarea {...shared} />
      ) : field.type === "select" ? (
        <select {...shared}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input {...shared} type={field.type === "email" ? "email" : "text"} />
      )}
      {errors.map((error) => (
        <p className="error-text" id={errorId} key={error}>
          {error}
        </p>
      ))}
    </div>
  );
}

/**
 * The right-hand pane. It is deliberately built from the tokens the public event
 * pages use — `public-state` swaps the neutral ramp to warm paper — so the organizer
 * is looking at the real thing rather than a console-flavoured mock.
 */
function PublicFormPreview({
  idPrefix,
  title,
  description,
  fields,
  statusLine,
}: {
  idPrefix: string;
  title: string;
  description: string;
  fields: readonly CfpField[];
  statusLine: string;
}) {
  return (
    <div className="cfp-preview public-state">
      <p className="cfp-preview-kicker">Call for proposals</p>
      <p className="cfp-preview-title">{title.trim() || "Untitled call for proposals"}</p>
      {description.trim() ? <p className="cfp-preview-lede">{description}</p> : null}
      <p className="cfp-preview-status">{statusLine}</p>
      {/* A disabled fieldset keeps the preview out of the tab order and off the
          submit path, so nobody can type into a form that goes nowhere. */}
      <fieldset className="cfp-preview-form" disabled>
        <legend className="visually-hidden">Preview only — these controls do not submit</legend>
        {fields.map((field) => (
          <FieldControl key={field.id} field={field} idPrefix={idPrefix} value="" errors={[]} />
        ))}
        <span className="cfp-preview-submit">Submit proposal</span>
      </fieldset>
    </div>
  );
}

export { FieldControl, PublicFormPreview };
