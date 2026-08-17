/**
 * Keep Tab inside one overlay.
 *
 * The command palette carried this as an inline branch of its own key handler, and the mobile
 * navigation drawer — which covers the page, marks it `inert`, and closes on Escape — carried
 * nothing, so Tab walked straight out of it and into the browser's own chrome while the page
 * behind was still unreachable. That is the same defect twice, so it is one function.
 *
 * It listens on the element rather than on the document: an overlay only owns the keyboard while
 * it is mounted, and a document-level handler would outlive a surface that unmounts mid-press.
 *
 * @spec PRD-OPS-001
 */
import { type RefObject, useEffect } from "react";

/** Everything the platform will move focus to with Tab, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  // Deliberately no visibility filter. Every caller runs this only while its overlay is open, so
  // its own controls are on screen — and `offsetParent`, the usual test, is always null under
  // jsdom, which would have turned the whole trap into a silent no-op in the tier that checks it.
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Wrap Tab and Shift+Tab within `ref` while `active`.
 *
 * Nothing else is claimed. Escape, and where focus goes when the overlay closes, belong to the
 * surface: the palette returns focus to whatever opened it, the drawer to its own trigger, and
 * a trap that decided that for them would be wrong for one of the two.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const container = ref.current;
      if (!container) return;
      const focusable = focusableWithin(container);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active_ = document.activeElement;
      // A press from outside the overlay — focus was moved away, or never entered — lands on the
      // first control rather than escaping, because the page behind is inert.
      if (!(active_ instanceof HTMLElement) || !container.contains(active_)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active_ === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active_ === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, ref]);
}
