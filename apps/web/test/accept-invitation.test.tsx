// @acceptance ACC-IDENTITY-EVENTS
/**
 * The surface an invitation link lands on.
 *
 * It exists because the link has to lead somewhere: the organizer is told to copy a URL and send
 * it, and a URL that resolved to nothing would discard the token and strand the invitee on
 * whatever their home workspace happened to be. That is what these cases pin — that the route is
 * reachable at all, that it reads the token out of the link, and that it is reachable by the
 * personas who are actually invited.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const eventId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000010";
const event = {
  id: eventId,
  organizationId,
  name: "Greenroom Demo Summit",
  timezone: "UTC",
  createdAt: "2026-08-09T12:00:00.000Z",
};

const sessionFor = (persona: "organizer" | "reviewer") => ({
  actor: { id: `seed-${persona}`, name: "Someone", persona },
  organizations: persona === "organizer" ? [{ id: organizationId }] : [],
  eventAccess: [
    {
      eventId,
      role: persona,
      capabilities: persona === "organizer" ? ["events:read", "identity:manage"] : ["events:read"],
    },
  ],
  capabilities: persona === "organizer" ? ["events:read", "identity:manage"] : ["events:read"],
  authentication: "session" as const,
});

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

function stub(persona: "organizer" | "reviewer", accept: () => Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  return {
    calls,
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/invitations/accept")) {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return accept();
      }
      if (url.endsWith("/api/session")) return jsonResponse(sessionFor(persona));
      if (url.includes("/api/events")) return jsonResponse({ events: [event] });
      return jsonResponse({});
    }),
  };
}

describe("accepting an invitation from its link", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/invitations/accept?token=the-token");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  /**
   * The route survives the allowlist redirect.
   *
   * Every other unknown path is bounced to the persona's home, which is what silently discarded
   * the token before this surface existed. A **reviewer** drives this case on purpose: reviewers
   * are who invitations are usually for, and they can reach neither `/settings` nor the members
   * workspace, so if the redirect applied here they would have nowhere at all to accept.
   */
  it("renders for a reviewer and reads the token out of the link", async () => {
    const stubbed = stub("reviewer", () =>
      jsonResponse({ organizationId, eventId, role: "reviewer" }),
    );
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Accept an invitation" }),
    ).toBeInTheDocument();
    // Prefilled from `?token=`, so following the link is the whole interaction.
    expect(screen.getByLabelText("Invitation token")).toHaveValue("the-token");

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(stubbed.calls).toHaveLength(1));
    // The body carries the token and nothing else: the token says which invitation and the
    // session says who. A field naming the person would be the address-lookup acceptance the
    // authorization rules forbid.
    expect(stubbed.calls[0]?.body).toEqual({ token: "the-token" });
    expect(await screen.findByText("The invitation is accepted")).toBeInTheDocument();
  });

  it("explains a refusal and leaves the token in place to retry", async () => {
    const stubbed = stub("reviewer", () =>
      jsonResponse(
        {
          error: {
            code: "NOT_FOUND",
            message: "That invitation is not valid.",
            correlationId: "corr-1",
          },
        },
        404,
      ),
    );
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Accept an invitation" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    const refusal = await screen.findByText(/That invitation is not valid/);
    // The correlation reference, as every console failure carries.
    expect(refusal.textContent).toContain("corr-1");
    expect(screen.getByLabelText("Invitation token")).toHaveValue("the-token");
  });

  it("is reachable with no token in the link, for a code pasted by hand", async () => {
    window.history.replaceState(null, "", "/invitations/accept");
    const stubbed = stub("organizer", () =>
      jsonResponse({ organizationId, eventId: null, role: "organizer" }),
    );
    vi.stubGlobal("fetch", stubbed.fetch);
    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Accept an invitation" }),
    ).toBeInTheDocument();
    const field = screen.getByLabelText("Invitation token");
    // Nothing to submit until there is a token, so the control says so rather than failing.
    // Awaited rather than asserted at once: the field is seeded from the link in a passive
    // effect, so it is findable before that effect has run — and the effect's `setToken("")` then
    // lands *after* the change below and silently clears what was typed, leaving the Accept
    // button disabled and no request made at all. 1 failure in 86 loaded runs; see issue #200,
    // which this does not close.
    await waitFor(() => expect(field).toHaveValue(""));
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled());
    fireEvent.change(field, { target: { value: "pasted-token" } });
    await waitFor(() => expect(field).toHaveValue("pasted-token"));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(stubbed.calls[0]?.body).toEqual({ token: "pasted-token" }));
  });
});
