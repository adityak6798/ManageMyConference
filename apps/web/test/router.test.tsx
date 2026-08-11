// @acceptance ACC-HARNESS
/*
 * The console's router is hand-rolled, so the behaviours a router library would have given
 * away for free are the ones nothing else in this repository checks.
 *
 * Two of them are invisible to the browser suite and are the reason the router exists:
 * a workspace link must stay a *real* link (cmd-click, middle-click and "open in new tab"
 * keep working) while a plain click stays in the SPA, and the back button must move the
 * console rather than leave it on a stale surface. Playwright cannot cheaply assert either —
 * a new tab and a full page load both end up rendering the right thing.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { navigate, useLinkProps, useLocation } from "../src/router";

const target = "/agenda?event=1";

function Probe() {
  const location = useLocation();
  const linkProps = useLinkProps();
  return (
    <>
      <p data-testid="location">{location}</p>
      <a {...linkProps(target)}>Agenda</a>
    </>
  );
}

const shown = () => screen.getByTestId("location").textContent;

/**
 * Clicks the link and reports whether the router claimed the click.
 *
 * The listener runs after React's, so it reads the router's verdict and then stops jsdom
 * from trying to follow the href — which it cannot do, and which would otherwise bury the
 * assertion in "Not implemented: navigation" noise.
 */
function clickLink(init: Partial<MouseEventInit> = {}) {
  let claimed = false;
  const observe = (event: Event) => {
    claimed = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", observe);
  fireEvent.click(screen.getByRole("link", { name: "Agenda" }), init);
  window.removeEventListener("click", observe);
  return claimed;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // jsdom has no layout, so the scroll-to-top a real navigation performs would throw.
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps a plain click inside the app and moves the URL with it", () => {
  render(<Probe />);

  expect(clickLink()).toBe(true);
  expect(window.location.pathname + window.location.search).toBe(target);
  expect(shown()).toBe(target);
});

for (const [description, init] of [
  ["cmd-click", { metaKey: true }],
  ["ctrl-click", { ctrlKey: true }],
  ["shift-click", { shiftKey: true }],
  ["alt-click", { altKey: true }],
  ["a middle click", { button: 1 }],
] as const) {
  it(`leaves ${description} to the browser, so the link opens the way the user asked`, () => {
    render(<Probe />);

    // Unclaimed: the anchor's href does the work, in a new tab or a new window.
    expect(clickLink(init)).toBe(false);
    expect(window.location.pathname).toBe("/");
    expect(shown()).toBe("/");
  });
}

/**
 * A real Back, not a hand-dispatched event: `history.back()` is the one path that does not
 * go through the patched `pushState`/`replaceState`, so only the router's own popstate
 * subscription can bring the console with it. jsdom queues the traversal, so this waits for
 * the browser's own event rather than for a guessed number of ticks.
 */
async function goBack() {
  await act(async () => {
    const traversed = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    window.history.back();
    await traversed;
  });
}

it("re-renders on the back button rather than stranding the console on the old surface", async () => {
  render(<Probe />);
  // jsdom keeps one session history for the whole file, so the entry to come back to is
  // pushed here rather than assumed.
  act(() => navigate("/reviews"));

  clickLink();
  expect(shown()).toBe(target);

  await goBack();

  expect(shown()).toBe("/reviews");
});

it("replaces rather than stacks when asked, so Back is not swallowed by a redirect", async () => {
  render(<Probe />);
  act(() => navigate("/overview"));
  act(() => navigate("/reviews"));

  // The persona and event-selection redirects fire from an effect on almost every render.
  act(() => navigate("/speakers", { replace: true }));
  expect(shown()).toBe("/speakers");

  await goBack();

  // Back leaves the redirect behind. Had `replace` pushed, the user would land on /reviews,
  // the redirect would fire again, and Back would be a trap with no way out.
  expect(shown()).toBe("/overview");
});

it("ignores a navigation to where it already is", async () => {
  render(<Probe />);
  act(() => navigate("/overview"));
  act(() => navigate("/publishing"));

  // Re-selecting the same event re-runs `navigate` with an unchanged URL.
  act(() => navigate("/publishing"));
  expect(shown()).toBe("/publishing");

  await goBack();

  // One duplicate entry per redundant navigation would make Back appear to do nothing.
  expect(shown()).toBe("/overview");
});
