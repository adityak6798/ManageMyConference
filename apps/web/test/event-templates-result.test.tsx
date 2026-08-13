// @acceptance ACC-EVENT-TEMPLATES
/**
 * Two things the template console must not say to an organizer.
 *
 * It must not print this system's identifiers — a slice key or a bare account id — as if they
 * were words for people, and it must not title an application "Applied" while the breakdown
 * directly beneath it names a category the destination refused. The second is the one that gets
 * lost: the heading is easy to take from the envelope, and the envelope's vocabulary belongs to
 * the server, which may widen it (`ARC-FLOW-006`).
 */
import type { EventTemplateDto, EventTemplateVersionDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventTemplatesWorkspace } from "../src/events/EventTemplatesWorkspace";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "123e4567-e89b-12d3-a456-426614174000";
const templateId = "223e4567-e89b-42d3-a456-426614174001";
const versionId = "323e4567-e89b-42d3-a456-426614174002";
const sourceEventId = "423e4567-e89b-42d3-a456-426614174003";

const template = {
  id: templateId,
  organizationId,
  name: "Annual summit starter",
  state: "active" as const,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
};

/** The seeded template's own six categories, in the order the API reports them. */
const version = {
  id: versionId,
  version: 1,
  sourceEventId,
  sourceEventName: "Greenroom Demo Summit",
  createdAt: "2026-08-01T09:00:00.000Z",
  createdBy: "seed-organizer",
  slices: ["review", "cfp", "agenda", "publishing", "content-resources", "content-checklists"],
};

const identity = {
  templateId,
  templateName: template.name,
  versionId,
  version: 1,
  sourceEventId,
  sourceEventName: version.sourceEventName,
  eventId,
  destination: { startsOn: "2027-03-08", endsOn: "2027-03-10" },
};

const plan = {
  ...identity,
  slices: [
    {
      key: "cfp",
      label: "CFP form and routing",
      outcome: "copies" as const,
      reason: "Creates the destination's CFP draft.",
      copies: [{ id: "title", label: "Field: Proposal title" }],
      excludes: [],
      incompatible: [],
    },
  ],
};

/**
 * The envelope says the whole application succeeded and one category says it did not.
 *
 * That is not a contrived pairing: the word in the envelope is the server's summary, and the
 * lane that makes it report a refused category is changing what it may contain. The card is
 * asked to be right either way.
 */
const refusedInside = {
  ...identity,
  appliedAt: "2027-01-05T12:00:00.000Z",
  outcome: "applied" as const,
  slices: [
    {
      key: "cfp",
      label: "CFP form and routing",
      outcome: "applied" as const,
      reason: "Copied as a draft.",
      applied: [{ id: "title", label: "Field: Proposal title" }],
      incompatible: [],
    },
    {
      key: "review",
      label: "Triage statuses and scoring rubric",
      outcome: "incompatible" as const,
      reason:
        "Reviewers in the destination already hold assignments scored against other criteria.",
      applied: [],
      incompatible: [{ id: "rubric", label: "The scoring rubric" }],
    },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function stubTemplates(
  application: unknown,
  listed: EventTemplateDto = template,
  held: readonly EventTemplateVersionDto[] = [version],
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/template-application-previews")) return jsonResponse({ plan });
    if (url.endsWith("/template-applications")) return jsonResponse({ application });
    if (url.endsWith(`/event-templates/${templateId}`))
      return jsonResponse({ template: listed, versions: held });
    return jsonResponse({ templates: [listed] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderWorkspace = () =>
  render(
    <EventTemplatesWorkspace
      organizationId={organizationId}
      eventId={eventId}
      eventName="Greenroom Summit"
      canApply
      canAuthor
    />,
  );

/** Open the template, confirm a range, preview, and apply — the only path to the result card. */
async function applyTheClone() {
  fireEvent.click(await screen.findByRole("button", { name: "Annual summit starter" }));
  fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2027-03-08" } });
  fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2027-03-10" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview this clone" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Apply version 1 to Greenroom Summit" }),
  );
}

describe("event templates, in the organizer's words", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names a stored version's categories instead of listing slice keys", async () => {
    stubTemplates(refusedInside);
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "Annual summit starter" }));

    const versions = screen.getByRole("region", { name: "Annual summit starter" });
    expect(versions.textContent).toContain("carries 6 categories");
    expect(versions.textContent).toContain("Speaker task checklists");
    expect(versions.textContent).toContain("Triage statuses and scoring rubric");
    // The keys themselves are the defect: an organizer has never seen one of these.
    expect(versions.textContent).not.toContain("content-checklists");
    expect(versions.textContent).not.toContain("content-resources");
  });

  it("says the capture is stamped with an account rather than passing an id off as a name", async () => {
    stubTemplates(refusedInside);
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "Annual summit starter" }));

    expect(screen.getByRole("region", { name: "Annual summit starter" }).textContent).toContain(
      "by account seed-organizer",
    );
  });

  it("titles the result from the categories below it, not from the envelope", async () => {
    stubTemplates(refusedInside);
    renderWorkspace();
    await applyTheClone();

    // The envelope says "applied"; one category says "incompatible", so the card may not.
    const panel = await screen.findByRole("region", { name: "Applied in part" });
    expect(screen.queryByRole("region", { name: "Applied" })).toBeNull();
    const review = within(panel).getByText("Triage statuses and scoring rubric").closest("li");
    expect(review?.textContent).toContain("Incompatible");
    // The announcement counts the same way the card is titled, so the two cannot disagree.
    expect(
      await screen.findByText(/applied in part: 1 category written, 1 category not/),
    ).toBeInTheDocument();
  });

  it("still calls a clean application applied", async () => {
    stubTemplates({
      ...refusedInside,
      slices: [
        refusedInside.slices[0],
        {
          key: "publishing",
          label: "Public page details",
          outcome: "skipped" as const,
          reason: "This template carries no public page details.",
          applied: [],
          incompatible: [],
        },
      ],
    });
    renderWorkspace();
    await applyTheClone();

    // A skipped category is not a refusal — it is one the template carries nothing for.
    expect(await screen.findByRole("region", { name: "Applied" })).toBeInTheDocument();
  });
});
