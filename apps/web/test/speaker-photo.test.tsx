// @acceptance ACC-SPEAKER
/*
 * The headshot, from the two surfaces that own it.
 *
 * `speaker_profiles.photo_asset_id` was read by the public projection and cleared when its
 * file was deleted, and nothing in the product could ever write it — so "upload a headshot and
 * use it as your profile photo" was a journey with no last step. These cover that step: which
 * control is offered for which file, what it sends, and — the part a speaker actually has to
 * be told — whether choosing it puts their face on the public programme. It does not. That is
 * a separate decision an organizer makes by marking the same file publishable.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentWorkspace } from "../src/ContentWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const profileId = "33333333-3333-4333-8333-333333333333";
const headshotId = "66666666-6666-4666-8666-666666666666";
const slidesId = "77777777-7777-4777-8777-777777777777";

// Held in constants because a literal `role=` prop reads as an ARIA role to the linter.
const ORGANIZER = "organizer" as const;
const SPEAKER = "speaker" as const;

const profile = (photoAssetId?: string) => ({
  id: profileId,
  eventId,
  userId: "user-alex",
  sourcePersonId: "crm-email:alex.morgan@example.test",
  name: "Alex Morgan",
  email: "alex.morgan@example.test",
  bio: "",
  pronouns: "",
  organization: "Greenroom Labs",
  ...(photoAssetId ? { photoAssetId } : {}),
});

const asset = (
  id: string,
  name: string,
  contentType: string,
  visibility: "private" | "publishable" = "private",
) => ({
  id,
  eventId,
  speakerProfileId: profileId,
  name,
  contentType,
  storageKey: `${eventId}/${profileId}/${id}`,
  visibility,
  uploadedAt: "2026-08-10T12:00:00.000Z",
});

function workspace(options: { photoAssetId?: string; headshotPublishable?: boolean } = {}) {
  return {
    sessions: [],
    speakers: [profile(options.photoAssetId)],
    tasks: [],
    assets: [
      asset(
        headshotId,
        "headshot.png",
        "image/png",
        options.headshotPublishable ? "publishable" : "private",
      ),
      asset(slidesId, "slides.pdf", "application/pdf"),
    ],
    messages: [],
  };
}

type Sent = { url: string; method: string; body: unknown };

/** Serves the workspace and records every mutation, so a click can be asserted on the wire. */
function stubApi(
  next: () => unknown,
  failure?: { status: number; body: unknown; when: (url: string) => boolean },
) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET") {
        sent.push({
          url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : {},
        });
        if (failure?.when(url))
          return Promise.resolve(
            new Response(JSON.stringify(failure.body), { status: failure.status }),
          );
      }
      if (url.endsWith(`/api/events/${eventId}/content`))
        return Promise.resolve(new Response(JSON.stringify(next()), { status: 200 }));
      // The checklist panel reads the event's own checklist on mount, exactly as the
      // Accelevents panel reads its status. Unanswered, it would put its own failure notice
      // inside a workspace these tests are asserting something else about.
      if (url.endsWith("/speaker-task-templates"))
        return Promise.resolve(new Response(JSON.stringify({ templates: [] }), { status: 200 }));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("choosing a speaker headshot", () => {
  it("offers the control only for images and sends the speaker's own choice", async () => {
    let current: unknown = workspace();
    const sent = stubApi(() => current);
    render(<ContentWorkspace eventId={eventId} role={SPEAKER} />);

    const uploads = await screen.findByRole("region", { name: "Private uploads" });
    // Nothing is chosen yet, and the card says what that costs on the public page.
    expect(within(uploads).getByText(/You have no profile photo/)).toBeInTheDocument();
    // A slide deck is never offered as a face: the server refuses it, so the UI does not ask.
    expect(within(uploads).queryByRole("button", { name: /slides\.pdf/ })).toBeNull();

    current = workspace({ photoAssetId: headshotId });
    fireEvent.click(within(uploads).getByRole("button", { name: /Use as profile photo/ }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        url: `/api/speaker-profiles/${profileId}/photo`,
        method: "PUT",
        body: { assetId: headshotId },
      }),
    );

    // The confirmation says what the public will see, not merely that a value was stored.
    expect(await within(uploads).findByRole("status")).toHaveTextContent(
      /is now your profile photo\. It is not public yet/,
    );
    // And the card now shows the picture, with the same caveat next to it.
    const preview = within(uploads).getByRole("img", { name: /Your profile photo, headshot\.png/ });
    expect(preview).toHaveAttribute("src", `/api/speaker-assets/${headshotId}`);
    // The same sentence appears in the announcement and beside the picture, because there is
    // one statement of what the public can see and both surfaces quote it.
    expect(
      within(uploads).getAllByText(/programme shows initials until an organizer marks this file/),
    ).toHaveLength(2);
    // Nothing failed, so nothing anywhere on the page says something did.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the photo is public only once the file itself is publishable", async () => {
    stubApi(() => workspace({ photoAssetId: headshotId, headshotPublishable: true }));
    render(<ContentWorkspace eventId={eventId} role={SPEAKER} />);

    const uploads = await screen.findByRole("region", { name: "Private uploads" });
    expect(
      within(uploads).getByText(/It is visible on the published programme\./),
    ).toBeInTheDocument();
    // The choice is reversible from the same control that made it.
    expect(
      within(uploads).getByRole("button", { name: /Remove profile photo/ }),
    ).toBeInTheDocument();
  });

  it("renders the server's field error against the file the speaker picked", async () => {
    const sent = stubApi(() => workspace(), {
      status: 400,
      when: (url) => url.endsWith("/photo"),
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "That file cannot be used as a profile photo.",
          correlationId: "trace-9",
          fieldErrors: { assetId: ["“slides.pdf” is not an image."] },
        },
      },
    });
    render(<ContentWorkspace eventId={eventId} role={SPEAKER} />);

    const uploads = await screen.findByRole("region", { name: "Private uploads" });
    fireEvent.click(within(uploads).getByRole("button", { name: /Use as profile photo/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // The reason the server gave, next to the control that caused it — not a generic failure.
    // A refusal is an alert, not a status: it interrupts, because the speaker's click did not
    // take effect.
    expect(await within(uploads).findByRole("alert")).toHaveTextContent(/is not an image/);
  });

  it("lets an organizer set and clear the headshot from the content workspace", async () => {
    let current: unknown = workspace();
    const sent = stubApi(() => current);
    render(<ContentWorkspace eventId={eventId} role={ORGANIZER} />);

    const assets = await screen.findByRole("region", { name: "Speaker assets" });
    current = workspace({ photoAssetId: headshotId });
    fireEvent.click(
      within(assets).getByRole("button", { name: /Use as profile photo — headshot\.png/ }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        url: `/api/speaker-profiles/${profileId}/photo`,
        method: "PUT",
        body: { assetId: headshotId },
      }),
    );
    expect(await within(assets).findByRole("status")).toHaveTextContent(
      /is now Alex Morgan’s profile photo\. It is not public yet/,
    );

    // Publication is reversible from this table too, and so is the headshot choice.
    current = workspace();
    fireEvent.click(
      within(assets).getByRole("button", { name: /Remove profile photo — headshot\.png/ }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        url: `/api/speaker-profiles/${profileId}/photo`,
        method: "DELETE",
        body: {},
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turns the organizer's publish control into the withdrawal that reverses it", async () => {
    let current: unknown = workspace({ photoAssetId: headshotId, headshotPublishable: true });
    const sent = stubApi(() => current);
    render(<ContentWorkspace eventId={eventId} role={ORGANIZER} />);

    const assets = await screen.findByRole("region", { name: "Speaker assets" });
    current = workspace({ photoAssetId: headshotId });
    fireEvent.click(within(assets).getByRole("button", { name: /Make private — headshot\.png/ }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        url: `/api/speaker-assets/${headshotId}/unpublish`,
        method: "POST",
        body: {},
      }),
    );
    expect(await within(assets).findByRole("status")).toHaveTextContent(
      /is private again and has left the public page/,
    );
  });
});
