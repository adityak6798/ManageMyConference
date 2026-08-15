// @acceptance ACC-SPEAKER
import type { ContentWorkspaceDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as contentApi from "../src/api/content";
import { SessionEditor } from "../src/content/SessionEditor";
import { SpeakerOutreach } from "../src/content/SpeakerOutreach";

vi.mock("../src/api/content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/content")>()),
  setSpeakerProfilePhoto: vi.fn(),
  updateSpeakerProfile: vi.fn(),
}));

const EVENT_ID = "123e4567-e89b-42d3-a456-426614174000";

type Workspace = ContentWorkspaceDto;
type Speaker = Workspace["speakers"][number];

function speaker(
  seed: number,
  name: string,
  organization: string,
  workflowStatus: NonNullable<Speaker["workflowStatus"]>,
): Speaker {
  return {
    id: `123e4567-e89b-42d3-a456-${String(seed).padStart(12, "0")}`,
    eventId: EVENT_ID,
    userId: `speaker-${seed}`,
    sourcePersonId: `proposal-${seed}`,
    name,
    email: `speaker-${seed}@example.test`,
    bio: "",
    pronouns: "",
    jobTitle: "",
    organization,
    version: 0,
    workflowStatus,
    logistics: {},
    customFields: {},
  };
}

function workspace(): Workspace {
  return {
    sessions: [],
    speakers: [
      speaker(1, "Priya Raman", "Eastwind Studio", "ready"),
      speaker(2, "Morgan Lee", "Eastwind Studio", "onboarding"),
      speaker(3, "Ravi Shah", "Northwind Access", "ready"),
      speaker(4, "Taylor Kim", "Contoso", "blocked"),
    ],
    tasks: [],
    assets: [],
    messages: [],
    resources: [],
    comments: [],
    revisions: [],
    actorDirectory: [],
  };
}

const run = async (action: () => Promise<unknown>) => {
  await action();
  return { ok: true as const };
};

function names() {
  const roster = screen.getByRole("region", { name: "Speakers" });
  return within(roster)
    .queryAllByRole("checkbox", { name: /for a portal invitation$/ })
    .map((checkbox) => checkbox.getAttribute("aria-label")?.replace(/^Select | for.*$/g, ""));
}

afterEach(() => {
  cleanup();
  vi.mocked(contentApi.setSpeakerProfilePhoto).mockReset();
  vi.mocked(contentApi.updateSpeakerProfile).mockReset();
});

describe("the accepted-speaker roster", () => {
  it("omits untouched hidden collection fallbacks from a session update", () => {
    const session: ContentWorkspaceDto["sessions"][number] = {
      id: "44444444-4444-4444-8444-444444444444",
      eventId: EVENT_ID,
      proposalId: "11111111-1111-4111-8111-111111111111",
      title: "Original title",
      abstract: "Visible abstract",
      format: "Talk",
      speakerProfileIds: [],
      publicationState: "draft",
      // tags and tracks are intentionally absent: a Hide policy produces this wire shape even
      // when the stored collections are nonempty.
    };
    const onSave = vi.fn();
    render(
      <SessionEditor
        session={session}
        speakers={[]}
        busy={false}
        onSave={onSave}
        onClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("Session title"), {
      target: { value: "Allowed title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    expect(onSave).toHaveBeenCalledWith({ title: "Allowed title" });
  });

  it("searches speaker names and companies, composes with readiness, and restores the roster", () => {
    render(<SpeakerOutreach workspace={workspace()} busy={false} run={run} />);

    const roster = screen.getByRole("region", { name: "Speakers" });
    const search = within(roster).getByLabelText("Search speaker roster");
    const readiness = within(roster).getByLabelText("Speaker readiness");

    expect(names()).toEqual(["Priya Raman", "Morgan Lee", "Ravi Shah", "Taylor Kim"]);
    expect(within(roster).getByText("4 of 4 speakers")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "Priya" } });
    expect(names()).toEqual(["Priya Raman"]);

    fireEvent.change(search, { target: { value: "Raman" } });
    expect(names()).toEqual(["Priya Raman"]);

    fireEvent.change(search, { target: { value: "eastwind studio" } });
    expect(names()).toEqual(["Priya Raman", "Morgan Lee"]);

    fireEvent.change(readiness, { target: { value: "ready" } });
    expect(names()).toEqual(["Priya Raman"]);
    expect(within(roster).getByText("1 of 4 speakers")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    expect(names()).toEqual(["Priya Raman", "Ravi Shah"]);

    fireEvent.change(readiness, { target: { value: "all" } });
    expect(names()).toEqual(["Priya Raman", "Morgan Lee", "Ravi Shah", "Taylor Kim"]);
  });

  it("shows an explicit empty state and selects only the filtered roster", () => {
    render(<SpeakerOutreach workspace={workspace()} busy={false} run={run} />);
    const roster = screen.getByRole("region", { name: "Speakers" });

    fireEvent.change(within(roster).getByLabelText("Search speaker roster"), {
      target: { value: "Eastwind" },
    });
    fireEvent.click(within(roster).getByLabelText("Select every speaker on this roster"));
    expect(within(roster).getByRole("button", { name: "Invite 2 speakers" })).toBeEnabled();

    fireEvent.change(within(roster).getByLabelText("Speaker readiness"), {
      target: { value: "blocked" },
    });
    expect(within(roster).getByText("No speakers match")).toBeInTheDocument();
    expect(within(roster).queryByRole("button", { name: /Invite/ })).toBeNull();
  });

  it("edits the same versioned profile and headshot contract the speaker portal uses", async () => {
    const current = workspace();
    const priya = current.speakers[0];
    if (!priya) throw new Error("The profile fixture is missing");
    priya.version = 7;
    current.assets.push({
      id: "223e4567-e89b-42d3-a456-426614174000",
      eventId: EVENT_ID,
      speakerProfileId: priya.id,
      name: "priya.png",
      contentType: "image/png",
      storageKey: "speakers/priya.png",
      visibility: "private",
      uploadedAt: "2026-08-10T12:00:00.000Z",
      versionGroupId: "223e4567-e89b-42d3-a456-426614174000",
      versionNumber: 1,
      isLatest: true,
    });
    vi.mocked(contentApi.updateSpeakerProfile).mockResolvedValue(undefined);
    vi.mocked(contentApi.setSpeakerProfilePhoto).mockResolvedValue(undefined);
    render(<SpeakerOutreach workspace={current} busy={false} run={run} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit profile for Priya Raman" }));
    expect(screen.getByText(/same canonical profile the speaker edits/)).toHaveTextContent(
      "Version 7",
    );
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Design Director" },
    });
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Eastwind Cooperative" },
    });
    fireEvent.change(screen.getByLabelText("Bio"), {
      target: { value: "Priya designs calm conference operations." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save canonical profile" }));

    await waitFor(() =>
      expect(contentApi.updateSpeakerProfile).toHaveBeenCalledWith(
        priya.id,
        expect.objectContaining({
          bio: "Priya designs calm conference operations.",
          jobTitle: "Design Director",
          organization: "Eastwind Cooperative",
          expectedVersion: 7,
        }),
      ),
    );
    expect(vi.mocked(contentApi.updateSpeakerProfile).mock.calls[0]?.[1]).not.toHaveProperty(
      "socialLinks",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use priya.png" }));
    await waitFor(() =>
      expect(contentApi.setSpeakerProfilePhoto).toHaveBeenCalledWith(
        priya.id,
        "223e4567-e89b-42d3-a456-426614174000",
        8,
      ),
    );
  });
});
