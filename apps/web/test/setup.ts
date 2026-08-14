import "@testing-library/jest-dom/vitest";

/*
 * jsdom has no `window.scrollTo`, and `router.ts` calls it on every navigation.
 *
 * jsdom answers an unimplemented method by emitting an error on its virtual console rather than
 * by throwing at the call site, so the navigation itself succeeds and the error surfaces
 * asynchronously — attributed by vitest to whichever test happens to be running when it lands.
 * That is why it presented as an unrelated CFP window test failing roughly one run in six while
 * passing ten out of ten in isolation: the test named in the failure was a bystander.
 *
 * A no-op is the whole of what is wanted. Scroll position is not something jsdom can assert, and
 * no test here asserts it; what matters is that navigating does not poison the run. The browser
 * suite is where scroll behaviour would be observable at all.
 */
if (typeof window !== "undefined") {
  // Assigned unconditionally: jsdom *defines* `scrollTo` and throws inside it, so a
  // `!window.scrollTo` guard skips the replacement and changes nothing. A first attempt at this
  // did exactly that and measured no improvement.
  window.scrollTo = () => undefined;
}

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
