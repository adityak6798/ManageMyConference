// @acceptance ACC-DEMO-SMOKE ACC-OPS
import type { EventDto, SessionDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { AppShell } from "../src/AppShell";
import { Checkbox, Combobox, CopyableSecret, SegmentedControl, Select } from "../src/ui/fields";
import { Menu } from "../src/ui/menu";
import {
  Drawer,
  GutterList,
  GutterRow,
  HubTabs,
  LoadFailure,
  Notice,
  Outcome,
  Refusal,
  Section,
  SkeletonRows,
} from "../src/ui/primitives";
import { scheduleAgendaHref, scheduleAgendaTab } from "../src/workspaces/agenda";
import { programFormsHref, programFormsTab } from "../src/workspaces/cfp";
import { scheduleSessionsHref, scheduleSessionsTab } from "../src/workspaces/content";
import { HUB_PATHS, hubTabHref } from "../src/workspaces/contract";
import { hubTabForSelection, hubTabsFor } from "../src/workspaces/registry";
import {
  programReviewHref,
  programReviewTab,
  programSubmissionsHref,
  programSubmissionsTab,
} from "../src/workspaces/review";

/**
 * The shell stylesheet as text.
 *
 * jsdom applies no cascade, so what a `<button>` looks like is only observable from what the
 * stylesheet declares. Vitest resolves `?raw` on a `.css` file to an empty string, and the runner
 * can be started from either the repository root or this workspace, so the file is found by trying
 * both roots rather than by trusting one working directory.
 */
function source(path: string) {
  return readFileSync([`apps/web/${path}`, path].find(existsSync) ?? "", "utf8");
}

const shellCss = source("src/styles/shell.css");
const controlsCss = source("src/styles/controls.css");
const tokensCss = source("src/styles/tokens.css");
const agendaCss = source("src/styles/agenda.css");

/**
 * The declarations of the rule whose selector list starts with `selector`.
 *
 * Anchored on the newline and closed on the first `{`, so `.control:disabled` finds the rule it
 * heads and never a longer selector that merely begins with the same characters. A selector that
 * declares nothing throws rather than returning "", because an assertion against an empty rule
 * body passes for every value it could have held.
 */
function rule(sheet: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`\\n${escaped}[,\\s][^{]*\\{([^}]*)\\}`).exec(sheet)?.[1];
  if (!found?.trim()) throw new Error(`No rule declares ${selector}`);
  return found;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("design foundation", () => {
  it("builds stable, encoded hub links", () => {
    expect(HUB_PATHS.program).toBe("/program");
    expect(hubTabHref("program", "submission review")).toBe("/program?tab=submission+review");
  });

  it("accepts the domain-owned Program and Schedule integration exports", () => {
    expect([programFormsTab, programSubmissionsTab, programReviewTab]).toMatchObject([
      { hub: "program", tab: "forms", legacyPaths: ["/cfp"] },
      { hub: "program", tab: "submissions", legacyPaths: ["/abstracts"] },
      { hub: "program", tab: "review", legacyPaths: [] },
    ]);
    expect([scheduleSessionsTab, scheduleAgendaTab]).toMatchObject([
      { hub: "schedule", tab: "sessions", legacyPaths: ["/sessions"] },
      { hub: "schedule", tab: "agenda", legacyPaths: ["/agenda"] },
    ]);
    expect([
      programFormsHref,
      programSubmissionsHref,
      programReviewHref,
      scheduleSessionsHref,
      scheduleAgendaHref,
    ]).toEqual([
      "/program?tab=forms",
      "/program?tab=submissions",
      "/program?tab=review",
      "/schedule?tab=sessions",
      "/schedule?tab=agenda",
    ]);
  });

  it("renders shareable hub tabs with one current destination", () => {
    render(
      <HubTabs
        label="Program jobs"
        active="forms"
        items={[
          { id: "forms", label: "Forms", href: "/program?tab=forms", count: 2 },
          { id: "review", label: "Review", href: "/program?tab=review" },
        ]}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Program jobs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forms 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Review" })).not.toHaveAttribute("aria-current");
  });

  it("brings the current hub tab into view on narrow, scrollable tab strips", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      render(
        <HubTabs
          label="Settings jobs"
          active="activity"
          items={[
            { id: "event", label: "Event", href: "/settings?tab=event" },
            { id: "team", label: "Team", href: "/settings?tab=team" },
            { id: "activity", label: "Activity", href: "/settings?tab=activity" },
          ]}
        />,
      );

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    } finally {
      if (original)
        Object.defineProperty(Element.prototype, "scrollIntoView", {
          configurable: true,
          value: original,
        });
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("resolves compatibility aliases to an advertised current tab", () => {
    const visible = hubTabsFor("people", "organizer");
    const selected = hubTabForSelection("people", "files", "organizer");

    expect(visible.map(({ tab }) => tab)).toContain("speakers");
    expect(visible.map(({ tab }) => tab)).not.toContain("files");
    expect(selected?.tab).toBe("speakers");
  });

  it("names a borderless region without wrapping it in a card", () => {
    const { container } = render(
      <Section
        labelledBy="today-heading"
        title="Today"
        description="Everything the run sheet expects before doors."
        actions={
          <button type="button" className="secondary">
            Export
          </button>
        }
      >
        <p>Two rooms, four sessions.</p>
      </Section>,
    );

    const region = screen.getByRole("region", { name: "Today" });
    expect(region).toHaveClass("section");
    // The rule the primitive exists to make keepable: a default region is not a card.
    expect(region).not.toHaveClass("card");
    expect(container.querySelector(".card")).toBeNull();
    expect(screen.getByText("Everything the run sheet expects before doors.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("carries one measure per row in the cue gutter and marks the current row", () => {
    const { container } = render(
      <GutterList label="Run sheet">
        <GutterRow measure="09:45" measureLabel="Starts" title="Doors" />
        <GutterRow measure="10:00" measureLabel="Starts" title="Keynote" active />
      </GutterList>,
    );

    expect(screen.getByRole("list", { name: "Run sheet" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // The label names the figure and the figure is still announced: the caption is a prefix,
    // the way a column heading precedes its cell, not a replacement for the value.
    expect(rows[0]?.querySelector(".visually-hidden")).toHaveTextContent("Starts");
    expect(rows[0]?.querySelector(".figure")).toHaveTextContent("Starts 09:45");
    expect(rows[0]?.querySelector(".figure [aria-hidden]")).toBeNull();
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(container.querySelectorAll(".gutter .figure")).toHaveLength(2);
  });

  it("keeps a wait shaped like the data it is waiting for", () => {
    const { container } = render(<SkeletonRows rows={3} label="Loading the run sheet" />);

    expect(screen.getByRole("status", { name: "Loading the run sheet" })).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton-row")).toHaveLength(3);
    // Shimmer bars are decoration; only the one live region speaks.
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("states a refusal as a missing capability rather than as an empty area", () => {
    render(
      <Refusal capability="the organizer role" grantedBy="An organization owner">
        Settings stay restricted to organizers.
      </Refusal>,
    );

    expect(screen.getByRole("heading", { name: "You do not have access" })).toBeInTheDocument();
    expect(
      screen.getByText("Needs the organizer role. An organization owner can grant it."),
    ).toBeInTheDocument();
  });

  it("interrupts for a failed outcome and stays polite for a successful one", () => {
    const { rerender } = render(
      <Outcome tone="success" title="The invitation is accepted">
        Your access is live from your next request.
      </Outcome>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The invitation is accepted");

    rerender(
      <Outcome tone="failure" title="The invitation was not accepted">
        The link has expired.
      </Outcome>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The invitation was not accepted");
  });

  it("gives a warning the same interruption as an error, and a notice a way out", () => {
    const onDismiss = vi.fn();
    render(
      <Notice tone="warn" title="Not published yet" onDismiss={onDismiss} dismissLabel="Dismiss">
        Applicants cannot see this form.
      </Notice>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Not published yet");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("offers a retry when a read did not come back", async () => {
    const onRetry = vi.fn(() => Promise.reject(new Error("still down")));
    render(
      <LoadFailure
        what="the agenda"
        error="The agenda service is unreachable."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The agenda could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // The rejection belongs to the caller's load state; the button must not leave it unhandled.
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  });

  it("keeps a correlation reference selectable instead of gluing it to the sentence", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <LoadFailure
        what="the member list"
        error="The member list could not be loaded."
        reference="01JD8Q4M0V6ZC3XK2N7T5RB9WE"
      />,
    );

    // The message stays a sentence: the identifier is its own element, not a clause on the end.
    const alert = screen.getByRole("alert");
    expect(alert.querySelector(".notice-text")).toHaveTextContent(
      "The member list could not be loaded.",
    );
    expect(alert.querySelector(".notice-text")).not.toHaveTextContent("01JD8Q");
    expect(alert.querySelector(".notice-reference code")).toHaveTextContent(
      "01JD8Q4M0V6ZC3XK2N7T5RB9WE",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy the reference" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("01JD8Q4M0V6ZC3XK2N7T5RB9WE"));
  });

  it("answers a refused clipboard rather than doing nothing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(
      <Notice tone="error" reference="01JD8Q4M0V6ZC3XK2N7T5RB9WE">
        The invitation could not be sent.
      </Notice>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy the reference" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "This browser refused the clipboard. Select the reference and copy it.",
      ),
    );
  });

  it("resets a bare button instead of painting every button in the app green", () => {
    const bareButtonRule = /\n:where\(button\) \{([^}]*)\}/.exec(shellCss);

    expect(bareButtonRule).not.toBeNull();
    // A <button> with no class is chrome-free: no fill, no border, no colour of its own, and it
    // sits in :where() so a workspace class beats it with one class name.
    expect(bareButtonRule?.[1]).toContain("background: none");
    expect(bareButtonRule?.[1]).not.toMatch(/background:\s*var\(--green/);
    // Green is opted in to by name, and every variant is a class.
    expect(shellCss).toMatch(/:where\(\.btn, button\.primary,/);
    expect(shellCss).toMatch(/button\.danger,/);
    // A tab no longer needs `button.tab` to out-specify the shared button rules.
    expect(shellCss).not.toMatch(/\nbutton\.tab \{/);
  });

  it("declares every class the control tier renders in the sheet the tier loads", () => {
    /*
     * `ui/fields.tsx` and `ui/menu.tsx` load controls.css themselves so that any surface —
     * console, portal or public page — that renders a control gets the tier with it. A class
     * declared only in shell.css breaks that promise silently: shell.css is reachable only
     * through styles.css, which only App.tsx imports, and `main.tsx` routes every `/events/*`
     * path to a public root that never evaluates App.tsx. `CopyableSecret` shipped its copy
     * button as `secondary small`, so on the public call for proposals the button beside an
     * anonymous submitter's confirmation reference matched nothing and fell back to the
     * operating system's own chrome. The classes are collected from the rendered DOM rather
     * than read out of the source, so a class assembled at runtime is caught too.
     */
    const declared = new Set<string>();
    // Comments are stripped first, so a class the file only talks about does not count as one
    // the file declares.
    for (const sheet of [controlsCss, tokensCss])
      for (const match of sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-z][\w-]*)/g))
        declared.add(match[1] ?? "");

    const { container } = render(
      <div>
        <Select
          label="Track"
          hint="Where the session runs"
          value="main"
          options={[{ value: "main", label: "Main stage", hint: "1 of 2" }]}
          onChange={vi.fn()}
        />
        <Combobox
          label="Event timezone"
          value="UTC"
          options={[{ value: "UTC", label: "UTC" }]}
          onChange={vi.fn()}
        />
        <Checkbox label="Notify the speaker" hint="Sends on save" checked onChange={vi.fn()} />
        <SegmentedControl
          label="Score"
          numeric
          value="3"
          options={[{ value: "3", label: "3" }]}
          onChange={vi.fn()}
          onClear={vi.fn()}
        />
        <CopyableSecret label="Signing secret" value="whsec_01JD8Q4M0V" />
        <Menu
          label="Row actions"
          items={[
            { id: "duplicate", label: "Duplicate", onSelect: vi.fn(), hint: "Copies the row" },
            { id: "sep", separator: true },
            { id: "delete", label: "Delete", onSelect: vi.fn(), danger: true },
          ]}
        />
      </div>,
    );
    // The popovers are half the tier and only exist while open.
    fireEvent.keyDown(screen.getByLabelText("Track"), { key: "Enter" });
    fireEvent.keyDown(screen.getByLabelText("Event timezone"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Row actions" }), { key: "ArrowDown" });

    const rendered = new Set<string>();
    for (const node of container.querySelectorAll("[class]"))
      for (const name of node.getAttribute("class")?.split(/\s+/) ?? [])
        if (name) rendered.add(name);

    expect(rendered.size).toBeGreaterThan(20);
    expect([...rendered].filter((name) => !declared.has(name))).toEqual([]);
  });

  it("keeps every text a reader has to read out of the placeholder grey", () => {
    /*
     * `--ink-4` is declared for placeholders and disabled glyphs, "which must never carry text a
     * reader has to read", and it measures 2.81:1 on `--surface` — below AA. Each rule below was
     * moved off it because it is the *entire* visible content of the thing it draws: the trigger
     * of an unanswered select, the instruction in a 400-entry filter, the "Choose a date" of every
     * unfilled date field (whose native input is `opacity: 0; color: transparent`, so the span is
     * all there is to see), and the duration under each agenda row's start time.
     *
     * Pinned as declarations rather than as a ratio because jsdom applies no cascade: tokens.test
     * already holds `--slate` to 4.5:1 on all three grounds, so naming the token is what carries
     * the contrast decision. Without this a revert to `--ink-4` passed every gate in the repo.
     */
    for (const [selector, sheet] of [
      [".select-value.is-placeholder", controlsCss],
      [".combobox-input::placeholder", controlsCss],
      [".datetime-value.is-empty", controlsCss],
      [".agenda .board-duration", agendaCss],
    ] as const)
      expect(rule(sheet, selector), selector).toContain("color: var(--slate)");
  });

  it("gives a disabled control one disabled treatment, not the console's fade over its own", () => {
    /*
     * shell.css fades every disabled button with a blanket `opacity: 0.55`, which is the exact
     * treatment these two rules were written to reject — it dims ground, border and label
     * together and lands the label at roughly 2.4:1. A class beats an element selector, so the
     * tier's colours win, but `opacity` is a property the tier never declared: the fade composed
     * on top of the inset ground and the same Copy button read differently on the console than on
     * the public call for proposals, which loads no shell.css at all.
     */
    for (const selector of [".control-button:disabled", ".control:disabled"])
      expect(rule(controlsCss, selector), selector).toContain("opacity: 1");
  });

  it("places the menu popover against the viewport, not inside the table that clips it", () => {
    const popover = /\n\.menu-popover \{([^}]*)\}/.exec(controlsCss)?.[1] ?? "";

    /*
     * `.table-wrap` declares `overflow-x: auto` and nothing for the other axis, which computes
     * `overflow-y` to `auto` as well, so an absolutely-positioned popover opened from the last
     * row of a members or roles table was clipped by the table and the focus call that rescued
     * it scrolled the rows under their own sticky header. No overflow value on the wrapper
     * fixes it, so the popover is placed in viewport coordinates by `ui/menu.tsx` instead.
     */
    const wrap = /\n\.table-wrap \{([\s\S]*?)\n\}/.exec(shellCss)?.[1] ?? "";
    expect(wrap).toContain("overflow-x: auto");
    expect(popover).toContain("position: fixed");
    expect(popover).not.toContain("top: calc(100%");
  });

  it("labels a drawer, handles Escape, and blocks dismissal while busy", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Drawer
        open
        title="Edit proposal"
        description="Update the selected record."
        onClose={onClose}
      >
        Proposal fields
      </Drawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit proposal" });
    expect(dialog).toHaveAccessibleDescription("Update the selected record.");
    expect(dialog).toHaveAttribute("open");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    rerender(
      <Drawer open title="Edit proposal" busy onClose={onClose}>
        Proposal fields
      </Drawer>,
    );
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Edit proposal" })).toBeDisabled();
  });

  it("keeps an open drawer open when React re-runs its effects", () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Drawer open title="Edit proposal" onClose={onClose}>
          Proposal fields
        </Drawer>
      </StrictMode>,
    );

    /*
     * StrictMode double-invokes every effect — mount, tear down, mount again — to surface
     * cleanups that do not belong on a re-run. The drawer's did: it closed the dialog on every
     * cleanup, so the simulated teardown fired the platform's `close` event while `open` was
     * still true, the component reported the close to its caller, and a drawer nobody had
     * dismissed shut itself the moment it was rendered.
     */
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit proposal" })).toHaveAttribute("open");
  });

  it("still closes a drawer a caller unmounts while it is open", () => {
    // The safety net the effect above exists for: `{x ? <Drawer …/> : null}` detaches a dialog
    // the platform still holds as modal, and an open dialog that has left the document keeps its
    // backdrop and its top-layer entry. The element is held here because the assertion is about
    // what happened to a node the render tree no longer has.
    const { rerender } = render(
      <Drawer open title="Edit proposal" onClose={vi.fn()}>
        Proposal fields
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit proposal" });

    rerender(<div />);

    expect(dialog.isConnected).toBe(false);
    expect(dialog).not.toHaveAttribute("open");
  });

  it("opens the mobile workspace drawer and restores focus after Escape", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const event = {
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      name: "Greenroom Summit",
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-15T00:00:00.000Z",
    } satisfies EventDto;
    const session = {
      actor: { id: "organizer", name: "Olivia Organizer", persona: "organizer" },
      organizations: [{ id: event.organizationId, name: "Greenroom" }],
      eventAccess: [{ eventId: event.id, role: "organizer", capabilities: ["events:read"] }],
      capabilities: ["events:read"],
    } as unknown as SessionDto;

    render(
      <AppShell
        session={session}
        events={[event]}
        selectedEventId={event.id}
        onSelectEvent={() => undefined}
        onSwitchPersona={() => undefined}
        busy={false}
        groups={[{ items: [{ href: "/", label: "Overview", icon: <span>O</span> }] }]}
        activePath="/"
        publicHref={null}
      >
        Page
      </AppShell>,
    );

    const trigger = screen.getByRole("button", { name: "Open workspace navigation" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Workspace")).toHaveAttribute("data-mobile-open", "true");
    await waitFor(() =>
      expect(screen.getByText("Skip to main content")).toHaveProperty("inert", true),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByText("Skip to main content")).toHaveProperty("inert", false);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());

    // The topbar's five controls collapsed into one account control named for the person, not the
    // persona: a signed-in reader recognises their own name where they never recognised "organizer".
    fireEvent.click(screen.getByRole("button", { name: /^Account and access/ }));
    expect(screen.getByText(/instance/i)).toBeVisible();

    // Nothing in the shell relies on the old green element default: every control says what it is.
    expect(document.querySelectorAll("button:not([class])")).toHaveLength(0);
  });
});
