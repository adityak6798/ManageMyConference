// @acceptance ACC-IDENTITY-EVENTS
/**
 * The invite form, and the two ways it could have submitted a request the API always refuses.
 *
 * Both were found by automated review rather than by a test, which is the reason they are pinned
 * here: neither is visible from the server side, and neither would have failed anything.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function stub() {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  return {
    posts,
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
      if (url.includes("/members")) return jsonResponse({ members: [], invitations: [] });
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

    const role = await screen.findByLabelText("Role");
    const scope = screen.getByLabelText("Scope");
    // Start from a role an organization invitation cannot carry.
    fireEvent.change(role, { target: { value: "reviewer" } });
    fireEvent.change(scope, { target: { value: "organization" } });

    // The role is clamped, the control is disabled, and the reason is on screen.
    expect(role).toHaveValue("organizer");
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

    const role = await screen.findByLabelText("Role");
    expect(role).not.toBeDisabled();
    fireEvent.change(role, { target: { value: "speaker" } });
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
