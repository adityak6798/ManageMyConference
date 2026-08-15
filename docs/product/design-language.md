# Greenroom design language

Status: canonical | Owner: product | Last verified: 2026-08-15

Greenroom is an operational product. Its interface should make the next decision obvious, keep
large collections readable, and become visually quiet once somebody starts working. This document
governs the console, role portals, public event surfaces, and the signed-out product story. Product
behavior remains in the owning `PRD-*` specification; this document governs presentation and
interaction only.

## Principles

1. **Lead with the job.** Navigation and page titles name the work somebody came to do, not the
   domain or implementation that owns it.
2. **Prefer structure to containers.** Use whitespace, alignment, dividers, and typography before
   adding a card. A card represents one distinct object or state, never a default page wrapper.
3. **Keep state beside the action.** Validation, progress, success, failure, and stale-data notices
   render where the person acted and remain understandable without color.
4. **Make density intentional.** Tables and lists are compact enough to scan; editing surfaces open
   into a focused panel or dialog rather than expanding every row at once.
5. **Preserve the other side of the lifecycle.** Organizer, reviewer, speaker, applicant, and
   attendee surfaces use one visual grammar while optimizing their hierarchy for different jobs.
6. **Accessibility is the component contract.** Keyboard behavior, focus movement, names, live
   feedback, reduced motion, and narrow-screen behavior ship with a primitive, not afterwards.

## Foundations

### Typography

- Product UI uses the system sans stack. Display and body text share the family; hierarchy comes
  from size, weight, spacing, and measure rather than a decorative face.
- Default body text is 15px. Operational metadata may use 12–13px but never as the only carrier of
  a critical state. Page titles use 28–32px; marketing display copy may scale further.
- Numeric tables and metrics use tabular figures. Long prose stays near a 68-character measure.

### Color

- Canvas is a soft neutral; working surfaces are white; primary text is near black.
- Greenroom green is reserved for primary actions, current navigation, focus, and positive brand
  recognition. It is not a page wash.
- Success, warning, danger, information, and neutral states each pair foreground and background
  tokens with sufficient contrast. Every state also has a label or icon.
- Public events may replace the accent with their configured color. Neutral and semantic ramps do
  not change with event branding.

### Space, shape, and elevation

- Layout follows a 4px base scale. Dense rows use 8–12px internal spacing; page regions use
  20–32px; marketing sections may use 64px or more.
- Controls and compact surfaces use 8px radii, larger panels 12px, and pills only for status or
  genuinely capsule-shaped controls.
- Hairline borders separate most surfaces. Shadows are reserved for dialogs, drawers, popovers,
  and rare floating controls.

## Components and composition

- **Page header:** one title, optional short context, and no more than one primary action.
- **Hub tabs:** represent stable sibling jobs and remain addressable in the URL. Tabs never hide a
  permission refusal the product is required to explain.
- **Toolbar:** filters and search precede bulk actions; destructive actions stay visually separate.
- **List/detail:** selection remains visible in the list and opens one focused detail region. The
  shared primitive stacks both regions as a safe narrow-screen fallback; queues with long lists
  should use route state or the shared drawer so the selected detail becomes the focused view.
- **Tables:** sticky headers, tabular numbers, restrained row hover, an explicit horizontal-scroll
  affordance, and a useful non-table narrow layout where comparison across columns is unnecessary.
- **Forms:** labels remain visible; helper text explains constraints before failure; errors attach to
  their field and an action-level summary appears when several fields fail.
- **Dialogs and drawers:** have one labelled heading, an explicit close control, Escape behavior,
  focus restoration, and blocked dismissal while an irreversible request is in flight.
- **Status and feedback:** use a pill for terse state, a notice for an actionable interruption, and
  a live region for asynchronous outcomes. Toast-only feedback is insufficient.
- **Loading:** preserve layout with restrained skeletons for known shapes. Use plain text for short,
  local waits. Never show an empty state while the first read is unresolved.
- **Empty states:** say why the area is empty and name the next permitted action. Do not render an
  empty table merely to prove its columns exist.

## Shell and responsive behavior

- Desktop uses persistent event context, shallow job navigation, a compact utility top bar, and a
  content measure that can expand for boards and tables.
- Below 780px navigation becomes a modal drawer. The trigger exposes expanded state, Escape closes
  it, and background controls become inert. Dismissing the drawer restores focus to its trigger;
  choosing a destination moves focus to the new page content.
- Every product surface must work without horizontal page overflow at 390px. A deliberately
  scrollable board or table owns its overflow and gives a visible affordance.
- Pointer interactions have keyboard parity. Motion respects `prefers-reduced-motion`.

## Surface variants

- **Console:** neutral, dense, and task-first. It uses the smallest practical type and spacing
  values in this system.
- **Reviewer and speaker portals:** quieter than the organizer console, with one queue or task list
  leading the page and supporting material progressively disclosed.
- **Public event and CFP:** editorial spacing and event accent color, but the same controls, status
  semantics, focus treatment, and responsive rules.
- **Marketing and sign-in:** generous spacing, concise claims, real product proof, and deployment-
  aware calls to action. Claims distinguish implemented behavior from live third-party proof.

## Review checklist

- Is the primary job and next action clear before reading supporting copy?
- Can a repeated card be a row, section, or divider instead?
- Are loading, empty, stale, failure, success, and permission states explicit?
- Does keyboard order match visual order, and does focus move or return intentionally?
- Does the surface work at 390px, 768px, and desktop without page overflow?
- Are product claims and integration states no stronger than current evidence?
