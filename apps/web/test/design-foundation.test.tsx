// @acceptance ACC-DEMO-SMOKE ACC-OPS
import type { EventDto, SessionDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/AppShell";
import {
  DataList,
  DataListRow,
  Drawer,
  HubTabs,
  ListDetail,
  Pill,
  Skeleton,
} from "../src/ui/primitives";
import { HUB_PATHS, hubTabHref } from "../src/workspaces/contract";

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

  it("composes list/detail, dense rows, status, and stable loading semantics", () => {
    render(
      <ListDetail
        listLabel="Proposals"
        detailLabel="Selected proposal"
        list={
          <DataList label="Proposal results">
            <DataListRow title="Typed boundaries" metadata="Jordan Lee" status={<Pill>New</Pill>} />
          </DataList>
        }
        detail={<Skeleton label="Loading selected proposal" height={40} />}
      />,
    );

    expect(screen.getByRole("region", { name: "Proposals" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected proposal" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Proposal results" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading selected proposal" })).toBeInTheDocument();
  });

  it("labels a drawer, handles Escape, and blocks dismissal while busy", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Drawer open title="Edit proposal" onClose={onClose}>
        Proposal fields
      </Drawer>,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit proposal" });
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

    fireEvent.click(screen.getByLabelText("Account actions for organizer"));
    expect(screen.getByText(/instance/i)).toBeVisible();
  });
});
