// @acceptance ACC-IDENTITY-EVENTS
/**
 * The invite form, and the two ways it could have submitted a request the API always refuses.
 *
 * Both were found by automated review rather than by a test, which is the reason they are pinned
 * here: neither is visible from the server side, and neither would have failed anything.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MembersWorkspace } from "../src/MembersWorkspace";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const otherEventId = "00000000-0000-4000-8000-000000000002";
const member = {
  userId: "u-ada",
  name: "Ada Rivera",
  email: "ada@example.test",
  eventRoles: [
    { eventId, role: "reviewer" },
    { eventId: otherEventId, role: "organizer" },
  ],
};

function stub(members: unknown[] = []) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const writes: { url: string; method: string }[] = [];
  return {
    posts,
    writes,
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET") writes.push({ url, method: init.method });
      if (init?.method === "POST" && url.includes("/invitations")) {
        posts.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return jsonResponse(
          {
            invitation: {
              id: "11111111-1111-4111-8111-111111111111",
              organizationId,
              eventId: null,
              email: "new@example.test",
              role: "organizer",
              invitedByUserId: "u1",
              createdAt: "2026-08-13T00:00:00.000Z",
              expiresAt: "2026-08-20T00:00:00.000Z",
              acceptedAt: null,
              acceptedByUserId: null,
              revokedAt: null,
            },
            token: "the-token",
          },
          201,
        );
      }
      if (url.includes("/audit-events")) return jsonResponse({ events: [] });
      if (url.includes("/members")) return jsonResponse({ members, invitations: [] });
      return jsonResponse({});
    }),
  };
}

describe("inviting somebody from the members workspace", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * An organization invitation is the organizer role, and the control offers only that.
   *
   * `organization_memberships` stores no other role and the contract refuses the combination, so
   * a form that let somebody pick "reviewer" alongside "the whole organization" would build a
   * request the API answers 400 to every time. The control offers what can succeed instead of
   * validating after the fact.
   */
  it("forces the organizer role when the scope is the whole organization", async () => {
    const stubbed = stub();
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<MembersWorkspace organizationId={organizationId} eventId={eventId} />);

    // Both controls are the shared listbox, so a choice is a press on an option rather than a
    // change event on a native element — which is the point: a closed native select on Windows
    // fires a change per arrow key, and this form's scope decides what its role may hold.
    const role = await screen.findByRole("combobox", { name: "Role" });
    const scope = screen.getByRole("combobox", { name: "Scope" });
    // Start from a role an organization invitation cannot carry.
    fireEvent.keyDown(role, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: /^Reviewer/ }));
    fireEvent.keyDown(scope, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "The whole organization" }));

    // The role is clamped, the control is disabled, and the reason is on screen.
    expect(role).toHaveTextContent("Organizer");
    expect(role).toBeDisabled();
    expect(screen.getByText(/Organization membership is the organizer role/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(stubbed.posts).toHaveLength(1));
    // No `eventId` — this is an organization invitation — and the role the contract accepts.
    expect(stubbed.posts[0]?.body).toEqual({ email: "new@example.test", role: "organizer" });
  });

  it("keeps every role available for an invitation onto this event", async () => {
    const stubbed = stub();
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<MembersWorkspace organizationId={organizationId} eventId={eventId} />);

    const role = await screen.findByRole("combobox", { name: "Role" });
    expect(role).not.toBeDisabled();
    fireEvent.keyDown(role, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: /^Speaker/ }));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "sam@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(stubbed.posts).toHaveLength(1));
    expect(stubbed.posts[0]?.body).toEqual({
      email: "sam@example.test",
      role: "speaker",
      eventId,
    });
  });
});

describe("the member row", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * The roles cell and the controls beside it used to describe different scopes.
   *
   * The cell joined every role across every event with no event names, while the Revoke buttons
   * two columns over filtered by `eventId` — so a row said "organizer, reviewer" and offered to
   * revoke one of them, on the page the triage notice links to when a round has no reviewers.
   */
  it("says what somebody holds here, and counts what they hold elsewhere separately", async () => {
    const stubbed = stub([member]);
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<MembersWorkspace organizationId={organizationId} eventId={eventId} />);

    const row = await screen.findByRole("row", { name: /Ada Rivera/ });
    // Only the role held on this event, which is the only one the controls beside it can act on.
    expect(within(row).getByText("Reviewer")).toBeTruthy();
    expect(within(row).queryByText("Organizer")).toBeNull();
    expect(within(row).getByRole("button", { name: "Revoke Reviewer" })).toBeTruthy();
    // The others are a count, not a silent join.
    expect(within(row).getByText("1")).toBeTruthy();
  });

  /**
   * Granting is a privileged write, so it does not happen on a value change.
   *
   * The control this replaced called `setEventRole` from `onChange`: a mis-click was
   * unrecoverable, and arrowing through a closed list on Windows fired one grant per press.
   */
  it("grants a role only when one is chosen from the menu", async () => {
    const stubbed = stub([member]);
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<MembersWorkspace organizationId={organizationId} eventId={eventId} />);

    const trigger = await screen.findByRole("button", { name: "Grant a role to Ada Rivera" });
    fireEvent.click(trigger);
    // Opening the menu writes nothing, and the role already held is not offered again.
    expect(stubbed.writes).toHaveLength(0);
    expect(screen.queryByRole("menuitem", { name: /Reviewer/ })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: /Organizer/ }));
    await waitFor(() => expect(stubbed.writes).toHaveLength(1));
    expect(stubbed.writes[0]?.url).toContain(`/events/${eventId}/roles`);
  });

  /** Removing ends the organization membership, so it is confirmed by name before it happens. */
  it("asks before it removes somebody from the organization", async () => {
    const stubbed = stub([member]);
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<MembersWorkspace organizationId={organizationId} eventId={eventId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from organization" }));
    expect(stubbed.writes).toHaveLength(0);
    expect(screen.getByText(/Remove Ada Rivera\?/)).toBeTruthy();

    // Backing out leaves the membership alone.
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(stubbed.writes).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Remove from organization" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada Rivera" }));
    await waitFor(() => expect(stubbed.writes).toHaveLength(1));
    expect(stubbed.writes[0]?.method).toBe("DELETE");
  });
});
