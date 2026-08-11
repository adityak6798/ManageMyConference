import "@testing-library/jest-dom/vitest";

/*
 * jsdom ships `<dialog>` as an element but implements neither `showModal()` nor `close()`
 * (jsdom#3294), so any component using the platform's own modal primitive throws on mount here.
 * This supplies the two methods over the `open` attribute the element already tracks.
 *
 * It deliberately does NOT emulate modality — no focus trap, no inert background, no top layer.
 * Those are the browser's to provide and jsdom cannot assert them, so the browser suite owns
 * that evidence (`apps/web/e2e/speaker-portal.spec.ts` asserts `:modal`). What these tests can
 * and do assert is the behaviour the component is responsible for: that the dialog opens for the
 * right row, closes on Escape and on Close, and refuses to close mid-request.
 */
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(
    this: HTMLDialogElement,
    returnValue?: string,
  ) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}
